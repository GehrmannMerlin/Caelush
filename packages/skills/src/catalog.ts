import {
  compareSkillCodePoints,
  createSkillBundleRevision,
  createSkillIdentity,
  hashSkillData,
} from "./identity.js";
import { isSkillInvocable } from "./policy.js";
import type {
  EffectiveSkillCatalog,
  SkillCandidate,
  SkillDiagnostic,
  SkillDiscoveryResult,
} from "./types.js";

const SAFE_MESSAGES = {
  SKILL_CANDIDATE_INVALID: "A discovered Skill entry is invalid and was skipped.",
  SKILL_IDENTITY_MISMATCH: "A discovered Skill identity does not match its source.",
  DUPLICATE_SKILL_IDENTITY: "A Skill source produced conflicting content during discovery.",
  DUPLICATE_SKILL_NAME: "Multiple Skills share a name; a deterministic source was selected.",
} as const;

type CatalogDiagnosticCode = keyof typeof SAFE_MESSAGES;

export function resolveEffectiveSkills(
  candidates: readonly SkillCandidate[],
): EffectiveSkillCatalog {
  const diagnostics: SkillDiagnostic[] = [];
  const uniqueByIdentity = new Map<string, SkillCandidate[]>();

  for (const candidate of candidates) {
    if (!isCandidate(candidate)) {
      diagnostics.push(diagnostic("SKILL_CANDIDATE_INVALID"));
      continue;
    }
    if (candidate.skillId !== createSkillIdentity(candidate)) {
      diagnostics.push(diagnostic("SKILL_IDENTITY_MISMATCH"));
      continue;
    }

    const group = uniqueByIdentity.get(candidate.skillId) ?? [];
    group.push(candidate);
    uniqueByIdentity.set(candidate.skillId, group);
  }

  const uniqueCandidates: SkillCandidate[] = [];
  for (const duplicates of uniqueByIdentity.values()) {
    const ordered = [...duplicates].sort(compareDuplicateCandidates);
    const selected = ordered[0];
    if (selected === undefined) continue;
    uniqueCandidates.push(selected);
    if (ordered.some((candidate) => contentRevision(candidate) !== contentRevision(selected))) {
      diagnostics.push(diagnostic("DUPLICATE_SKILL_IDENTITY"));
    }
  }

  const byName = new Map<string, SkillCandidate[]>();
  for (const candidate of uniqueCandidates) {
    const group = byName.get(candidate.manifest.name) ?? [];
    group.push(candidate);
    byName.set(candidate.manifest.name, group);
  }

  const entries: SkillCandidate[] = [];
  for (const group of byName.values()) {
    const ordered = [...group].sort(compareSourcePriority);
    const winner = ordered[0];
    if (winner === undefined) continue;
    entries.push(winner);

    const winnerScopeCount = ordered.filter(
      (candidate) => candidate.scopeRank === winner.scopeRank,
    );
    if (winnerScopeCount.length > 1) diagnostics.push(diagnostic("DUPLICATE_SKILL_NAME"));
  }

  entries.sort(
    (left, right) =>
      compareSkillCodePoints(left.manifest.name, right.manifest.name) ||
      compareSkillCodePoints(left.skillId, right.skillId),
  );
  diagnostics.sort(
    (left, right) =>
      compareSkillCodePoints(left.code, right.code) ||
      compareSkillCodePoints(left.safeMessage, right.safeMessage),
  );

  return {
    revision: catalogRevision(entries),
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
    complete: true,
  };
}

export function resolveSkillDiscovery(discovery: SkillDiscoveryResult): EffectiveSkillCatalog {
  const catalog = resolveEffectiveSkills(discovery.candidates);
  const diagnostics = [...discovery.diagnostics, ...catalog.diagnostics].sort(
    (left, right) =>
      compareSkillCodePoints(left.code, right.code) ||
      compareSkillCodePoints(left.safeMessage, right.safeMessage),
  );
  return {
    ...catalog,
    diagnostics: Object.freeze(diagnostics),
    complete: discovery.complete,
  };
}

export function catalogPresentationHash(catalog: EffectiveSkillCatalog): string {
  const modelVisibleEntries = catalog.entries
    .filter((candidate) => isSkillInvocable(candidate.manifest, "MODEL"))
    .map(({ manifest }) => ({ name: manifest.name, description: manifest.description }));
  return `sha256:${hashSkillData(
    JSON.stringify(["caelush.skills.catalog-presentation.v1", modelVisibleEntries]),
  )}`;
}

function isCandidate(value: unknown): value is SkillCandidate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SkillCandidate>;
  if (
    typeof candidate.skillId !== "string" ||
    typeof candidate.providerId !== "string" ||
    typeof candidate.privateLocator !== "string" ||
    (candidate.scopeRank !== 0 && candidate.scopeRank !== 1 && candidate.scopeRank !== 2)
  ) {
    return false;
  }

  const manifest = candidate.manifest;
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    typeof manifest.name === "string" &&
    typeof manifest.description === "string" &&
    typeof manifest.body === "string" &&
    typeof manifest.userInvocable === "boolean" &&
    typeof manifest.modelInvocable === "boolean"
  );
}

function compareDuplicateCandidates(left: SkillCandidate, right: SkillCandidate): number {
  return (
    compareSkillCodePoints(contentRevision(left), contentRevision(right)) ||
    compareSkillCodePoints(canonicalManifest(left), canonicalManifest(right))
  );
}

function compareSourcePriority(left: SkillCandidate, right: SkillCandidate): number {
  return (
    left.scopeRank - right.scopeRank ||
    compareSkillCodePoints(left.providerId, right.providerId) ||
    compareSkillCodePoints(left.privateLocator, right.privateLocator) ||
    compareSkillCodePoints(left.skillId, right.skillId)
  );
}

function contentRevision(candidate: SkillCandidate): string {
  return candidate.bundleRevision ?? createSkillBundleRevision(candidate.manifest);
}

function canonicalManifest(candidate: SkillCandidate): string {
  return JSON.stringify([
    candidate.manifest.name,
    candidate.manifest.description,
    candidate.manifest.body,
    candidate.manifest.compatibility ?? null,
    Object.entries(candidate.manifest.metadata ?? {}).sort(([left], [right]) =>
      compareSkillCodePoints(left, right),
    ),
    candidate.manifest.userInvocable,
    candidate.manifest.modelInvocable,
  ]);
}

function catalogRevision(entries: readonly SkillCandidate[]): string {
  const revisionEntries = entries.map((candidate) => [
    candidate.skillId,
    candidate.manifest.name,
    candidate.manifest.description,
    candidate.manifest.userInvocable,
    candidate.manifest.modelInvocable,
    contentRevision(candidate),
  ]);
  return `sha256:${hashSkillData(
    JSON.stringify(["caelush.skills.catalog-revision.v1", revisionEntries]),
  )}`;
}

function diagnostic(code: CatalogDiagnosticCode): SkillDiagnostic {
  return { code, severity: "WARNING", safeMessage: SAFE_MESSAGES[code] };
}
