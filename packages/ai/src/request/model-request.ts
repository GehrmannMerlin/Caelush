import { assertExactKeys, describeValue } from "../internal/assertions.js";
import type { AIMessage } from "../messages/message.js";
import type { AIModelSettings } from "./model-settings.js";
import type { AIToolChoice } from "./tool-choice.js";
import type { AIToolSpec } from "../tools/tool-spec.js";
import type { ModelRef } from "../models/model-ref.js";

/**
 * A provider-independent model invocation request.
 *
 * This is what a caller writes. It names a model, carries messages, and may
 * describe tools and settings — nothing about endpoints, credentials, dialects,
 * retries or agent policy.
 */
export interface AIModelRequest {
  readonly model: ModelRef;
  readonly messages: readonly AIMessage[];
  readonly tools?: readonly AIToolSpec[];
  readonly toolChoice?: AIToolChoice;
  readonly settings?: AIModelSettings;
}

/** The exact request key set. */
export const MODEL_REQUEST_KEYS = [
  "model",
  "messages",
  "tools",
  "toolChoice",
  "settings",
] as const satisfies readonly (keyof AIModelRequest)[];

/** Assert the outer request shape. Field semantics are validated separately. */
export function assertAIModelRequestShape(value: unknown): asserts value is AIModelRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI model request must be an object, received ${describeValue(value)}.`);
  }
  assertExactKeys(value as Record<string, unknown>, MODEL_REQUEST_KEYS, "AI model request");
}
