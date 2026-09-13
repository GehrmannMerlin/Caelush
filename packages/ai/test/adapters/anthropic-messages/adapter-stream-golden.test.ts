import { describe, expect, it } from "vitest";
import { captureTurn } from "./support/harness.js";
import { mapAnthropicFinishReason } from "../../../src/adapters/anthropic-messages/finish-reason.js";
import {
  blockStop,
  capturingTransport,
  errorEvent,
  inputJsonDelta,
  messageDelta,
  messageStart,
  messageStop,
  ping,
  rawSseResponse,
  signatureDelta,
  sseBody,
  textBlockStart,
  textDelta,
  textTurnEvents,
  thinkingBlockStart,
  thinkingDelta,
  toolBlockStart,
  toolTurnEvents,
  turnTransport,
} from "../../support/anthropic-messages-transport.js";
import { modelDescriptor } from "../../support/fixtures.js";
import type { AIModelRequest } from "../../../src/request/model-request.js";
import type { AIStreamEvent } from "../../../src/stream/events.js";
import type { ModelDescriptor } from "../../../src/models/model-descriptor.js";

const THINKING_METADATA = {
  anthropicMessages: {
    thinking: {
      supported: true,
      defaultEnabled: false,
      disableSupported: true,
      display: "summarized",
      budgetTokensByLevel: { LOW: 2_048, HIGH: 16_384 },
      effortByLevel: { LOW: "low", HIGH: "high" },
    },
  },
};

const thinkingDescriptor: ModelDescriptor = modelDescriptor({
  ref: { provider: "anthropic-fixture", model: "fixture-model" },
  api: "anthropic-messages",
  reasoning: {
    supportedLevels: ["OFF", "LOW", "HIGH"],
    supportsSummary: "SUPPORTED",
  },
  adapterMetadata: THINKING_METADATA,
});

function request(overrides: Partial<AIModelRequest> = {}): AIModelRequest {
  return {
    model: { provider: "anthropic-fixture", model: "fixture-model" },
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as AIModelRequest;
}

/** Every public event type in order. */
function types(events: readonly AIStreamEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

/** Every event payload of one type, in order. */
function payloads(events: readonly AIStreamEvent[], type: string): readonly unknown[] {
  return events.filter((event) => event.type === type).map((event) => event.payload);
}

describe("Anthropic Messages stream golden: text", () => {
  it("streams text and finishes through the gateway envelope", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport(textTurnEvents("hello world")),
    });

    expect(types(turn.events)).toEqual([
      "stream.start",
      "usage",
      "text.delta",
      "usage",
      "stream.finish",
    ]);
    expect(turn.events[2]?.payload).toEqual({ text: "hello world" });
    expect(turn.events.at(-1)?.payload).toMatchObject({ finishReason: "STOP" });
  });

  it("assembles the complete turn through gateway.complete", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport(textTurnEvents("assembled")),
    });

    expect(turn.events.at(-1)?.payload).toMatchObject({ finishReason: "STOP" });
    expect(turn.transportAttempts).toBe(1);
  });

  it("keeps several text deltas in arrival order", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "a"),
        textDelta(0, "b"),
        textDelta(0, "c"),
        blockStop(0),
        messageDelta("end_turn"),
        messageStop(),
      ]),
    });

    expect(payloads(turn.events, "text.delta")).toEqual([
      { text: "a" },
      { text: "b" },
      { text: "c" },
    ]);
  });

  it("never emits a gateway envelope event from the adapter", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport(textTurnEvents("x")),
    });

    for (const type of ["stream.start", "stream.finish", "stream.error"]) {
      const count = turn.events.filter((event) => event.type === type).length;
      // Exactly one envelope event per stream, and only the gateway produces it.
      expect(count).toBeLessThanOrEqual(1);
    }
  });
});

