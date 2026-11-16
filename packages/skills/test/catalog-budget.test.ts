import { describe, expect, it } from "vitest";

import {
  createSkillBundleRevision,
  createSkillIdentity,
  resolveEffectiveSkills,
} from "../src/index.js";

const skillModule = (await import("../src/index.js")) as unknown as Record<string, unknown>;

interface SearchEntry {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly userInvocable: boolean;
  readonly modelInvocable: boolean;
  readonly searchTerms: readonly string[];
}

interface TestCatalog {
  readonly revision: string;
  readonly complete: boolean;
  readonly diagnostics: readonly [];
  readonly entries: readonly SearchEntry[];
}

interface Presentation {
  readonly text: string;
  readonly includedIds: readonly string[];
  readonly omittedCount: number;
  readonly inventoryComplete: boolean;
  readonly presentationComplete: boolean;
  readonly presentationHash: string;
  readonly estimatedTokens: number;
}

interface SearchPage {
  readonly items: readonly {
    readonly skillId: string;
    readonly name: string;
    readonly description: string;
  }[];
}

type BuildPresentation = (input: {
  readonly catalog: TestCatalog | ReturnType<typeof effectiveCatalog>;
  readonly maxTokens: number;
  readonly estimate: (text: string) => number;
}) => Presentation;
type SearchCatalog = (input: {
  readonly catalog: TestCatalog;
  readonly query: string;
  readonly cursor?: string;
  readonly pageSize: number;
  readonly audience: "MODEL";
}) => SearchPage;

