import {
  PROMPT_SURFACE_RESET_REASONS,
  projectPromptSurfaceResetReason,
  type PublicPromptSurfaceResetReason,
} from "@caelush/agent";

/**
 * The public cache-reset projection.
 *
 * Two questions are deliberately answered separately:
 *
 * ```text
 * "was this epoch boundary a cache reset?"   internal vocabulary, including CAPACITY_ROLLOVER
 * "which reason may a client be told?"       closed public vocabulary only
 * ```
 *
 * The internal Prompt Surface reasons are the authority for cache accounting, because a boundary
 * that invalidates the reusable prefix really does reset the cache. The public `resetReason` field
 * is optional but its enum is closed, and an older strict client rejects the whole response when it
 * sees a value it does not know. So a reason outside the public vocabulary is omitted rather than
 * renamed to something untrue: an omitted field is a fact about the projection, a fabricated
 * `INITIAL` would be a lie about the Run.
 */
export function isInternalPromptCacheResetReason(value: string | undefined): boolean {
  return PROMPT_SURFACE_RESET_REASONS.some((reason) => reason === value);
}

/** Whitelist a reason for the public `PromptCacheUsage.resetReason` field. */
export function toPublicPromptCacheResetReason(
  value: string | undefined,
): PublicPromptSurfaceResetReason | undefined {
  return projectPromptSurfaceResetReason(value);
}
