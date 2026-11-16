import { describe, expect, it } from "vitest";

import {
  catalogPresentationHash,
  createSkillBundleRevision,
  createSkillIdentity,
  resolveEffectiveSkills,
  type SkillCandidate,
  type SkillManifest,
  type SkillScopeRank,
} from "../src/index.js";

const skillModule = (await import("../src/index.js")) as unknown as Record<string, unknown>;

interface SearchEntry {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly searchTerms: readonly string[];
  readonly enabled: boolean;
  readonly userInvocable: boolean;
  readonly modelInvocable: boolean;
}

interface SearchCatalog {
  readonly revision: string;
  readonly complete: boolean;
  readonly diagnostics: readonly [];
  readonly entries: readonly SearchEntry[];
}

interface SearchResult {
  readonly items: readonly {
    readonly skillId: string;
    readonly name: string;
    readonly description: string;
  }[];
  readonly nextCursor?: string;
}

type Search = (input: {
  readonly catalog: SearchCatalog;
  readonly query: string;
  readonly cursor?: string;
  readonly pageSize: number;
  readonly audience: "USER" | "MODEL";
  readonly cursorBinding?: string;
}) => SearchResult;

describe("Skill catalog search", () => {
  it("normalizes NFKC English names and finds Chinese descriptions through bounded synonyms", () => {
    const catalog = searchCatalog([
      searchEntry({
        skillId: "frontend",
        name: "frontend-design",
        description: "Build responsive web pages and user interfaces.",
        searchTerms: ["landing pages", "visual polish"],
      }),
      searchEntry({
        skillId: "database",
        name: "database-migration",
        description: "Plan SQL database schema migrations.",
      }),
    ]);
    const search = exportedFunction<Search>("searchSkillCatalog");
    if (search === undefined) return;

    const normalized = search({
      catalog,
      query: "ＦＲＯＮＴＥＮＤ-ＤＥＳＩＧＮ",
      pageSize: 20,
      audience: "MODEL",
    });
    const chinese = search({
      catalog,
      query: "优化页面",
      pageSize: 20,
      audience: "MODEL",
    });
    const negative = search({
      catalog,
      query: "纯数据库迁移",
      pageSize: 20,
      audience: "MODEL",
    });

    expect(normalized.items.map(({ skillId }) => skillId)).toEqual(["frontend"]);
    expect(chinese.items.map(({ skillId }) => skillId)).toEqual(["frontend"]);
    expect(negative.items.map(({ skillId }) => skillId)).toEqual(["database"]);
  });

  it("keeps MODEL and USER audience filters independent and excludes disabled entries", () => {
    const catalog = searchCatalog([
      searchEntry({ skillId: "automatic", name: "automatic", enabled: true }),
      searchEntry({
        skillId: "manual",
        name: "manual",
        enabled: true,
        modelInvocable: false,
      }),
      searchEntry({ skillId: "disabled", name: "disabled", enabled: false }),
    ]);
    const search = exportedFunction<Search>("searchSkillCatalog");
    if (search === undefined) return;

    const model = search({
      catalog,
      query: "skill",
      pageSize: 20,
      audience: "MODEL",
    });
    const user = search({
      catalog,
      query: "skill",
      pageSize: 20,
      audience: "USER",
    });

    expect(model.items.map(({ skillId }) => skillId)).toEqual(["automatic"]);
    expect(user.items.map(({ skillId }) => skillId)).toEqual(["automatic", "manual"]);
  });

  it("sorts ties deterministically and binds cursors to run, catalog, query, and audience", () => {
    const catalog = searchCatalog([
      searchEntry({ skillId: "zeta", name: "zeta-skill" }),
      searchEntry({ skillId: "alpha", name: "alpha-skill" }),
      searchEntry({ skillId: "beta", name: "beta-skill" }),
    ]);
    const search = exportedFunction<Search>("searchSkillCatalog");
    if (search === undefined) return;

    const first = search({
      catalog,
      query: "skill",
      pageSize: 1,
      audience: "MODEL",
      cursorBinding: "run_one",
    });

    expect(first.items.map(({ skillId }) => skillId)).toEqual(["alpha"]);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(() =>
      search({
        catalog,
        query: "skill",
        cursor: first.nextCursor,
        pageSize: 1,
        audience: "MODEL",
        cursorBinding: "run_two",
      }),
    ).toThrow();
    expect(() =>
      search({
        catalog,
        query: "different",
        cursor: first.nextCursor,
        pageSize: 1,
        audience: "MODEL",
        cursorBinding: "run_one",
      }),
    ).toThrow();
    expect(() =>
      search({
        catalog,
        query: "skill",
        cursor: first.nextCursor,
        pageSize: 1,
        audience: "USER",
        cursorBinding: "run_one",
      }),
    ).toThrow();
  });

  it("keeps the presentation metadata hash independent from body-only edits", () => {
    const first = effectiveCatalog("Original core instructions.");
    const edited = effectiveCatalog("Updated core instructions.");

    expect(catalogPresentationHash(edited)).toBe(catalogPresentationHash(first));
  });
});

function exportedFunction<T>(name: string): T | undefined {
  const value = skillModule[name];
  expect(value, `${name} should be exported`).toBeTypeOf("function");
  return typeof value === "function" ? (value as T) : undefined;
}

function searchCatalog(entries: readonly SearchEntry[]): SearchCatalog {
  return {
    revision: "catalog-search-v1",
    complete: true,
    diagnostics: [],
    entries,
  };
}

function searchEntry(input: {
  readonly skillId: string;
  readonly name: string;
  readonly description?: string;
  readonly searchTerms?: readonly string[];
  readonly enabled?: boolean;
  readonly userInvocable?: boolean;
  readonly modelInvocable?: boolean;
}): SearchEntry {
  return {
    skillId: input.skillId,
    name: input.name,
    description: input.description ?? "A skill for this task.",
    searchTerms: input.searchTerms ?? [],
    enabled: input.enabled ?? true,
    userInvocable: input.userInvocable ?? true,
    modelInvocable: input.modelInvocable ?? true,
  };
}

function effectiveCatalog(body: string) {
  const scopeRank: SkillScopeRank = 0;
  const providerId = "search-test";
  const privateLocator = "frontend";
  const manifest: SkillManifest = {
    name: "frontend-design",
    description: "Build responsive web pages.",
    body,
    userInvocable: true,
    modelInvocable: true,
  };
  const candidate: SkillCandidate = {
    scopeRank,
    providerId,
    privateLocator,
    skillId: createSkillIdentity({ scopeRank, providerId, privateLocator }),
    bundleRevision: createSkillBundleRevision(manifest),
    manifest,
  };
  return resolveEffectiveSkills([candidate]);
}
