import type { AIFinishReason, AIToolCall } from "../tools/tool-call.js";
import type { AIInvocationResolution } from "../request/resolved-model-request.js";
import type { AISerializableError } from "../errors/serializable-error.js";
import type { LLMCallId } from "../ids/llm-call-id.js";
import type { ModelRef } from "../models/model-ref.js";
import type { ModelUsage } from "../models/model-usage.js";
import type { ProviderId } from "../ids/provider-id.js";

/**
 * The public AI stream contract.
 *
 * Only the gateway produces these events, and the gateway alone owns the three
 * envelope events: `stream.start`, `stream.finish` and `stream.error`. An adapter
 * cannot emit them because its own event union has no such variants.
 *
 * The lifecycle is frozen:
 *
 * ```text
 * success           stream.start → 0..N events → stream.finish
 * runtime failure   stream.start → 0..N events → stream.error
 * preflight failure throw AIError, no stream at all
 * ```
 */

/** First event of every stream. Carries the gateway-owned call identity. */
export interface AIStreamStartEvent {
  readonly type: "stream.start";
  readonly payload: {
    readonly callId: LLMCallId;
    readonly providerId: ProviderId;
    readonly model: ModelRef;
    readonly resolution: AIInvocationResolution;
  };
}

/** Assistant text. */
export interface AITextDeltaEvent {
  readonly type: "text.delta";
  readonly payload: { readonly text: string };
}

/**
 * A public reasoning *summary*.
 *
 * Raw model chain-of-thought must never enter a public contract; only a summary
 * a provider explicitly produced for display may travel here, and it is not
 * durable assistant content.
 */
export interface AIReasoningSummaryDeltaEvent {
  readonly type: "reasoning.summary.delta";
  readonly payload: { readonly text: string };
}

/** A tool call has been announced. */
export interface AIToolCallStartEvent {
  readonly type: "tool_call.start";
  readonly payload: { readonly toolCallId: string; readonly toolName: string };
}

/** Argument text for an announced tool call. */
export interface AIToolCallDeltaEvent {
  readonly type: "tool_call.delta";
  readonly payload: { readonly toolCallId: string; readonly delta: string };
}

/** A tool call finished parsing and validating. */
export interface AIToolCallCompletedEvent {
  readonly type: "tool_call.completed";
  readonly payload: AIToolCall;
}

/** A usage snapshot. A later snapshot supersedes an earlier one. */
export interface AIUsageEvent {
  readonly type: "usage";
  readonly payload: ModelUsage;
}

/** Terminal success event. */
export interface AIStreamFinishEvent {
  readonly type: "stream.finish";
  readonly payload: {
    readonly finishReason: AIFinishReason;
    readonly finalUsage?: ModelUsage;
    readonly providerReason?: string;
  };
}

/** Terminal failure event. Always carries a sanitized error, never a raw one. */
export interface AIStreamErrorEvent {
  readonly type: "stream.error";
  readonly payload: { readonly error: AISerializableError };
}

/** Any public AI stream event. */
export type AIStreamEvent =
  | AIStreamStartEvent
  | AITextDeltaEvent
  | AIReasoningSummaryDeltaEvent
  | AIToolCallStartEvent
  | AIToolCallDeltaEvent
  | AIToolCallCompletedEvent
  | AIUsageEvent
  | AIStreamFinishEvent
  | AIStreamErrorEvent;

/** Every public stream event type, in canonical lifecycle order. */
export const AI_STREAM_EVENT_TYPES = [
  "stream.start",
  "text.delta",
  "reasoning.summary.delta",
  "tool_call.start",
  "tool_call.delta",
  "tool_call.completed",
  "usage",
  "stream.finish",
  "stream.error",
] as const satisfies readonly AIStreamEvent["type"][];

/** True when the event terminates the stream. */
export function isTerminalStreamEvent(event: AIStreamEvent): boolean {
  return event.type === "stream.finish" || event.type === "stream.error";
}
