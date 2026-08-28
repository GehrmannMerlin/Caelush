import { describe, expect, it } from "vitest";
import { createLLMCallId } from "@caelush/protocol";
import type { LLMStreamEvent } from "../src/index.js";
import { LLMStreamEventSchema } from "../src/index.js";

const callId = createLLMCallId();
const model = { provider: "local", model: "test-model" };

function summarize(event: LLMStreamEvent): string {
  switch (event.type) {
    case "stream.start":
      return event.payload.providerId;
    case "text.delta":
      return event.payload.text;
    case "tool_call.start":
      return event.payload.toolName;
    case "tool_call.delta":
      return event.payload.delta;
    case "tool_call.completed":
      return event.payload.name;
    case "usage":
      return String(event.payload.totalTokens ?? "unknown");
    case "stream.finish":
      return event.payload.finishReason;
  }
}

describe("LLM stream events", () => {
  it("parses exactly the normalized provider stream vocabulary", () => {
    const events = [
      { type: "stream.start", payload: { callId, providerId: "local", model } },
      { type: "text.delta", payload: { text: "hello" } },
      { type: "tool_call.start", payload: { toolCallId: "tool-call-1", toolName: "list_files" } },
      { type: "tool_call.delta", payload: { toolCallId: "tool-call-1", delta: '{"path":"."' } },
      {
        type: "tool_call.completed",
        payload: { id: "tool-call-1", name: "list_files", input: { path: "." } },
      },
      { type: "usage", payload: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } },
      {
        type: "stream.finish",
        payload: { finishReason: "TOOL_CALLS", finalUsage: { totalTokens: 10 } },
      },
    ] as const;

    for (const event of events) {
      expect(LLMStreamEventSchema.parse(event)).toEqual(event);
    }
    expect(summarize(LLMStreamEventSchema.parse(events[0]))).toBe("local");
    expect(summarize(LLMStreamEventSchema.parse(events[1]))).toBe("hello");
    expect(summarize(LLMStreamEventSchema.parse(events[4]))).toBe("list_files");
  });

  it("rejects control/data vocabulary outside the contract", () => {
    expect(
      LLMStreamEventSchema.safeParse({ type: "stream.error", payload: { error: "no" } }).success,
    ).toBe(false);
    expect(
      LLMStreamEventSchema.safeParse({ type: "reasoning.delta", payload: { text: "hidden" } })
        .success,
    ).toBe(false);
    expect(LLMStreamEventSchema.safeParse({ type: "tool_result", payload: {} }).success).toBe(
      false,
    );
    expect(
      LLMStreamEventSchema.safeParse({ type: "text.delta", payload: { text: "" } }).success,
    ).toBe(false);
    expect(
      LLMStreamEventSchema.safeParse({
        type: "tool_call.completed",
        payload: { id: "tool-call-1", name: "list_files", input: '{"path":"."}' },
      }).success,
    ).toBe(false);
    expect(
      LLMStreamEventSchema.safeParse({
        type: "stream.finish",
        payload: { finishReason: "STOP", usage: { totalTokens: 1 } },
      }).success,
    ).toBe(false);
  });
});
