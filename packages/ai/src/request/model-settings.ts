import { assertExactKeys, describeValue } from "../internal/assertions.js";
import { isCacheRetention } from "../cache/cache-retention.js";
import { isReasoningLevel } from "../reasoning/reasoning-level.js";
import type { AICacheRequest } from "../cache/cache-resolution.js";
import type { AIReasoningRequest } from "../reasoning/reasoning-resolution.js";

/**
 * The complete set of model settings the AI core understands.
 *
 * Provider spellings are deliberately absent. `reasoning_effort`,
 * `budget_tokens`, `thinkingConfig`, `cache_control`, `cachePoint` and
 * `providerOptions` are adapter concerns: the AI core expresses intent in
 * semantic levels and retentions, and each adapter translates that to its own
 * dialect.
 */
export interface AIModelSettings {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly reasoning?: AIReasoningRequest;
  readonly cache?: AICacheRequest;
}

/** The exact settings key set. */
export const MODEL_SETTINGS_KEYS = [
  "maxOutputTokens",
  "temperature",
  "reasoning",
  "cache",
] as const satisfies readonly (keyof AIModelSettings)[];

/**
 * Assert a well-formed settings object.
 *
 * Unknown fields are rejected rather than ignored: an unknown field is how a
 * provider dialect option would leak into the provider-independent request.
 */
export function assertAIModelSettings(value: unknown): asserts value is AIModelSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI model settings must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, MODEL_SETTINGS_KEYS, "AI model settings");

  if (candidate.reasoning !== undefined) assertAIReasoningRequest(candidate.reasoning);
  if (candidate.cache !== undefined) assertAICacheRequest(candidate.cache);
}

/** Assert a well-formed reasoning request. */
export function assertAIReasoningRequest(value: unknown): asserts value is AIReasoningRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      `AI reasoning request must be an object, received ${describeValue(value)}.`,
    );
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, ["level"], "AI reasoning request");

  if (!isReasoningLevel(candidate.level)) {
    throw new TypeError(
      `AI reasoning request level is unknown: ${describeValue(candidate.level)}.`,
    );
  }
}

/** Assert a well-formed cache request. */
export function assertAICacheRequest(value: unknown): asserts value is AICacheRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI cache request must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, ["retention", "key"], "AI cache request");

  if (!isCacheRetention(candidate.retention)) {
    throw new TypeError(
      `AI cache request retention is unknown: ${describeValue(candidate.retention)}.`,
    );
  }
  if (candidate.key !== undefined && typeof candidate.key !== "string") {
    throw new TypeError(
      `AI cache request key must be a string, received ${describeValue(candidate.key)}.`,
    );
  }
}