describe("Anthropic Messages stream golden: usage", () => {
  it("emits one usage event per distinct native snapshot", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart({ input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 2 }),
        textBlockStart(0),
        textDelta(0, "hi"),
        blockStop(0),
        messageDelta("end_turn", { output_tokens: 3 }),
        messageStop(),
      ]),
    });

    const usage = payloads(turn.events, "usage");
    expect(usage).toEqual([
      { inputTokens: 7, outputTokens: 0, totalTokens: 7, cachedInputTokens: 2 },
      { inputTokens: 7, outputTokens: 3, totalTokens: 10, cachedInputTokens: 2 },
    ]);
  });

  it("makes finalUsage the last complete snapshot, never a sum of snapshots", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart({ input_tokens: 11, output_tokens: 0 }),
        textBlockStart(0),
        textDelta(0, "hi"),
        blockStop(0),
        messageDelta("end_turn", { output_tokens: 5 }),
        messageStop(),
      ]),
    });

    expect(turn.events.at(-1)?.payload).toMatchObject({
      finalUsage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
    });
  });

  it("maps an explicit native thinking-token counter onto reasoningTokens", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart({ input_tokens: 7, output_tokens: 0 }),
        textBlockStart(0),
        textDelta(0, "hi"),
        blockStop(0),
        messageDelta("end_turn", {
          output_tokens: 3,
          output_tokens_details: { thinking_tokens: 1 },
        }),
        messageStop(),
      ]),
    });

    expect(turn.events.at(-1)?.payload).toMatchObject({
      finalUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, reasoningTokens: 1 },
    });
  });

  it("omits reasoningTokens when the provider reports no thinking counter", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport(textTurnEvents("x")),
    });

    const finish = turn.events.at(-1)?.payload as { finalUsage?: Record<string, unknown> };
    expect(finish.finalUsage).not.toHaveProperty("reasoningTokens");
  });

  it("never adds a cache read to the total", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart({ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 100 }),
        textBlockStart(0),
        textDelta(0, "hi"),
        blockStop(0),
        messageDelta("end_turn", { output_tokens: 2 }),
        messageStop(),
      ]),
    });

    const finish = turn.events.at(-1)?.payload as { finalUsage: Record<string, number> };
    expect(finish.finalUsage["totalTokens"]).toBe(12);
    expect(finish.finalUsage["cachedInputTokens"]).toBe(100);
  });

  it("disables a later empty usage snapshot", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart({ input_tokens: 1, output_tokens: 1 }),
        textBlockStart(0),
        textDelta(0, "hi"),
        blockStop(0),
        messageDelta("end_turn", {}),
        messageStop(),
      ]),
    });

    // The `message_delta` snapshot restates the same counters, so it must not be
    // published twice.
    expect(payloads(turn.events, "usage")).toHaveLength(1);
  });
});

describe("Anthropic Messages stream golden: tools", () => {
  it("emits a complete single tool lifecycle", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport(toolTurnEvents()),
    });

    expect(types(turn.events)).toEqual([
      "stream.start",
      "usage",
      "tool_call.start",
      "tool_call.delta",
      "tool_call.delta",
      "tool_call.completed",
      "usage",
      "stream.finish",
    ]);
    expect(payloads(turn.events, "tool_call.start")).toEqual([
      { toolCallId: "toolu_a", toolName: "read_file" },
    ]);
    expect(payloads(turn.events, "tool_call.completed")).toEqual([
      { id: "toolu_a", name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(turn.events.at(-1)?.payload).toMatchObject({ finishReason: "TOOL_CALLS" });
  });

  it("takes the tool call id from the native tool_use id and never invents one", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport(toolTurnEvents("toolu_native_7", "read_file")),
    });

    expect(payloads(turn.events, "tool_call.start")).toEqual([
      { toolCallId: "toolu_native_7", toolName: "read_file" },
    ]);
  });

  it("keeps parallel tool blocks separate by content block index", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        toolBlockStart(0, "toolu_a", "read_file"),
        toolBlockStart(1, "toolu_b", "search_text"),
        inputJsonDelta(0, '{"path":'),
        inputJsonDelta(1, '{"query":'),
        inputJsonDelta(0, '"a.ts"}'),
        inputJsonDelta(1, '"b"}'),
        blockStop(0),
        blockStop(1),
        messageDelta("tool_use"),
        messageStop(),
      ]),
    });

    expect(payloads(turn.events, "tool_call.delta")).toEqual([
      { toolCallId: "toolu_a", delta: '{"path":' },
      { toolCallId: "toolu_b", delta: '{"query":' },
      { toolCallId: "toolu_a", delta: '"a.ts"}' },
      { toolCallId: "toolu_b", delta: '"b"}' },
    ]);
    expect(payloads(turn.events, "tool_call.completed")).toEqual([
      { id: "toolu_a", name: "read_file", input: { path: "a.ts" } },
      { id: "toolu_b", name: "search_text", input: { query: "b" } },
    ]);
  });

  it("reads an empty accumulated input as an empty object", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        toolBlockStart(0, "toolu_a", "read_file"),
        blockStop(0),
        messageDelta("tool_use"),
        messageStop(),
      ]),
    });

    expect(payloads(turn.events, "tool_call.completed")).toEqual([
      { id: "toolu_a", name: "read_file", input: {} },
    ]);
  });

  it.each([
    ["malformed JSON", '{"path":'],
    ["an array", "[1,2]"],
    ["a primitive", '"text"'],
    ["null", "null"],
    ["a number", "7"],
  ])("fails as AI_INVALID_RESPONSE when tool input is %s", async (_name, fragment) => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        toolBlockStart(0, "toolu_a", "read_file"),
        inputJsonDelta(0, fragment),
        blockStop(0),
        messageDelta("tool_use"),
        messageStop(),
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
    expect(turn.streamError?.retryable).toBe(false);
  });

  it("never emits tool_call.completed for a malformed tool input", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        toolBlockStart(0, "toolu_a", "read_file"),
        inputJsonDelta(0, "{"),
        blockStop(0),
        messageDelta("tool_use"),
        messageStop(),
      ]),
    });

    expect(payloads(turn.events, "tool_call.completed")).toEqual([]);
  });

  it("fails closed on a tool name the core cannot route", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        toolBlockStart(0, "toolu_a", "Read-File"),
        blockStop(0),
        messageDelta("tool_use"),
        messageStop(),
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed on a duplicate content block index", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        toolBlockStart(0, "toolu_a", "read_file"),
        toolBlockStart(0, "toolu_b", "search_text"),
        blockStop(0),
        messageDelta("tool_use"),
        messageStop(),
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed when the stream stops with an open tool block", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        toolBlockStart(0, "toolu_a", "read_file"),
        inputJsonDelta(0, '{"path":"a.ts"}'),
        messageDelta("tool_use"),
        messageStop(),
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });
});

