import type { AIFinishReason, AIToolCall } from "../tools/tool-call.js";
import type { ModelUsage } from "../models/model-usage.js";

/**
 * What an API adapter may emit.
 *
 * The union deliberately has **no** envelope variants: an adapter cannot produce
 * `stream.start`, `stream.finish` or `stream.error`, because those types do not
 * exist here. Envelope authority belongs to the gateway alone, and the type
 * system is what enforces it.
 *
 * Tool calls travel as a lifecycle: `tool_call.start` names the call,
 * `tool_call.delta` streams its argument text, and `tool_call.completed` carries
 * the parsed, validated call. An adapter must never synthesise identity, merge two
 * ids, or guess which call an ambiguous delta belongs to.
 */
export type AIAdapterEvent =
  | { readonly type: "text.delta"; readonly payload: { readonly text: string } }
  | { readonly type: "reasoning.summary.delta"; readonly payload: { readonly text: string } }
  | {
      readonly type: "tool_call.start";
      readonly payload: { readonly toolCallId: string; readonly toolName: string };
    }
  | {
      readonly type: "tool_call.delta";
      readonly payload: { readonly toolCallId: string; readonly delta: string };
    }
  | { readonly type: "tool_call.completed"; readonly payload: AIToolCall }
  | { readonly type: "usage"; readonly payload: ModelUsage }
  | {
      readonly type: "adapter.finish";
      readonly payload: {
        readonly finishReason: AIFinishReason;
        readonly finalUsage?: ModelUsage;
        readonly providerReason?: string;
      };
    };

/** Every adapter event type, in canonical order. */
export const AI_ADAPTER_EVENT_TYPES = [
  "text.delta",
  "reasoning.summary.delta",
  "tool_call.start",
  "tool_call.delta",
  "tool_call.completed",
  "usage",
  "adapter.finish",
] as const satisfies readonly AIAdapterEvent["type"][];

/** The events an adapter owns and the gateway must never accept from itself. */
export const GATEWAY_ENVELOPE_EVENT_TYPES = [
  "stream.start",
  "stream.finish",
  "stream.error",
] as const;
