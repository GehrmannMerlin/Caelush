import { assertExactKeys, assertNonEmptyString, describeValue } from "../internal/assertions.js";
import { isJsonObject } from "../json/json-value.js";
import type { JsonObject } from "../json/json-value.js";

/**
 * Provider-opaque assistant continuity state.
 *
 * ```text
 * providerId   which provider produced the state
 * api          which API dialect the state belongs to
 * version      the state envelope version; this contract defines exactly 1
 * payload      JSON-safe provider-private data
 * ```
 *
 * ## Opaque means opaque
 *
 * The AI core never interprets `payload`. It does not read a signature, a reasoning
 * block, a response id or a cache hint out of it, and it defines no accessor that
 * would invite a caller to. The field exists so that a state a provider requires on
 * the *next* turn can survive a round trip through Caelush without any layer in
 * between having to understand it.
 *
 * ```text
 * @caelush/ai            stores, validates, carries
 * @caelush/agent         stores, projects, carries
 * Context Engine          never sees it
 * @caelush/coding-agent  never sees it
 * ```
 *
 * ## Provider switch safety
 *
 * A state is bound to `(providerId, api)`. An adapter whose own dialect does not match
 * both MUST ignore the state and keep sending the semantic message: dropping an
 * assistant message because it carried another provider's opaque envelope would
 * discard real conversation. Constraint 22 of the Message System V2 freeze is the
 * authority for that rule, and `AIAssistantMessage.providerState` is `undefined` — not
 * a matching state — when nothing needed to be carried.
 *
 * ## Versioning
 *
 * `version` is the literal `1`, not `number`. A reader that cannot recognise the
 * version cannot know what the payload means, so a future envelope shape is a new
 * field or a new literal rather than a silently accepted integer.
 */
export interface AIProviderOpaqueState {
  readonly providerId: string;

  readonly api: string;

  readonly version: 1;

  readonly payload: JsonObject;
}

/** Every field of a provider opaque state, in canonical order. */
export const AI_PROVIDER_OPAQUE_STATE_KEYS = ["providerId", "api", "version", "payload"] as const;

/** The only provider-state envelope version this contract defines. */
export const AI_PROVIDER_OPAQUE_STATE_VERSION = 1 as const;

/**
 * Assert a well-formed provider opaque state.
 *
 * Strict on purpose, and identical in strictness to the rest of the AI message
 * contract: unknown keys are rejected, because a smuggled field would be state that
 * no reader validated and no writer promised.
 */
export function assertAIProviderOpaqueState(
  value: unknown,
): asserts value is AIProviderOpaqueState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI provider state must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, AI_PROVIDER_OPAQUE_STATE_KEYS, "AI provider state");

  assertNonEmptyString(candidate.providerId, "AI provider state providerId");
  assertNonEmptyString(candidate.api, "AI provider state api");
  if (candidate.version !== AI_PROVIDER_OPAQUE_STATE_VERSION) {
    throw new TypeError(
      `AI provider state version must be ${String(AI_PROVIDER_OPAQUE_STATE_VERSION)}, received ${describeValue(candidate.version)}.`,
    );
  }
  if (!isJsonObject(candidate.payload)) {
    throw new TypeError(
      `AI provider state payload must be a JSON object, received ${describeValue(candidate.payload)}.`,
    );
  }
}

/**
 * True when a state belongs to the given provider and API dialect.
 *
 * This is the whole of the matching rule an adapter needs. It is deliberately a
 * *predicate* rather than a translation: a non-matching state is ignored, never
 * rewritten into the receiving provider's shape, because reinterpreting one
 * provider's private state as another's would be inventing continuity that the
 * provider never issued.
 */
export function providerStateMatches(
  state: AIProviderOpaqueState,
  providerId: string,
  api: string,
): boolean {
  return state.providerId === providerId && state.api === api;
}