describe("Anthropic Messages stream golden: finish reasons", () => {
  it.each([
    ["end_turn", "STOP"],
    ["stop_sequence", "STOP"],
    ["tool_use", "TOOL_CALLS"],
    ["max_tokens", "LENGTH"],
    ["model_context_window_exceeded", "LENGTH"],
    ["refusal", "CONTENT_FILTER"],
    ["pause_turn", "OTHER"],
    ["some_future_reason", "OTHER"],
  ] as const)("maps %s to %s", async (reason, expected) => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "x"),
        blockStop(0),
        messageDelta(reason),
        messageStop(),
      ]),
    });

    expect(turn.events.at(-1)?.payload).toMatchObject({ finishReason: expected });
  });

  it("preserves providerReason for pause_turn instead of reporting STOP", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "x"),
        blockStop(0),
        messageDelta("pause_turn"),
        messageStop(),
      ]),
    });

    expect(turn.events.at(-1)?.payload).toMatchObject({
      finishReason: "OTHER",
      providerReason: "pause_turn",
    });
  });

  it("preserves providerReason for an unknown stop reason", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "x"),
        blockStop(0),
        messageDelta("brand_new_reason"),
        messageStop(),
      ]),
    });

    expect(turn.events.at(-1)?.payload).toMatchObject({
      finishReason: "OTHER",
      providerReason: "brand_new_reason",
    });
  });

  it("omits providerReason for a mapped reason", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport(textTurnEvents("x")),
    });

    expect(turn.events.at(-1)?.payload).not.toHaveProperty("providerReason");
  });

  it("covers every frozen finish reason", () => {
    expect(
      [
        "end_turn",
        "stop_sequence",
        "tool_use",
        "max_tokens",
        "model_context_window_exceeded",
        "refusal",
        "pause_turn",
        "unknown",
      ].map(mapAnthropicFinishReason),
    ).toEqual([
      "STOP",
      "STOP",
      "TOOL_CALLS",
      "LENGTH",
      "LENGTH",
      "CONTENT_FILTER",
      "OTHER",
      "OTHER",
    ]);
  });

  it("never reports a missing stop reason as STOP", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "x"),
        blockStop(0),
        messageStop(),
      ]),
    });

    expect(turn.events.at(-1)?.payload).toMatchObject({ finishReason: "OTHER" });
  });
});

