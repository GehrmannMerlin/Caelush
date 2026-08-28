import * as llm from "@caelush/llm";
import type { LLMStreamEvent } from "@caelush/llm";
import { describe, expect, it } from "vitest";

const api = llm as Record<string, unknown>;
const requiredRuntimeExports = [
  "LLMAssistantContentSchema",
  "LLMAssistantMessageSchema",
  "LLMMessageSchema",
  "LLMSystemMessageSchema",
  "LLMToolResultMessageSchema",
  "LLMUserMessageSchema",
  "LLMRequestSchema",
  "LLMToolChoiceSchema",
  "CapabilitySupportSchema",
  "LLMCapabilitiesSchema",
  "LLMUsageSchema",
  "FinishReasonSchema",
  "LLMToolCallSchema",
  "LLMTurnResultSchema",
  "LLMStreamEventSchema",
  "LLMError",
  "LLMProviderNotFoundError",
  "LLMModelUnsupportedError",
  "LLMCapabilityUnsupportedError",
  "LLMAuthenticationError",
  "LLMRateLimitError",
  "LLMNetworkError",
  "LLMTimeoutError",
  "LLMAbortedError",
  "LLMInvalidResponseError",
  "LLMProviderError",
  "ProviderIdSchema",
  "LLMProviderRegistry",
] as const;

function eventSummary(event: LLMStreamEvent): string {
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

describe("LLM public API", () => {
  it("exports contracts and runtime classes from the package root", () => {
    for (const exportName of requiredRuntimeExports) {
      expect(api[exportName], exportName).toBeDefined();
    }
    expect(api.FakeLLMProvider).toBeUndefined();
  });

  it("keeps stream event narrowing available to package consumers", () => {
    const event = {
      type: "text.delta",
      payload: { text: "hello" },
    } satisfies LLMStreamEvent;
    expect(eventSummary(event)).toBe("hello");
  });
});
