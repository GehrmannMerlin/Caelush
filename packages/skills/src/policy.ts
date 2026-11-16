import type { SkillManifest } from "./types.js";

export type SkillInvocationAudience = "USER" | "MODEL";

export const DEFAULT_SKILL_CATALOG_INPUT_TOKEN_FALLBACK = 2_048;
export const MAX_SKILL_CATALOG_PRESENTATION_TOKENS = 8_192;
export const SKILL_CATALOG_INPUT_BUDGET_RATIO = 0.02;

/** Resolve the stable, bounded directory allowance from the effective model input limit. */
export function resolveSkillCatalogTokenBudget(effectiveInputTokens?: number): number {
  const inputLimit = effectiveInputTokens ?? DEFAULT_SKILL_CATALOG_INPUT_TOKEN_FALLBACK;
  if (!Number.isSafeInteger(inputLimit) || inputLimit < 1) {
    throw new RangeError("The effective model input token limit must be a positive safe integer.");
  }
  return Math.max(
    1,
    Math.min(
      MAX_SKILL_CATALOG_PRESENTATION_TOKENS,
      Math.floor(inputLimit * SKILL_CATALOG_INPUT_BUDGET_RATIO),
    ),
  );
}

export function isSkillInvocable(
  manifest: SkillManifest,
  audience: SkillInvocationAudience,
): boolean {
  switch (audience) {
    case "USER":
      return manifest.userInvocable;
    case "MODEL":
      return manifest.modelInvocable;
    default:
      return false;
  }
}