describe("Anthropic Messages stream golden: thinking", () => {
  it("projects a summarized thinking delta onto reasoning.summary.delta", async () => {
    const turn = await captureTurn(request({ settings: { reasoning: { level: "HIGH" } } }), {
      descriptor: thinkingDescriptor,
      transport: turnTransport([
        messageStart(),
        thinkingBlockStart(0),
        thinkingDelta(0, "considering "),
        thinkingDelta(0, "options"),
        signatureDelta(0, "opaque-signature-bytes"),
        blockStop(0),
        textBlockStart(1),
        textDelta(1, "answer"),
        blockStop(1),
        messageDelta("end_turn"),
        messageStop(),
      ]),
    });

    expect(payloads(turn.events, "reasoning.summary.delta")).toEqual([
      { text: "considering " },
      { text: "options" },
    ]);
    expect(payloads(turn.events, "text.delta")).toEqual([{ text: "answer" }]);
  });

  it("never publishes thinking text when the native display is omitted", async () => {
    const turn = await captureTurn(request({ settings: { reasoning: { level: "HIGH" } } }), {
      descriptor: modelDescriptor({
        ref: { provider: "anthropic-fixture", model: "fixture-model" },
        api: "anthropic-messages",
        reasoning: {
          supportedLevels: ["OFF", "LOW", "HIGH"],
          supportsSummary: "SUPPORTED",
        },
        adapterMetadata: {
          anthropicMessages: {
            thinking: {
              supported: true,
              defaultEnabled: false,
              disableSupported: true,
              display: "omitted",
              budgetTokensByLevel: { HIGH: 16_384 },
              effortByLevel: { HIGH: "high" },
            },
          },
        },
      }),
      transport: turnTransport([
        messageStart(),
        thinkingBlockStart(0),
        thinkingDelta(0, "hidden chain of thought"),
        signatureDelta(0, "opaque"),
        blockStop(0),
        textBlockStart(1),
        textDelta(1, "answer"),
        blockStop(1),
        messageDelta("end_turn"),
        messageStop(),
      ]),
    });

    expect(payloads(turn.events, "reasoning.summary.delta")).toEqual([]);
    expect(JSON.stringify(turn.events)).not.toContain("hidden chain of thought");
  });

  it("never publishes a signature or a redacted thinking block", async () => {
    const turn = await captureTurn(request({ settings: { reasoning: { level: "HIGH" } } }), {
      descriptor: thinkingDescriptor,
      transport: turnTransport([
        messageStart(),
        thinkingBlockStart(0),
        thinkingDelta(0, "summary"),
        signatureDelta(0, "opaque-signature-bytes"),
        blockStop(0),
        textBlockStart(1),
        textDelta(1, "answer"),
        blockStop(1),
        messageDelta("end_turn"),
        messageStop(),
      ]),
    });

    const serialized = JSON.stringify(turn.events);
    expect(serialized).not.toContain("opaque-signature-bytes");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("redacted_thinking");
  });

  it("absorbs a redacted_thinking block without publishing it", async () => {
    const turn = await captureTurn(request({ settings: { reasoning: { level: "HIGH" } } }), {
      descriptor: thinkingDescriptor,
      transport: turnTransport([
        messageStart(),
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "redacted_thinking", data: "encrypted-blob" },
          },
        },
        signatureDelta(0, "encrypted-blob-signature"),
        blockStop(0),
        textBlockStart(1),
        textDelta(1, "answer"),
        blockStop(1),
        messageDelta("end_turn"),
        messageStop(),
      ]),
    });

    expect(turn.streamError).toBeUndefined();
    expect(JSON.stringify(turn.events)).not.toContain("encrypted-blob");
  });

  it("keeps a reasoning summary out of the assembled turn text", async () => {
    const transport = turnTransport([
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "internal summary"),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, "public answer"),
      blockStop(1),
      messageDelta("end_turn"),
      messageStop(),
    ]);

    const turn = await captureTurn(request({ settings: { reasoning: { level: "HIGH" } } }), {
      descriptor: thinkingDescriptor,
      transport,
    });

    const text = payloads(turn.events, "text.delta");
    expect(text).toEqual([{ text: "public answer" }]);
  });
});

describe("Anthropic Messages stream golden: transport-level events", () => {
  it("ignores ping without producing a public event", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        ping(),
        textBlockStart(0),
        textDelta(0, "x"),
        ping(),
        blockStop(0),
        messageDelta("end_turn"),
        ping(),
        messageStop(),
      ]),
    });

    expect(types(turn.events)).toEqual([
      "stream.start",
      "usage",
      "text.delta",
      "usage",
      "stream.finish",
    ]);
  });

  it("emits exactly one adapter.finish, at message_stop", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport(textTurnEvents("x")),
    });

    expect(turn.events.filter((event) => event.type === "stream.finish")).toHaveLength(1);
    expect(turn.events.at(-1)?.type).toBe("stream.finish");
  });

  it("does not finish when message_delta arrives without message_stop", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "x"),
        blockStop(0),
        messageDelta("end_turn"),
      ]),
    });

    expect(turn.events.some((event) => event.type === "stream.finish")).toBe(false);
    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed when the native stream stops twice", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "x"),
        blockStop(0),
        messageDelta("end_turn"),
        messageStop(),
        messageStop(),
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });
});