describe("bounded MODEL Skill catalog presentation", () => {
  it.each([65, 100, 500])(
    "keeps a %i-entry catalog available when presentation is over budget",
    (count) => {
      const catalog = searchCatalog(count);
      const build = exportedFunction<BuildPresentation>("buildCatalogPresentation");
      if (build === undefined) return;

      const presentation = build({ catalog, maxTokens: 256, estimate: estimateTokens });

      expect(presentation.inventoryComplete).toBe(true);
      expect(presentation.presentationComplete).toBe(false);
      expect(presentation.omittedCount).toBeGreaterThan(0);
      expect(presentation.estimatedTokens).toBeLessThanOrEqual(256);
      expect(presentation.includedIds).toHaveLength(count - presentation.omittedCount);
    },
  );

  it("finds an entry omitted from the initial presentation through MODEL search", () => {
    const catalog = searchCatalog(100);
    const build = exportedFunction<BuildPresentation>("buildCatalogPresentation");
    const search = exportedFunction<SearchCatalog>("searchSkillCatalog");
    if (build === undefined || search === undefined) return;

    const presentation = build({ catalog, maxTokens: 256, estimate: estimateTokens });
    const page = search({
      catalog,
      query: "skill-099",
      pageSize: 20,
      audience: "MODEL",
    });

    expect(presentation.includedIds).not.toContain("id-099");
    expect(page.items.map(({ skillId }) => skillId)).toContain("id-099");
  });

  it("fits an explicit incomplete marker within the unknown-model fallback budget", () => {
    const catalog = searchCatalog(1);
    const build = exportedFunction<BuildPresentation>("buildCatalogPresentation");
    if (build === undefined) return;

    const presentation = build({
      catalog,
      maxTokens: 40,
      estimate: (text) => Math.ceil(Buffer.byteLength(text, "utf8") / 3),
    });

    expect(presentation.presentationComplete).toBe(false);
    expect(presentation.estimatedTokens).toBeLessThanOrEqual(40);
    expect(presentation.text).toContain('"presentationComplete":false');
    expect(presentation.text).toContain('"searchHint":"search_skills"');
  });

  it("renders every entry in deterministic name and identity order when the budget fits", () => {
    const entries = [
      searchEntry("zeta", "zeta", "Last alphabetically"),
      searchEntry("alpha", "alpha", "First alphabetically"),
      searchEntry("middle", "middle", "Middle alphabetically"),
    ];
    const build = exportedFunction<BuildPresentation>("buildCatalogPresentation");
    if (build === undefined) return;

    const forward = build({
      catalog: searchCatalog(entries),
      maxTokens: 512,
      estimate: estimateTokens,
    });
    const reversed = build({
      catalog: searchCatalog([...entries].reverse()),
      maxTokens: 512,
      estimate: estimateTokens,
    });

    expect(forward.presentationComplete).toBe(true);
    expect(forward.omittedCount).toBe(0);
    expect(forward.includedIds).toEqual(["alpha", "middle", "zeta"]);
    expect(forward.text).toBe(reversed.text);
    expect(forward.presentationHash).toBe(reversed.presentationHash);
  });

  it("does not truncate a description and keeps query changes out of the presentation hash", () => {
    const catalog = searchCatalog([
      searchEntry("frontend", "frontend-design", "Complete frontend design description."),
      searchEntry("database", "database-migration", "Complete database migration description."),
    ]);
    const build = exportedFunction<BuildPresentation>("buildCatalogPresentation");
    const search = exportedFunction<SearchCatalog>("searchSkillCatalog");
    if (build === undefined || search === undefined) return;

    const beforeSearch = build({ catalog, maxTokens: 80, estimate: estimateTokens });
    search({ catalog, query: "frontend", pageSize: 20, audience: "MODEL" });
    const afterSearch = build({ catalog, maxTokens: 80, estimate: estimateTokens });
    const included = new Set(beforeSearch.includedIds);
    for (const entry of catalog.entries) {
      if (!included.has(entry.skillId)) {
        expect(beforeSearch.text).not.toContain(entry.description);
      } else {
        expect(beforeSearch.text).toContain(entry.description);
      }
    }
    expect(afterSearch.presentationHash).toBe(beforeSearch.presentationHash);
  });

  it("excludes a Skill body-only edit from the stable metadata hash", () => {
    const hash =
      exportedFunction<(catalog: ReturnType<typeof effectiveCatalog>) => string>(
        "catalogPresentationHash",
      );
    if (hash === undefined) return;

    expect(hash(effectiveCatalog("Revised body text."))).toBe(
      hash(effectiveCatalog("Original body text.")),
    );
  });

  it("resolves the specified directory budget and unknown-model fallback", () => {
    const resolveBudget = exportedFunction<(effectiveInputTokens?: number) => number>(
      "resolveSkillCatalogTokenBudget",
    );
    if (resolveBudget === undefined) return;

    expect(resolveBudget(500_000)).toBe(8_192);
    expect(resolveBudget(2_500)).toBe(50);
    expect(resolveBudget(undefined)).toBe(40);
    expect(resolveBudget(1)).toBe(1);
  });
});

function exportedFunction<T>(name: string): T | undefined {
  const value = skillModule[name];
  expect(value, `${name} should be exported`).toBeTypeOf("function");
  return typeof value === "function" ? (value as T) : undefined;
}

function searchCatalog(countOrEntries: number | readonly SearchEntry[]): TestCatalog {
  const entries =
    typeof countOrEntries === "number"
      ? Array.from({ length: countOrEntries }, (_, index) => {
          const name = `skill-${String(index).padStart(3, "0")}`;
          return searchEntry(`id-${String(index).padStart(3, "0")}`, name, `Description ${index}.`);
        })
      : countOrEntries;
  return { revision: "catalog-budget-v1", complete: true, diagnostics: [], entries };
}

function searchEntry(skillId: string, name: string, description: string) {
  return {
    skillId,
    name,
    description,
    enabled: true,
    userInvocable: true,
    modelInvocable: true,
    searchTerms: [],
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function effectiveCatalog(body: string) {
  const scopeRank = 0 as const;
  const providerId = "budget-test";
  const privateLocator = "frontend";
  const manifest = {
    name: "frontend-design",
    description: "A stable description.",
    body,
    userInvocable: true,
    modelInvocable: true,
  };
  return resolveEffectiveSkills([
    {
      scopeRank,
      providerId,
      privateLocator,
      skillId: createSkillIdentity({ scopeRank, providerId, privateLocator }),
      bundleRevision: createSkillBundleRevision(manifest),
      manifest,
    },
  ]);
}
