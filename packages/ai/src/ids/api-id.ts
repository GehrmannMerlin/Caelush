/**
 * API dialect identity.
 *
 * An `ApiId` names a wire dialect (for example `openai-compatible-chat` or
 * `anthropic-messages`), not a vendor. Several providers may share one dialect,
 * and one API adapter serves all of them. This is the separation that keeps
 * `Model != Provider != API dialect` in the V2 core.
 */
export type ApiId = string;

/** The frozen api identifier shape. Identical to {@link PROVIDER_ID_PATTERN}. */
export const API_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Runtime validation for an api identifier. */
export function isValidApiId(value: string): boolean {
  return API_ID_PATTERN.test(value);
}

/**
 * API dialects reserved by the frozen V2 design.
 *
 * Reserving the ids does not implement the adapters. Phase 2A ships no real
 * adapter, so neither dialect is registered anywhere yet.
 */
export const RESERVED_API_IDS = ["openai-compatible-chat", "anthropic-messages"] as const;

/** A reserved api dialect id. */
export type ReservedApiId = (typeof RESERVED_API_IDS)[number];
