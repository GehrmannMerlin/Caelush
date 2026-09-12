import { toProtocolJsonObject } from "./legacy-json.js";
import type { AIAdapterEvent, ModelUsage } from "@caelush/ai";
import type { LLMCallId, ModelRef } from "@caelush/protocol";
import type { FinishReason, LLMToolCall } from "../tool-call.js";
import type { LLMStreamEvent } from "../events.js";
import type { LLMUsage } from "../usage.js";

/**
 * Project one AI adapter event back onto the legacy stream contract.
 *
 * The legacy provider contract still owns the envelope: the legacy gateway validates
 * `stream.start` and `stream.finish` on the provider stream, so the compatibility
 * facade rebuilds them from the gateway-owned call identity. The AI adapter itself
 * never emits an envelope event.
 *
 * A reasoning summary is deliberately dropped. Phase 2A exposed reasoning as an
 * explicitly display-only stream event, and the legacy stream union has no member
 * for it; folding it into `text.delta` would corrupt assistant content with
 * chain-of-thought, so it is discarded instead.
 */
export function* toLegacyStreamEvents(event: AIAdapterEvent): Generator<LLMStreamEvent> {
  switch (event.type) {
    case "text.delta":
      if (event.payload.text.length === 0) return;
      yield { type: "text.delta", payload: { text: event.payload.text } };
      return;

    case "tool_call.start":
      yield {
        type: "tool_call.start",
        payload: {
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName as LLMToolCall["name"],
        },
      };
      return;

    case "tool_call.delta":
      yield { type: "tool_call.delta", payload: { ...event.payload } };
      return;

    case "tool_call.completed":
      yield { type: "tool_call.completed", payload: toLegacyToolCall(event.payload) };
      return;

    case "usage":
      yield { type: "usage", payload: toLegacyUsage(event.payload) };
      return;

    case "adapter.finish":
      yield {
        type: "stream.finish",
        payload: {
          finishReason: event.payload.finishReason as FinishReason,
          ...(event.payload.finalUsage === undefined
            ? {}
            : { finalUsage: toLegacyUsage(event.payload.finalUsage) }),
        },
      };
      return;

    case "reasoning.summary.delta":
      return;

    default:
      return;
  }
}

/** The legacy `stream.start` envelope for one provider turn. */
export function toLegacyStreamStart(context: {
  readonly callId: LLMCallId;
  readonly providerId: string;
  readonly model: ModelRef;
}): LLMStreamEvent {
  return {
    type: "stream.start",
    payload: {
      callId: context.callId,
      providerId: context.providerId,
      model: context.model,
    },
  };
}

function toLegacyToolCall(call: {
  readonly id: string;
  readonly name: string;
  readonly input: Parameters<typeof toProtocolJsonObject>[0];
}): LLMToolCall {
  return {
    id: call.id,
    name: call.name as LLMToolCall["name"],
    input: toProtocolJsonObject(call.input),
  };
}

function toLegacyUsage(usage: ModelUsage): LLMUsage {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
}