describe("Anthropic Messages stream golden: failures", () => {
  it("normalizes a mid-stream error event and reports no stream.error itself", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        textBlockStart(0),
        textDelta(0, "partial"),
        errorEvent("overloaded_error", "Overloaded"),
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_RATE_LIMIT");
    expect(turn.streamError?.retryable).toBe(true);
    // The gateway owns the envelope, and it produced exactly one.
    expect(turn.events.filter((event) => event.type === "stream.error")).toHaveLength(1);
  });

  it("maps a mid-stream authentication error", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([messageStart(), errorEvent("authentication_error")]),
    });

    expect(turn.streamError?.code).toBe("AI_AUTHENTICATION");
    expect(turn.streamError?.retryable).toBe(false);
  });

  it("fails closed on a malformed data payload", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(
        () =>
          new Response("event: message_start\ndata: {not json}\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed on an unknown semantic event", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        { event: "message_future_extension", data: { type: "message_future_extension" } },
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
    expect(turn.streamError?.retryable).toBe(false);
  });

  it("never reads an unknown event as text", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        { event: "text", data: { type: "text", text: "smuggled" } },
      ]),
    });

    expect(payloads(turn.events, "text.delta")).toEqual([]);
    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed when the body ends without message_stop", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() => rawSseResponse(sseBody([messageStart()]))),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed on an empty response body", async () => {
    const turn = await captureTurn(request(), {
      transport: capturingTransport(() => new Response(null, { status: 200 })),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed on a delta for an unopened block", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([messageStart(), textDelta(3, "x")]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed on a delta whose kind contradicts its block", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([messageStart(), textBlockStart(0), inputJsonDelta(0, "{}")]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed on an unknown content block type", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        {
          event: "content_block_start",
          data: { type: "content_block_start", index: 0, content_block: { type: "video" } },
        },
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed on an unknown block delta type", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        textBlockStart(0),
        {
          event: "content_block_delta",
          data: { type: "content_block_delta", index: 0, delta: { type: "future_delta" } },
        },
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed on a missing content block index", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        {
          event: "content_block_delta",
          data: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
        },
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("fails closed on a malformed content block start", async () => {
    const turn = await captureTurn(request(), {
      transport: turnTransport([
        messageStart(),
        { event: "content_block_start", data: { type: "content_block_start", index: 0 } },
      ]),
    });

    expect(turn.streamError?.code).toBe("AI_INVALID_RESPONSE");
  });

  it("makes exactly one transport attempt for every failure", async () => {
    for (const events of [
      [messageStart(), errorEvent("api_error")],
      [messageStart(), textDelta(9, "x")],
      [messageStart()],
    ]) {
      const turn = await captureTurn(request(), { transport: turnTransport(events) });
      expect(turn.transportAttempts).toBe(1);
    }
  });
});

describe("Anthropic Messages stream golden: chunk boundaries", () => {
  it("reassembles an event split across two network chunks", async () => {
    const body = Buffer.from(sseBody(textTurnEvents("split text")), "utf8");
    const split = Math.floor(body.length / 2);

    const turn = await captureTurn(request(), {
      transport: capturingTransport(() => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(body.subarray(0, split)));
            controller.enqueue(new Uint8Array(body.subarray(split)));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    });

    expect(payloads(turn.events, "text.delta")).toEqual([{ text: "split text" }]);
    expect(turn.events.at(-1)?.payload).toMatchObject({ finishReason: "STOP" });
  });

  it("reassembles a multi-byte character split across two network chunks", async () => {
    const body = Buffer.from(sseBody(textTurnEvents("héllo ☃")), "utf8");
    const snowman = body.indexOf(Buffer.from("☃", "utf8"));
    const split = snowman + 1;

    const turn = await captureTurn(request(), {
      transport: capturingTransport(() => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(body.subarray(0, split)));
            controller.enqueue(new Uint8Array(body.subarray(split)));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    });

    expect(payloads(turn.events, "text.delta")).toEqual([{ text: "héllo ☃" }]);
  });

  it("handles a stream delivered one byte at a time", async () => {
    const body = Buffer.from(sseBody(textTurnEvents("byte wise")), "utf8");

    const turn = await captureTurn(request(), {
      transport: capturingTransport(() => {
        let offset = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= body.length) {
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(body.subarray(offset, offset + 1)));
            offset += 1;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    });

    expect(payloads(turn.events, "text.delta")).toEqual([{ text: "byte wise" }]);
  });

  it("parses a CRLF stream", async () => {
    const body = sseBody(textTurnEvents("crlf text")).replaceAll("\n\n", "\r\n\r\n");

    const turn = await captureTurn(request(), {
      transport: capturingTransport(() => rawSseResponse(body)),
    });

    expect(payloads(turn.events, "text.delta")).toEqual([{ text: "crlf text" }]);
  });
});
