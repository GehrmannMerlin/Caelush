import { describe, expect, it } from "vitest";
import type {
  SkillCandidate,
  SkillDiagnostic,
  SkillManifest,
  SkillScopeRank,
} from "../src/index.js";
import { parseSkillManifest } from "../src/index.js";

const domain = (await import("../src/index.js")) as unknown as Record<string, unknown>;

interface EffectiveSkillCatalog {
  readonly revision: string;
  readonly entries: readonly SkillCandidate[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly complete: boolean;
}

interface SkillIdentityInput {
  readonly scopeRank: SkillScopeRank;
  readonly providerId: string;
  readonly privateLocator: string;
}

interface SkillDiscoveryResult {
  readonly candidates: readonly SkillCandidate[];
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly complete: boolean;
}

describe("effective Skill catalog", () => {
  it("resolves project over user over built-in and never substitutes an explicit identity", () => {
    const builtIn = candidate(2, "builtin", "translator", manifest("translate", "Built-in"));
    const user = candidate(1, "filesystem", "translator", manifest("translate", "User copy"));
    const project = candidate(0, "filesystem", "translator", manifest("translate", "Project"));
    const catalog = resolve([builtIn, user, project]);

    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]?.skillId).toBe(project.skillId);
    expect(catalog.entries[0]?.manifest.description).toBe("Project");
    expect(catalog.entries.some((entry) => entry.skillId === user.skillId)).toBe(false);
  });

  it("deduplicates repeated discovery of the same source resource", () => {
    const discovered = candidate(0, "project-skills", "alpha", manifest("alpha", "Alpha"));

    const catalog = resolve([discovered, discovered]);

    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]?.skillId).toBe(discovered.skillId);
    expect(catalog.diagnostics).toEqual([]);
  });

  it("retains valid candidates alongside a diagnostic for one invalid manifest", () => {
    const valid = candidate(0, "project-skills", "valid", manifest("valid", "Valid item"));
    const invalid = parseSkillManifest("---\nname: invalid\n---\nInvalid item");
    if (invalid.ok) throw new Error("The test manifest must be invalid.");

    const discovery: SkillDiscoveryResult = {
      candidates: [valid],
      diagnostics: invalid.diagnostics,
      complete: true,
    };
    const catalog = call<SkillDiscoveryResult, EffectiveSkillCatalog>(
      "resolveSkillDiscovery",
      discovery,
    );

    expect(catalog.entries).toEqual([valid]);
    expect(catalog.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "DESCRIPTION_REQUIRED",
    );
    expect(catalog.complete).toBe(true);
  });

  it("breaks same-scope name conflicts by code-point resource order with a safe diagnostic", () => {
    const astral = candidate(0, "project-skills", "\u{10000}", manifest("shared", "Astral"));
    const privateUse = candidate(0, "project-skills", "\uE000", manifest("shared", "Private"));

    const forward = resolve([astral, privateUse]);
    const reverse = resolve([privateUse, astral]);

    expect(forward.entries[0]?.skillId).toBe(privateUse.skillId);
    expect(reverse.entries[0]?.skillId).toBe(privateUse.skillId);
    expect(forward.diagnostics).toEqual([
      {
        code: "DUPLICATE_SKILL_NAME",
        severity: "WARNING",
        safeMessage: expect.any(String),
      },
    ]);
    expect(JSON.stringify(forward.diagnostics)).not.toContain("privateLocator");
    expect(JSON.stringify(forward.diagnostics)).not.toContain("\\uE000");
  });

  it("keeps body revisions out of presentation hash but in catalog revision", () => {
    const first = candidate(
      0,
      "project-skills",
      "writer",
      manifest("write", "Write clearly", "Original."),
    );
    const edited = candidate(
      0,
      "project-skills",
      "writer",
      manifest("write", "Write clearly", "Edited."),
    );

    const firstCatalog = resolve([first]);
    const editedCatalog = resolve([edited]);

    expect(presentationHash(editedCatalog)).toBe(presentationHash(firstCatalog));
    expect(editedCatalog.revision).not.toBe(firstCatalog.revision);
  });

  it("changes presentation hash when model-visible description changes", () => {
    const first = resolve([
      candidate(0, "project-skills", "writer", manifest("write", "Write clearly")),
    ]);
    const changed = resolve([
      candidate(0, "project-skills", "writer", manifest("write", "Write concise prose")),
    ]);

    expect(presentationHash(changed)).not.toBe(presentationHash(first));
  });

  it("excludes private roots, scan metadata, and UI query from presentation hash", () => {
    const original = candidate(
      1,
      "filesystem",
      "C:/Users/private/skills/translate/SKILL.md",
      manifest("translate", "Translate documents"),
    );
    const moved = candidate(
      1,
      "filesystem",
      "D:/Private/other-root/translate/SKILL.md",
      manifest("translate", "Translate documents"),
    );
    const originalCatalog = resolve([original]);
    const movedCatalog = resolve([moved]);
    const decoratedCatalog = {
      ...movedCatalog,
      scanCompletedAt: "2099-01-01T00:00:00.000Z",
      privateRoot: "E:/private/root",
      uiQuery: "updated query",
    };

    expect(moved.skillId).not.toBe(original.skillId);
    expect(presentationHash(movedCatalog)).toBe(presentationHash(originalCatalog));
    expect(presentationHash(decoratedCatalog)).toBe(presentationHash(movedCatalog));
  });

  it.each([65, 100, 500])("resolves all %i entries without an aggregate count limit", (count) => {
    const candidates = Array.from({ length: count }, (_, index) => {
      const name = `skill-${String(index).padStart(3, "0")}`;
      return candidate(0, "project-skills", name, manifest(name, `Description ${index}`));
    });

    const catalog = resolve(candidates);

    expect(catalog.complete).toBe(true);
    expect(catalog.entries).toHaveLength(count);
    expect(catalog.diagnostics).toEqual([]);
  });
});

function candidate(
  scopeRank: SkillScopeRank,
  providerId: string,
  privateLocator: string,
  skillManifest: SkillManifest,
): SkillCandidate {
  const identity = { scopeRank, providerId, privateLocator };
  return {
    ...identity,
    skillId: call<SkillIdentityInput, string>("createSkillIdentity", identity),
    manifest: skillManifest,
    bundleRevision: call<SkillManifest, string>("createSkillBundleRevision", skillManifest),
  };
}

function manifest(name: string, description: string, body = "Body"): SkillManifest {
  return { name, description, body, userInvocable: true, modelInvocable: true };
}

function resolve(candidates: readonly SkillCandidate[]): EffectiveSkillCatalog {
  return call<readonly SkillCandidate[], EffectiveSkillCatalog>(
    "resolveEffectiveSkills",
    candidates,
  );
}

function presentationHash(catalog: EffectiveSkillCatalog): string {
  return call<EffectiveSkillCatalog, string>("catalogPresentationHash", catalog);
}

function call<TInput, TResult>(name: string, input: TInput): TResult {
  const candidate = domain[name];
  expect(candidate, `${name} should be exported`).toBeTypeOf("function");
  return (candidate as (value: TInput) => TResult)(input);
}
