import { describe, expect, it } from "vitest";
import {
  assertRawToolCallIdentity,
  createRawStreamState,
  observeRawFinishReason,
} from "../../../src/adapters/openai-compatible/raw-tool-state.js";

/** One raw OpenAI-shaped chunk with a tool-call delta. */
function rawChunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function toolDelta(input: Record<string, unknown>): Record<string, unknown> {
  return { tool_calls: [{ type: "function", function: {}, ...input }] };
}

describe("raw tool-call identity protection", () => {
  it("ignores payloads that are not OpenAI-shaped chunks", () => {
    const state = createRawStreamState();

    for (const value of [
      undefined,
      null,
      1,
      "text",
      {},
      { choices: "no" },
      { choices: [] },
      { choices: [null] },
    ]) {
      expect(() => {
        assertRawToolCallIdentity(value, state);
      }).not.toThrow();
    }
  });

  it("accepts a delta that carries a stable id", () => {
    const state = createRawStreamState();

    expect(() => {
      assertRawToolCallIdentity(rawChunk(toolDelta({ id: "call-a" })), state);
      assertRawToolCallIdentity(rawChunk(toolDelta({ id: "call-a", arguments: '{"a"' })), state);
    }).not.toThrow();
  });

  it("accepts a delta that carries only an index while one call is known", () => {
    const state = createRawStreamState();

    expect(() => {
      assertRawToolCallIdentity(rawChunk(toolDelta({ index: 0, id: "call-a" })), state);
      assertRawToolCallIdentity(rawChunk(toolDelta({ arguments: '"x"}' })), state);
    }).not.toThrow();
  });

  it("fails closed for a delta with neither id nor index once several calls are open", () => {
    const state = createRawStreamState();

    assertRawToolCallIdentity(rawChunk(toolDelta({ id: "call-a", index: 0 })), state);
    assertRawToolCallIdentity(rawChunk(toolDelta({ id: "call-b", index: 1 })), state);

    expect(() => {
      assertRawToolCallIdentity(rawChunk(toolDelta({ arguments: '"x"}' })), state);
    }).toThrow();
  });

  it("fails closed for a whitespace-only tool-call id", () => {
    const state = createRawStreamState();

    expect(() => {
      assertRawToolCallIdentity(rawChunk(toolDelta({ id: "   " })), state);
    }).toThrow();
  });

  it("ignores a non-integer index", () => {
    const state = createRawStreamState();

    expect(() => {
      assertRawToolCallIdentity(rawChunk(toolDelta({ index: 1.5 })), state);
      assertRawToolCallIdentity(rawChunk(toolDelta({ index: 0, id: "call-a" })), state);
      assertRawToolCallIdentity(rawChunk(toolDelta({ arguments: "{}" })), state);
    }).not.toThrow();
  });
});

describe("raw native finish reason observation", () => {
  it("captures the provider-native finish reason", () => {
    const state = createRawStreamState();

    observeRawFinishReason(rawChunk({}, "insufficient_system_resource"), state);

    expect(state.nativeFinishReason()).toBe("insufficient_system_resource");
  });

  it("keeps the last non-null native reason", () => {
    const state = createRawStreamState();

    observeRawFinishReason(rawChunk({}, null), state);
    expect(state.nativeFinishReason()).toBeUndefined();

    observeRawFinishReason(rawChunk({}, "stop"), state);
    observeRawFinishReason(rawChunk({}, null), state);
    expect(state.nativeFinishReason()).toBe("stop");
  });

  it("ignores non-chunk payloads", () => {
    const state = createRawStreamState();

    observeRawFinishReason(undefined, state);
    observeRawFinishReason({ choices: [{ delta: {} }] }, state);

    expect(state.nativeFinishReason()).toBeUndefined();
  });
});
