import { describe, expect, it } from "vitest";
import { AIError } from "../src/errors/ai-error.js";
import { createLLMCallId } from "../src/ids/llm-call-id.js";
import { createAIModelTurnAssembler } from "../src/stream/turn-assembler.js";
import type { AIModelTurnAssembler } from "../src/stream/turn-assembler.js";
import type { AIInvocationResolution } from "../src/request/resolved-model-request.js";
import type { AIStreamEvent } from "../src/stream/events.js";

const RESOLUTION: AIInvocationResolution = {
  api: "test-api",
  reasoning: { requested: "LOW", effective: "LOW", mode: "EXACT", policy: "PREFER_BUDGET" },
  cache: { requested: "SHORT", effective: "SHORT", mode: "EXACT", key: "conv-1" },
  maxOutputTokens: 500,
};

function start(callId = createLLMCallId()): AIStreamEvent {
  return {
    type: "stream.start",
    payload: {
      callId,
      providerId: "test",
      model: { provider: "test", model: "model-a" },
      resolution: RESOLUTION,
    },
  };
}

function assemble(events: readonly AIStreamEvent[]): AIModelTurnAssembler {
  const assembler = createAIModelTurnAssembler();
  for (const event of events) assembler.accept(event);
  return assembler;
}

describe("AIModelTurnAssembler", () => {
  it("accumulates assistant text in arrival order", () => {
    const assembler = assemble([
      start(),
      { type: "text.delta", payload: { text: "Hel" } },
      { type: "text.delta", payload: { text: "lo " } },
      { type: "text.delta", payload: { text: "world" } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);

    expect(assembler.result().text).toBe("Hello world");
  });

  it("preserves identity, provider, model and resolution", () => {
    const callId = createLLMCallId();
    const assembler = assemble([
      start(callId),
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);

    const result = assembler.result();

    expect(result.callId).toBe(callId);
    expect(result.providerId).toBe("test");
    expect(result.model).toEqual({ provider: "test", model: "model-a" });
    expect(result.resolution).toEqual(RESOLUTION);
  });

  it("stores only completed tool calls", () => {
    const assembler = assemble([
      start(),
      { type: "tool_call.start", payload: { toolCallId: "c1", toolName: "read_file" } },
      { type: "tool_call.delta", payload: { toolCallId: "c1", delta: '{"path":"a.ts"}' } },
      {
        type: "tool_call.completed",
        payload: { id: "c1", name: "read_file", input: { path: "a.ts" } },
      },
      { type: "tool_call.start", payload: { toolCallId: "c2", toolName: "write_file" } },
      { type: "tool_call.delta", payload: { toolCallId: "c2", delta: '{"path"' } },
      { type: "tool_call.completed", payload: { id: "c2", name: "write_file", input: {} } },
      { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } },
    ]);

    expect(assembler.result().toolCalls).toEqual([
      { id: "c1", name: "read_file", input: { path: "a.ts" } },
      { id: "c2", name: "write_file", input: {} },
    ]);
  });

  it("uses the last usage snapshot, and finalUsage when present", () => {
    const lastOnly = assemble([
      start(),
      { type: "usage", payload: { inputTokens: 1 } },
      { type: "usage", payload: { inputTokens: 2 } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);
    expect(lastOnly.result().usage).toEqual({ inputTokens: 2 });

    const withFinal = assemble([
      start(),
      { type: "usage", payload: { inputTokens: 2 } },
      { type: "stream.finish", payload: { finishReason: "STOP", finalUsage: { inputTokens: 9 } } },
    ]);
    expect(withFinal.result().usage).toEqual({ inputTokens: 9 });

    const none = assemble([start(), { type: "stream.finish", payload: { finishReason: "STOP" } }]);
    expect(none.result()).not.toHaveProperty("usage");
  });

  it("preserves OTHER as a distinct finish reason", () => {
    const assembler = assemble([
      start(),
      { type: "stream.finish", payload: { finishReason: "OTHER" } },
    ]);

    expect(assembler.result().finishReason).toBe("OTHER");
    expect(assembler.result().finishReason).not.toBe("STOP");
  });

  it("keeps the provider finish reason out of the durable result", () => {
    const assembler = assemble([
      start(),
      {
        type: "stream.finish",
        payload: { finishReason: "STOP", providerReason: "stop_sequence_vendor_detail" },
      },
    ]);

    expect(assembler.result()).not.toHaveProperty("providerReason");
    expect(JSON.stringify(assembler.result())).not.toContain("stop_sequence_vendor_detail");
  });

  it("does not make a reasoning summary durable assistant text", () => {
    const assembler = assemble([
      start(),
      { type: "reasoning.summary.delta", payload: { text: "I should check the file" } },
      { type: "text.delta", payload: { text: "answer" } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ]);

    expect(assembler.result().text).toBe("answer");
    expect(JSON.stringify(assembler.result())).not.toContain("I should check the file");
  });

  it("refuses to produce a result for an errored stream", () => {
    const assembler = assemble([
      start(),
      { type: "text.delta", payload: { text: "partial" } },
      {
        type: "stream.error",
        payload: {
          error: {
            code: "AI_NETWORK",
            message: "connection reset",
            providerId: "test",
            retryable: true,
          },
        },
      },
    ]);

    try {
      assembler.result();
      expect.unreachable("an errored stream must not produce a result");
    } catch (error) {
      expect(error).toBeInstanceOf(AIError);
      expect((error as AIError).code).toBe("AI_NETWORK");
      expect((error as AIError).message).toBe("connection reset");
      expect((error as AIError).retryable).toBe(true);
      expect((error as AIError).providerId).toBe("test");
    }
  });

  it("refuses to produce a result for an unfinished stream", () => {
    for (const events of [[start()], [start(), { type: "text.delta", payload: { text: "x" } }]]) {
      const assembler = assemble(events as AIStreamEvent[]);
      try {
        assembler.result();
        expect.unreachable("an unfinished stream must not produce a result");
      } catch (error) {
        expect(error).toBeInstanceOf(AIError);
        expect((error as AIError).code).toBe("AI_INVALID_RESPONSE");
      }
    }
  });

  it("refuses to produce a result before stream.start", () => {
    const assembler = createAIModelTurnAssembler();

    expect(() => assembler.result()).toThrow(AIError);
  });
});
