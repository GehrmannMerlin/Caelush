import { catalogPresentationHash, projectSkillCatalogSearchEntries } from "./catalog.js";
import { compareSkillCodePoints } from "./identity.js";
import type { SkillCatalogSearchEntry, SkillCatalogSearchSource } from "./types.js";

export interface SkillCatalogPresentation {
  readonly text: string;
  readonly includedIds: readonly string[];
  readonly omittedCount: number;
  readonly inventoryComplete: boolean;
  readonly presentationComplete: boolean;
  readonly presentationHash: string;
  readonly estimatedTokens: number;
}

export interface BuildSkillCatalogPresentationInput {
  readonly catalog: SkillCatalogSearchSource;
  readonly maxTokens: number;
  readonly estimate: (text: string) => number;
}

export function buildCatalogPresentation(
  input: BuildSkillCatalogPresentationInput,
): SkillCatalogPresentation {
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1) {
    throw new RangeError("Skill catalog presentation budget must be a positive safe integer.");
  }
  const entries = projectSkillCatalogSearchEntries(input.catalog)
    .filter((entry) => entry.enabled && entry.modelInvocable)
    .sort(
      (left, right) =>
        compareSkillCodePoints(left.name, right.name) ||
        compareSkillCodePoints(left.skillId, right.skillId),
    );
  const presentationHash = catalogPresentationHash(input.catalog);
  if (entries.length === 0 && input.catalog.complete) {
    return Object.freeze({
      text: "",
      includedIds: Object.freeze([]),
      omittedCount: 0,
      inventoryComplete: true,
      presentationComplete: true,
      presentationHash,
      estimatedTokens: 0,
    });
  }

  const included: SkillCatalogSearchEntry[] = [];
  for (const entry of entries) {
    const candidate = [...included, entry];
    const omittedCount = entries.length - candidate.length;
    const text = renderCatalog({
      entries: candidate,
      inventoryComplete: input.catalog.complete,
      presentationComplete: omittedCount === 0,
      omittedCount,
    });
    if (estimateTokens(input.estimate, text) <= input.maxTokens) included.push(entry);
  }

  let omittedCount = entries.length - included.length;
  let presentationComplete = omittedCount === 0;
  let text = renderCatalog({
    entries: included,
    inventoryComplete: input.catalog.complete,
    presentationComplete,
    omittedCount,
  });
  let estimatedTokens = estimateTokens(input.estimate, text);
  while (estimatedTokens > input.maxTokens && included.length > 0) {
    included.pop();
    omittedCount = entries.length - included.length;
    presentationComplete = false;
    text = renderCatalog({
      entries: included,
      inventoryComplete: input.catalog.complete,
      presentationComplete,
      omittedCount,
    });
    estimatedTokens = estimateTokens(input.estimate, text);
  }
  if (estimatedTokens > input.maxTokens) {
    throw new RangeError("Skill catalog status cannot fit within its token budget.");
  }

  return Object.freeze({
    text,
    includedIds: Object.freeze(included.map(({ skillId }) => skillId)),
    omittedCount,
    inventoryComplete: input.catalog.complete,
    presentationComplete,
    presentationHash,
    estimatedTokens,
  });
}

function renderCatalog(input: {
  readonly entries: readonly SkillCatalogSearchEntry[];
  readonly inventoryComplete: boolean;
  readonly presentationComplete: boolean;
  readonly omittedCount: number;
}): string {
  return JSON.stringify({
    inventoryComplete: input.inventoryComplete,
    presentationComplete: input.presentationComplete,
    omittedCount: input.omittedCount,
    ...(input.omittedCount > 0 ? { searchHint: "search_skills" } : {}),
    entries: input.entries.map(({ name, description, displayName }) => ({
      name,
      ...(displayName === undefined ? {} : { displayName }),
      description,
    })),
  });
}

function estimateTokens(estimate: (text: string) => number, text: string): number {
  const value = estimate(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Skill catalog token estimator returned an invalid estimate.");
  }
  return value;
}
