import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundaries,
  migrationMap,
  rules,
  scanner,
  type BaselineEntry,
  type BoundaryCheckResult,
  type EvaluatedScan,
  type LegacyMigrationEntry,
} from "./support/architecture-checker.js";
import {
  createFixtureWorkspace,
  v2WorkspaceSpec,
  type FixtureProjectSpec,
} from "./support/fixture-workspace.js";
import { repositoryRoot } from "./support/workspace.js";

const FIXED_HEAD = "0000000000000000000000000000000000000000";
const FIXED_TIME = "2026-09-12T00:00:00.000Z";
/**
 * Every test that runs the real checker against a real fixture repository spawns
 * several `git` processes and walks the whole fixture tree. Under a full
 * `pnpm test` run those spawns queue behind hundreds of other test files, so the
 * Vitest default of 5s is not enough. The generous bound is a scheduling
 * allowance, not a hidden wait: a passing run finishes in well under a second.
 */
const GIT_TEST_TIMEOUT_MS = 60_000;
const CHECKED_IN_BASELINE_PATH = path.join(
  repositoryRoot,
  "scripts",
  "architecture",
  "legacy-import-baseline.json",
);
const CHECKER_PATH = path.join(repositoryRoot, "scripts", "architecture", "check-boundaries.mjs");

const openFixtures: Awaited<ReturnType<typeof createFixtureWorkspace>>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openFixtures.splice(0).map((open) => open.cleanup()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  specs: Record<string, FixtureProjectSpec>,
): Promise<Awaited<ReturnType<typeof createFixtureWorkspace>>> {
  const workspace = await createFixtureWorkspace(specs);
  openFixtures.push(workspace);
  return workspace;
}

function baselinePathOf(root: string): string {
  return path.join(root, "legacy-import-baseline.json");
}

function check(
  root: string,
  options: {
    writeBaseline?: boolean;
    verifyBaseline?: boolean;
    acceptRuleExpansion?: boolean;
    baselineSourceCommit?: string;
    env?: Record<string, string | undefined>;
    baselinePath?: string;
  } = {},
): Promise<BoundaryCheckResult> {
  // The expansion protocol reads real git provenance from the scan root, so an
  // explicit gitHead override is only applied to the tests that do not exercise
  // it. Tests that pin a baseline source commit must let the tool read HEAD.
  const provenanceOverrides =
    options.baselineSourceCommit === undefined
      ? { gitHead: FIXED_HEAD, gitHeadDate: FIXED_TIME }
      : { gitHeadDate: FIXED_TIME };

  return boundaries.runBoundaryCheck({
    root,
    baselinePath: options.baselinePath ?? baselinePathOf(root),
    writeBaseline: options.writeBaseline === true,
    verifyBaseline: options.verifyBaseline === true,
    acceptRuleExpansion: options.acceptRuleExpansion === true,
    baselineSourceCommit: options.baselineSourceCommit,
    ...provenanceOverrides,
    env: options.env ?? {},
  });
}

function rulesOf(evaluated: EvaluatedScan): string[] {
  return evaluated.violations.map((violation) => violation.rule).sort();
}

/** Initialize a git repository for a fixture and return its first commit. */
async function gitFixture(
  specs: Record<string, FixtureProjectSpec>,
): Promise<{ workspace: Awaited<ReturnType<typeof createFixtureWorkspace>>; base: string }> {
  const workspace = await fixture(specs);
  const base = await workspace.git.init();
  return { workspace, base };
}

describe("architecture v2 target allowlist derivation", () => {
  it("derives the forbidden target graph from the allowlist with no hand-written list", () => {
    const targets = rules.V2_TARGET_PACKAGES;
    const forbidden = rules.deriveForbiddenTargetEdges();
    const forbiddenKeys = new Set(forbidden.map((edge) => `${edge.from}->${edge.to}`));

    expect(targets).toHaveLength(7);
    expect(forbidden.length).toBeGreaterThan(0);

    for (const from of targets) {
      for (const to of targets) {
        if (from === to) continue;
        const allowed = rules.isAllowedTargetEdge(from, to);
        expect(forbiddenKeys.has(`${from}->${to}`), `${from}->${to}`).toBe(!allowed);
      }
    }
  });

  it("declares the frozen allowed graph exactly as the specification states", () => {
    expect(rules.V2_ALLOWED_DEPENDENCIES).toEqual({
      ai: [],
      protocol: [],
      agent: ["ai", "protocol"],
      runtime: ["protocol"],
      "coding-agent": ["ai", "protocol", "agent", "runtime"],
      storage: ["agent", "protocol"],
      client: ["protocol"],
    });
  });

  it("grants no target an implicit dependency on protocol", () => {
    // Phase 1B factored protocol into a "universal targets" list, which silently
    // made ai -> protocol legal. @caelush/ai is an independent AI root package,
    // so the grant is gone and protocol is listed explicitly per package.
    expect("V2_UNIVERSAL_TARGETS" in rules).toBe(false);

    for (const target of rules.V2_TARGET_PACKAGES) {
      const allowlist = rules.V2_ALLOWED_DEPENDENCIES[target] ?? [];
      const dependsOnProtocol = rules.isAllowedTargetEdge(target, "protocol");
      expect(dependsOnProtocol, `${target}->protocol`).toBe(allowlist.includes("protocol"));
    }

    // Exactly the frozen five may depend on protocol; ai and protocol may not.
    const protocolConsumers = rules.V2_TARGET_PACKAGES.filter((target) =>
      rules.isAllowedTargetEdge(target, "protocol"),
    );
    expect([...protocolConsumers].sort()).toEqual([
      "agent",
      "client",
      "coding-agent",
      "runtime",
      "storage",
    ]);
  });

  it("keeps the allowlist and the machine rules consistent for every pair", () => {
    for (const from of rules.V2_TARGET_PACKAGES) {
      for (const to of rules.V2_TARGET_PACKAGES) {
        if (from === to) continue;
        const allowed = rules.isAllowedTargetEdge(from, to);
        expect(Boolean(rules.findRule("source-import", from, to)), `${from}->${to}`).toBe(!allowed);
        expect(Boolean(rules.findRule("package-manifest", from, to)), `${from}->${to}`).toBe(
          !allowed,
        );
      }
    }
  });

  it("forbids target edges the Phase 1A hand-written list never expressed", () => {
    const cases = [
      ["client", "ai"],
      ["runtime", "ai"],
      ["storage", "coding-agent"],
      ["storage", "runtime"],
      ["protocol", "ai"],
      ["protocol", "agent"],
      ["ai", "protocol"],
    ] as const;

    for (const [from, to] of cases) {
      expect(rules.isAllowedTargetEdge(from, to), `${from}->${to}`).toBe(false);
      expect(rules.findRule("source-import", from, to)?.kind, `${from}->${to}`).toBe(
        "target-graph",
      );
      expect(rules.findRule("package-manifest", from, to)?.kind, `${from}->${to}`).toBe(
        "package-manifest",
      );
    }
  });

  it(
    "fails ai importing protocol, agent or runtime, and passes the frozen protocol consumers",
    async () => {
      const illegal = await fixture(
        v2WorkspaceSpec({
          "packages/ai": {
            source: {
              "index.ts": [
                'import "@caelush/protocol";',
                'import "@caelush/agent";',
                'import "@caelush/runtime";',
                "export {};",
              ].join("\n"),
            },
          },
        }),
      );

      const aiEvaluated = boundaries.evaluateScan(await scanner.scanWorkspace(illegal.root));
      expect(rulesOf(aiEvaluated)).toEqual([
        "AI_MUST_NOT_DEPEND_ON_AGENT",
        "AI_MUST_NOT_DEPEND_ON_PROTOCOL",
        "AI_MUST_NOT_DEPEND_ON_RUNTIME",
      ]);
      for (const violation of aiEvaluated.violations) {
        expect(violation.edgeClass).toBe("target-graph");
      }

      // The same workspace also declares ai -> protocol in its manifest, which is
      // the package-level half of the same drift.
      const manifestIllegal = await fixture(
        v2WorkspaceSpec({
          "packages/ai": {
            source: { "index.ts": "export {};\n" },
            dependencies: { "@caelush/protocol": "workspace:*" },
          },
        }),
      );

      const manifestEvaluated = boundaries.evaluateScan(
        await scanner.scanWorkspace(manifestIllegal.root),
      );
      expect(rulesOf(manifestEvaluated)).toEqual(["AI_MUST_NOT_DECLARE_DEPENDENCY_ON_PROTOCOL"]);

      // Every frozen protocol consumer stays legal, in both layers.
      const legal = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: {
              "index.ts": 'import "@caelush/ai";\nimport "@caelush/protocol";\nexport {};\n',
            },
            dependencies: { "@caelush/ai": "workspace:*", "@caelush/protocol": "workspace:*" },
          },
          "packages/runtime": {
            source: { "index.ts": 'import "@caelush/protocol";\nexport {};\n' },
            dependencies: { "@caelush/protocol": "workspace:*" },
          },
          "packages/coding-agent": {
            source: {
              "index.ts": [
                'import "@caelush/ai";',
                'import "@caelush/protocol";',
                'import "@caelush/agent";',
                'import "@caelush/runtime";',
                "export {};",
              ].join("\n"),
            },
            dependencies: {
              "@caelush/ai": "workspace:*",
              "@caelush/protocol": "workspace:*",
              "@caelush/agent": "workspace:*",
              "@caelush/runtime": "workspace:*",
            },
          },
          "packages/storage": {
            source: {
              "index.ts": 'import "@caelush/agent";\nimport "@caelush/protocol";\nexport {};\n',
            },
            dependencies: { "@caelush/agent": "workspace:*", "@caelush/protocol": "workspace:*" },
          },
          "packages/client": {
            source: { "index.ts": 'import "@caelush/protocol";\nexport {};\n' },
            dependencies: { "@caelush/protocol": "workspace:*" },
          },
        }),
      );

      expect(boundaries.evaluateScan(await scanner.scanWorkspace(legal.root)).violations).toEqual(
        [],
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails every protocol subpath, source and manifest, because protocol must depend on nothing",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/protocol": {
            source: {
              "index.ts": [
                'import "@caelush/ai";',
                'import "@caelush/agent";',
                'import "@caelush/runtime";',
                'import "@caelush/storage";',
                'import "@caelush/coding-agent";',
                'import "@caelush/client";',
                "export {};",
              ].join("\n"),
            },
            dependencies: { "@caelush/ai": "workspace:*" },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      expect(rulesOf(evaluated)).toEqual([
        "PROTOCOL_MUST_NOT_DECLARE_DEPENDENCY_ON_AI",
        "PROTOCOL_MUST_NOT_DEPEND_ON_AGENT",
        "PROTOCOL_MUST_NOT_DEPEND_ON_AI",
        "PROTOCOL_MUST_NOT_DEPEND_ON_CLIENT",
        "PROTOCOL_MUST_NOT_DEPEND_ON_CODING_AGENT",
        "PROTOCOL_MUST_NOT_DEPEND_ON_RUNTIME",
        "PROTOCOL_MUST_NOT_DEPEND_ON_STORAGE",
      ]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it("keeps every rule id unique and reports the derived counts", () => {
    expect(new Set(rules.RULE_IDS).size).toBe(rules.RULE_IDS.length);
    expect(rules.RULE_SET_VERSION).toBe(2);
    expect(rules.PHASE_1A_RULE_SET_VERSION).toBe(1);
    expect(rules.PHASE_1A_FINAL_COMMIT).toMatch(/^[0-9a-f]{40}$/u);

    // Each forbidden edge is enforced once per layer.
    expect(rules.DEPENDENCY_RULES).toHaveLength(
      (rules.deriveForbiddenTargetEdges().length +
        rules.deriveForbiddenTargetToLegacyEdges().length +
        rules.deriveForbiddenTargetToHostEdges().length +
        rules.deriveForbiddenHostEdges().length) *
        2,
    );
  });
});

describe("architecture v2 target to legacy prohibition", () => {
  it("lists every legacy package that Architecture V2 does not keep", () => {
    expect(rules.V2_LEGACY_PACKAGES).toEqual([
      "llm",
      "core",
      "context",
      "tools",
      "security",
      "verification",
      "memory",
      "events",
      "shared",
      "observability",
    ]);
    for (const legacy of rules.V2_LEGACY_PACKAGES) {
      expect(rules.packageRole(legacy)).toBe("legacy");
    }
  });

  it("forbids every target to legacy pair in both layers", () => {
    const edges = rules.deriveForbiddenTargetToLegacyEdges();
    expect(edges).toHaveLength(rules.V2_TARGET_PACKAGES.length * rules.V2_LEGACY_PACKAGES.length);

    for (const { from, to } of edges) {
      expect(rules.findRule("source-import", from, to)?.kind, `${from}->${to}`).toBe(
        "target-to-legacy",
      );
      const manifestRule = rules.findRule("package-manifest", from, to);
      expect(manifestRule?.kind, `${from}->${to} manifest`).toBe("package-manifest");
    }
  });

  it("forbids every target to host pair, restoring the Phase 1A daemon rules", () => {
    const edges = rules.deriveForbiddenTargetToHostEdges();
    expect(edges).toHaveLength(rules.V2_TARGET_PACKAGES.length * 4);

    for (const { from, to } of edges) {
      expect(rules.findRule("source-import", from, to)?.kind, `${from}->${to}`).toBe(
        "target-to-host",
      );
    }
    // The four edges Phase 1A enforced explicitly must survive the refactor.
    for (const from of ["protocol", "agent", "runtime", "coding-agent"]) {
      expect(rules.findRule("source-import", from, "daemon")?.kind, `${from}->daemon`).toBe(
        "target-to-host",
      );
    }
  });

  it(
    "fails a target package that imports a legacy package from source",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/ai": {
            source: { "index.ts": 'import { LLMMessage } from "@caelush/llm";\nexport {};\n' },
          },
          "packages/agent": {
            source: { "index.ts": 'import { RunController } from "@caelush/core";\nexport {};\n' },
          },
          "packages/coding-agent": {
            source: {
              "index.ts": 'import { ToolDispatcher } from "@caelush/tools";\nexport {};\n',
            },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      const found = evaluated.violations.map(
        (violation) =>
          `${violation.sourcePackage}->${violation.targetPackage}:${violation.edgeClass}`,
      );

      expect(found).toEqual(
        expect.arrayContaining([
          "ai->llm:target-to-legacy",
          "agent->core:target-to-legacy",
          "coding-agent->tools:target-to-legacy",
        ]),
      );
      expect(rulesOf(evaluated)).toEqual(
        expect.arrayContaining([
          "AI_MUST_NOT_DEPEND_ON_LLM",
          "AGENT_MUST_NOT_DEPEND_ON_CORE",
          "CODING_AGENT_MUST_NOT_DEPEND_ON_TOOLS",
        ]),
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails a target package that declares a legacy workspace dependency",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: { "index.ts": "export {};\n" },
            dependencies: { "@caelush/core": "workspace:*" },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));

      expect(evaluated.violations).toHaveLength(1);
      expect(evaluated.violations[0]?.rule).toBe("AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_CORE");
      expect(evaluated.violations[0]?.kind).toBe("package-manifest");
      expect(evaluated.violations[0]?.edgeClass).toBe("package-manifest");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "still allows the legal migration direction legacy to target",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/llm": {
            source: { "index.ts": 'export { complete } from "@caelush/ai";\n' },
            dependencies: { "@caelush/ai": "workspace:*" },
          },
          "packages/core": {
            source: { "index.ts": 'export { AgentLoop } from "@caelush/agent";\n' },
            dependencies: { "@caelush/agent": "workspace:*" },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      expect(evaluated.violations).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "allows every legal target to target direction and rejects every illegal one",
    async () => {
      const legalSpec: Record<string, FixtureProjectSpec> = {
        "packages/agent": {
          source: {
            "index.ts": 'import "@caelush/ai";\nimport "@caelush/protocol";\nexport {};\n',
          },
        },
        "packages/runtime": { source: { "index.ts": 'import "@caelush/protocol";\nexport {};\n' } },
        "packages/coding-agent": {
          source: {
            "index.ts": [
              'import "@caelush/ai";',
              'import "@caelush/protocol";',
              'import "@caelush/agent";',
              'import "@caelush/runtime";',
              "export {};",
            ].join("\n"),
          },
        },
        "packages/storage": {
          source: {
            "index.ts": 'import "@caelush/agent";\nimport "@caelush/protocol";\nexport {};\n',
          },
        },
        "packages/client": { source: { "index.ts": 'import "@caelush/protocol";\nexport {};\n' } },
      };

      const legal = await fixture(v2WorkspaceSpec(legalSpec));
      expect(boundaries.evaluateScan(await scanner.scanWorkspace(legal.root)).violations).toEqual(
        [],
      );

      const illegalSpec: Record<string, FixtureProjectSpec> = {
        "packages/protocol": { source: { "index.ts": 'import "@caelush/ai";\nexport {};\n' } },
        "packages/runtime": { source: { "index.ts": 'import "@caelush/ai";\nexport {};\n' } },
        "packages/storage": { source: { "index.ts": 'import "@caelush/runtime";\nexport {};\n' } },
        "packages/client": { source: { "index.ts": 'import "@caelush/ai";\nexport {};\n' } },
      };

      const illegal = await fixture(v2WorkspaceSpec(illegalSpec));
      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(illegal.root));
      expect(rulesOf(evaluated)).toEqual([
        "CLIENT_MUST_NOT_DEPEND_ON_AI",
        "PROTOCOL_MUST_NOT_DEPEND_ON_AI",
        "RUNTIME_MUST_NOT_DEPEND_ON_AI",
        "STORAGE_MUST_NOT_DEPEND_ON_RUNTIME",
      ]);
      for (const violation of evaluated.violations) {
        expect(violation.edgeClass).toBe("target-graph");
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("architecture v2 legacy migration map", () => {
  it("gives every declared legacy package exactly one migration entry", () => {
    const mapped = migrationMap.LEGACY_MIGRATION_MAP.map((entry) => entry.legacyPackage).sort();
    expect(mapped).toEqual([...rules.V2_LEGACY_PACKAGES].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it("gives every legacy package at least one destination or an explicit DELETE", () => {
    for (const entry of migrationMap.LEGACY_MIGRATION_MAP) {
      const hasDestinations = entry.destinations.length > 0;
      const deletes = entry.operations.includes("DELETE");
      expect(
        hasDestinations || deletes,
        `${entry.legacyPackage} has neither a destination nor DELETE`,
      ).toBe(true);
      if (!hasDestinations) {
        expect(entry.primaryOperation, `${entry.legacyPackage} primary operation`).toBe("DELETE");
      }
    }
  });

  it("restricts every destination to a target package, the daemon, or DELETE", () => {
    const allowedDestinations = new Set([
      ...rules.V2_TARGET_PACKAGES,
      ...rules.V2_HOST_APPS,
      migrationMap.MIGRATION_DELETE,
    ]);

    for (const entry of migrationMap.LEGACY_MIGRATION_MAP) {
      for (const destination of entry.destinations) {
        expect(
          allowedDestinations.has(destination),
          `${entry.legacyPackage} -> ${destination}`,
        ).toBe(true);
        expect(rules.packageRole(destination)).not.toBe("legacy");
      }
      for (const guide of entry.splitGuide ?? []) {
        expect(
          allowedDestinations.has(guide.destination),
          `${entry.legacyPackage} guide -> ${guide.destination}`,
        ).toBe(true);
        expect(rules.packageRole(guide.destination)).not.toBe("legacy");
      }
    }
  });

  it("never puts a target package on the legacy side of the map", () => {
    for (const target of rules.V2_TARGET_PACKAGES) {
      expect(
        migrationMap.migrationEntryFor(target),
        `${target} must not be a legacy migration source`,
      ).toBeUndefined();
    }
  });

  it("keeps every migration operation inside the declared vocabulary", () => {
    for (const entry of migrationMap.LEGACY_MIGRATION_MAP) {
      expect(migrationMap.MIGRATION_OPERATIONS).toContain(entry.primaryOperation);
      expect(entry.operations.length).toBeGreaterThan(0);
      for (const operation of entry.operations) {
        expect(migrationMap.MIGRATION_OPERATIONS, `${entry.legacyPackage} ${operation}`).toContain(
          operation,
        );
      }
      expect(entry.rationale.length).toBeGreaterThan(20);
    }
  });

  it("records the specification destinations for the ten legacy packages", () => {
    const expected: Record<string, { destinations: string[]; operations: string[] }> = {
      llm: { destinations: ["ai"], operations: ["MOVE", "ADAPT", "FACADE"] },
      core: { destinations: ["agent"], operations: ["MOVE", "EXTRACT"] },
      context: { destinations: ["agent", "coding-agent"], operations: ["SPLIT"] },
      tools: { destinations: ["agent", "coding-agent"], operations: ["SPLIT"] },
      security: { destinations: ["agent", "coding-agent", "runtime"], operations: ["SPLIT"] },
      verification: { destinations: ["agent", "coding-agent"], operations: ["SPLIT"] },
      memory: { destinations: ["agent"], operations: ["MOVE", "ADAPT"] },
      events: { destinations: ["agent", "storage", "daemon"], operations: ["SPLIT"] },
      shared: { destinations: ["runtime", "coding-agent"], operations: ["SPLIT", "DELETE"] },
      observability: { destinations: [], operations: ["DELETE"] },
    };

    for (const [legacyPackage, want] of Object.entries(expected)) {
      const entry = migrationMap.migrationEntryFor(legacyPackage) as LegacyMigrationEntry;
      expect(entry, legacyPackage).toBeDefined();
      expect(entry.destinations, `${legacyPackage} destinations`).toEqual(want.destinations);
      expect([...entry.operations].sort(), `${legacyPackage} operations`).toEqual(
        [...want.operations].sort() as LegacyMigrationEntry["operations"],
      );
    }
  });

  it("marks observability and shared as DELETE destinations", () => {
    expect(migrationMap.deletedLegacyPackages()).toEqual(["observability", "shared"]);
    expect(migrationMap.migrationEntryFor("observability")?.primaryOperation).toBe("DELETE");
    expect(migrationMap.migrationEntryFor("shared")?.operations).toContain("DELETE");
  });

  it("exposes every destination named anywhere in the map", () => {
    const destinations = migrationMap.allMigrationDestinations();
    expect(destinations).toEqual([...destinations].sort());
    for (const destination of destinations) {
      expect(["DELETE", ...rules.V2_TARGET_PACKAGES, ...rules.V2_HOST_APPS]).toContain(destination);
    }
  });

  it("keeps the migration map distinct from the dependency allowlist", () => {
    // tools -> runtime exists today; that must not make runtime a target that the
    // future agent tool framework may depend on, and it must not keep
    // @caelush/tools alive.
    expect(rules.findRule("source-import", "tools", "runtime")).toBeUndefined();
    expect(rules.packageRole("tools")).toBe("legacy");
    expect(migrationMap.migrationEntryFor("tools")?.destinations).not.toContain("runtime");
  });
});

describe("architecture v2 public boundary guard", () => {
  it("splits a Caelush specifier into its package and subpath", () => {
    expect(scanner.splitCaelushSpecifier("@caelush/llm")).toEqual({
      packageName: "@caelush/llm",
      subpath: ".",
    });
    expect(scanner.splitCaelushSpecifier("@caelush/llm/messages")).toEqual({
      packageName: "@caelush/llm",
      subpath: "./messages",
    });
    expect(scanner.splitCaelushSpecifier("@caelush/agent/src/internal/foo")).toEqual({
      packageName: "@caelush/agent",
      subpath: "./src/internal/foo",
    });
    expect(scanner.splitCaelushSpecifier("zod")).toBeUndefined();
  });

  it("recognises declared, undeclared and wildcard export subpaths", () => {
    const declarations = [
      { subpath: ".", target: "./dist/index.js" },
      { subpath: "./messages", target: "./dist/messages.js" },
      { subpath: "./features/*", target: "./dist/features/*.js" },
    ];

    expect(scanner.exportsDeclareSubpath(declarations, ".")).toBe(true);
    expect(scanner.exportsDeclareSubpath(declarations, "./messages")).toBe(true);
    expect(scanner.exportsDeclareSubpath(declarations, "./features/alpha")).toBe(true);
    expect(scanner.exportsDeclareSubpath(declarations, "./not-exported")).toBe(false);
    expect(scanner.exportsDeclareSubpath(declarations, "./features/")).toBe(false);
    expect(
      scanner.exportsDeclareSubpath([{ subpath: ".", target: "./index.js" }], "./messages"),
    ).toBe(false);
  });

  it(
    "fails an import that enters another package through src",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: {
              "index.ts": 'import { x } from "@caelush/protocol/src/internal/foo";\nexport {};\n',
            },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      const privateImport = evaluated.violations.find(
        (violation) => violation.kind === "private-import",
      );

      expect(privateImport).toBeDefined();
      expect(privateImport?.rule).toBe("PACKAGE_MUST_NOT_BE_IMPORTED_THROUGH_SRC");
      expect(privateImport?.edgeClass).toBe("private-import");
      expect(privateImport?.subpath).toBe("./src/internal/foo");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails an undeclared package subpath and allows a declared one",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/llm": {
            source: { "index.ts": "export {};\n" },
            exports: {
              ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
              "./messages": { types: "./dist/messages.d.ts", import: "./dist/messages.js" },
            },
          },
          "packages/core": {
            source: {
              "index.ts": [
                'import { a } from "@caelush/llm/messages";',
                'import { b } from "@caelush/llm/not-exported";',
                "export {};",
              ].join("\n"),
            },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      const privateImports = evaluated.violations.filter(
        (violation) => violation.kind === "private-import",
      );

      expect(privateImports).toHaveLength(1);
      expect(privateImports[0]?.specifier).toBe("@caelush/llm/not-exported");
      expect(privateImports[0]?.rule).toBe("PACKAGE_SUBPATH_MUST_BE_DECLARED_IN_EXPORTS");
      expect(privateImports[0]?.sourcePackage).toBe("core");
      expect(privateImports[0]?.targetPackage).toBe("llm");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "allows every declared public subpath and never flags the package root",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/llm": {
            source: { "index.ts": "export {};\n" },
            exports: {
              ".": { import: "./dist/index.js" },
              "./messages": { import: "./dist/messages.js" },
              "./turn": { import: "./dist/turn.js" },
              "./request": { import: "./dist/request.js" },
              "./errors": { import: "./dist/errors.js" },
            },
          },
          "packages/core": {
            source: {
              "index.ts": [
                'import "@caelush/llm";',
                'import "@caelush/llm/messages";',
                'import "@caelush/llm/turn";',
                'import "@caelush/llm/request";',
                'import "@caelush/llm/errors";',
                "export {};",
              ].join("\n"),
            },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      expect(
        evaluated.violations.filter((violation) => violation.kind === "private-import"),
      ).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the unmigrated Architecture V2 skeletons on a root-only export surface",
    async () => {
      const scan = await scanner.scanWorkspace(repositoryRoot);
      for (const identity of ["agent", "coding-agent"]) {
        const project = scan.projects.find((entry) => entry.identity === identity);
        expect(project, identity).toBeDefined();
        expect(project?.exportDeclarations.map((declaration) => declaration.subpath)).toEqual([
          ".",
        ]);
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the migrated AI core on exactly the surface the migration earned",
    async () => {
      // Phase 2A migrated the AI Model Invocation core and Phase 2B added the
      // OpenAI-compatible adapter subpath. `ai` is no longer a surface-locked
      // skeleton, and the exact list is asserted so its public surface can never
      // widen by accident.
      const scan = await scanner.scanWorkspace(repositoryRoot);
      const project = scan.projects.find((entry) => entry.identity === "ai");
      expect(project).toBeDefined();
      expect(project?.exportDeclarations.map((declaration) => declaration.subpath).sort()).toEqual([
        ".",
        "./adapters",
        "./adapters/openai-compatible",
        "./errors",
        "./messages",
        "./models",
        "./providers",
        "./request",
        "./stream",
      ]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the migrated AI core free of every Caelush dependency",
    async () => {
      const scan = await scanner.scanWorkspace(repositoryRoot);
      const project = scan.projects.find((entry) => entry.identity === "ai");
      expect(project).toBeDefined();
      expect(
        (project?.manifestDependencies ?? [])
          .map((dependency) => dependency.name)
          .filter((name) => name.startsWith("@caelush/")),
      ).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails a relative import that crosses a workspace project boundary",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: {
              "index.ts": 'import { x } from "../../protocol/src/index.js";\nexport {};\n',
            },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      const crossing = evaluated.violations.find(
        (violation) => violation.kind === "cross-workspace-relative-import",
      );

      expect(crossing).toBeDefined();
      expect(crossing?.rule).toBe("PACKAGE_MUST_NOT_IMPORT_ANOTHER_PROJECT_BY_RELATIVE_PATH");
      expect(crossing?.sourcePackage).toBe("agent");
      expect(crossing?.targetPackage).toBe("protocol");
      expect(crossing?.specifier).toBe("../../protocol/src/index.js");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "allows a relative import inside the same package",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: {
              "index.ts": 'import { x } from "./internal/foo.js";\nexport {};\n',
              "internal/foo.ts": "export const x = 1;\n",
            },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      expect(
        evaluated.violations.filter(
          (violation) => violation.kind === "cross-workspace-relative-import",
        ),
      ).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "reports no private import in the real repository source scope",
    async () => {
      const scan = await scanner.scanWorkspace(repositoryRoot);
      expect(scan.privateImports).toEqual([]);
      expect(scan.crossWorkspaceRelativeImports).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("architecture v2 rule set expansion protocol", () => {
  /** A workspace with target-to-legacy violations that predate Phase 1B rules. */
  function expansionSpec(): Record<string, FixtureProjectSpec> {
    return v2WorkspaceSpec({
      "packages/storage": {
        source: { "index.ts": 'import type { Run } from "@caelush/core";\nexport {};\n' },
        dependencies: { "@caelush/core": "workspace:*" },
      },
    });
  }

  it(
    "refuses a growing write without the expansion opt-in",
    async () => {
      const workspace = await fixture(expansionSpec());

      const result = await check(workspace.root, { writeBaseline: true });

      expect(result.exitCode).toBe(1);
      expect(result.summary.refused).toBe("expansion-not-accepted");
      expect(result.output).toContain("Architecture V2 baseline write refused");
      await expect(readFile(baselinePathOf(workspace.root), "utf8")).rejects.toThrow(/ENOENT/u);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "refuses the expansion opt-in without a baseline source commit",
    async () => {
      const workspace = await fixture(expansionSpec());

      const result = await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.refused).toBe("missing-baseline-source-commit");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "refuses the expansion when HEAD is not the baseline source commit",
    async () => {
      const { workspace, base } = await gitFixture(expansionSpec());

      const result = await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
        baselineSourceCommit: FIXED_HEAD,
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.refused).toBe("baseline-source-commit-mismatch");
      expect(result.output).toContain(base);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "refuses the expansion when the scanned paths are not committed",
    async () => {
      const { workspace, base } = await gitFixture(expansionSpec());

      await writeFile(
        workspace.projectPath("packages/storage/src/later.ts"),
        'import type { Run } from "@caelush/core";\nexport {};\n',
        "utf8",
      );

      const result = await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
        baselineSourceCommit: base,
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.refused).toBe("scanned-paths-not-committed");
      expect(result.output).toContain("packages/storage/src/later.ts");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "admits a violation that provably already existed at the baseline source commit",
    async () => {
      const { workspace, base } = await gitFixture(expansionSpec());

      const result = await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
        baselineSourceCommit: base,
      });

      expect(result.exitCode).toBe(0);
      expect(result.summary.entries).toBe(2);

      const document = JSON.parse(await readFile(baselinePathOf(workspace.root), "utf8"));
      expect(document.ruleSetVersion).toBe(2);
      expect(document.baselineSourceCommit).toBe(base);
      expect(document.generatedByRuleExpansion).toBe(true);
      expect(document.entryCount).toBe(2);

      const followUp = await check(workspace.root, { verifyBaseline: true });
      expect(followUp.exitCode).toBe(0);
      expect(followUp.summary.matchedLegacyViolations).toBe(2);
      expect(followUp.summary.newViolations).toBe(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "refuses to admit a violation created after the frozen baseline commit",
    async () => {
      const { workspace, base } = await gitFixture(expansionSpec());
      await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
        baselineSourceCommit: base,
      });
      const frozen = await readFile(baselinePathOf(workspace.root), "utf8");

      // New debt lands after the frozen commit and is committed, so the tree is
      // clean and HEAD equals the new commit.
      await writeFile(
        workspace.projectPath("packages/storage/src/later.ts"),
        'import type { Run } from "@caelush/memory";\nexport {};\n',
        "utf8",
      );
      await workspace.git.commitAll("add later debt");

      // Expanding at the frozen commit is impossible now: HEAD moved.
      const refused = await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
        baselineSourceCommit: base,
      });
      expect(refused.exitCode).toBe(1);
      expect(refused.summary.refused).toBe("baseline-source-commit-mismatch");
      expect(await readFile(baselinePathOf(workspace.root), "utf8")).toBe(frozen);

      // Expanding at the new commit is honest about what it admits, and warns
      // that the pin is no longer the Phase 1A commit. The debt stays visible in
      // the baseline diff, which is the property that matters: the protocol can
      // never make a violation vanish, only grandfather it explicitly.
      const later = await workspace.git.head();
      const rePinned = await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
        baselineSourceCommit: later,
      });

      expect(rePinned.exitCode).toBe(0);
      expect(rePinned.summary.growthAudit).toContain("WARNING");
      expect(rePinned.summary.growthAudit).toContain("may include debt that landed after Phase 1A");

      const after = JSON.parse(await readFile(baselinePathOf(workspace.root), "utf8"));
      expect(after.baselineSourceCommit).toBe(later);
      expect(after.entryCount).toBeGreaterThan(JSON.parse(frozen).entryCount);

      const checked = await check(workspace.root);
      expect(checked.exitCode).toBe(0);
      expect(checked.summary.staleBaselineEntries).toBe(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails the check for debt that is not in the frozen baseline",
    async () => {
      const { workspace, base } = await gitFixture(expansionSpec());
      await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
        baselineSourceCommit: base,
      });

      await writeFile(
        workspace.projectPath("packages/storage/src/later.ts"),
        'import type { Run } from "@caelush/memory";\nexport {};\n',
        "utf8",
      );

      const result = await check(workspace.root);
      expect(result.exitCode).toBe(1);
      expect(result.summary.newViolations).toBe(1);
      expect(result.output).toContain("STORAGE_MUST_NOT_DEPEND_ON_MEMORY");
      expect(result.output).toContain("Class:\ntarget-to-legacy");
      expect(result.output).toContain("Status:\nNEW_VIOLATION");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "never grows the baseline from CI, even with the expansion flags",
    async () => {
      const { workspace, base } = await gitFixture(expansionSpec());

      const result = await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
        baselineSourceCommit: base,
        env: { CI: "true" },
      });

      // CI is refused outright: a baseline growth is a deliberate local act that
      // a human reviews and commits, so the pipeline never produces one.
      expect(result.exitCode).toBe(1);
      expect(result.summary.written).toBe(false);
      expect(result.summary.refused).toBe("ci-baseline-growth");
      expect(result.output).toContain("CI never grows the baseline");
      await expect(readFile(baselinePathOf(workspace.root), "utf8")).rejects.toThrow(/ENOENT/u);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the shrink-only ratchet after the expansion",
    async () => {
      const { workspace, base } = await gitFixture(expansionSpec());
      await check(workspace.root, {
        writeBaseline: true,
        acceptRuleExpansion: true,
        baselineSourceCommit: base,
      });

      // Remove the source import but leave the manifest dependency: one entry
      // becomes stale and must fail.
      await writeFile(
        workspace.projectPath("packages/storage/src/index.ts"),
        "export {};\n",
        "utf8",
      );

      const stale = await check(workspace.root);
      expect(stale.exitCode).toBe(1);
      expect(stale.summary.staleBaselineEntries).toBe(1);
      expect(stale.output).toContain("Architecture V2 stale baseline entry");

      // Shrinking is allowed without any expansion flag.
      const shrunk = await check(workspace.root, { writeBaseline: true });
      expect(shrunk.exitCode).toBe(0);
      expect(shrunk.summary.entries).toBe(1);
      expect(JSON.parse(await readFile(baselinePathOf(workspace.root), "utf8")).entryCount).toBe(1);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("architecture v2 baseline expansion audit", () => {
  it(
    "admits only additions that exist on the frozen tree",
    async () => {
      const { workspace, base } = await gitFixture(
        v2WorkspaceSpec({
          "packages/storage": {
            source: { "index.ts": 'import type { Run } from "@caelush/core";\nexport {};\n' },
          },
        }),
      );

      const scan = await scanner.scanWorkspace(workspace.root);
      const audit = await boundaries.auditBaselineGrowth(
        baselinePathOf(workspace.root),
        boundaries.evaluateScan(scan),
        {
          acceptRuleExpansion: true,
          baselineSourceCommit: base,
          root: workspace.root,
        },
      );

      expect(audit.grows).toBe(true);
      expect(audit.admitted).toBe(true);
      expect(audit.additions).toHaveLength(1);
      expect(audit.detail).toContain("committed at");
      expect(audit.detail).toContain("rule set version 1 -> 2");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "reports the newly enforced rules separately from the Phase 1A rules",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/storage": {
            source: { "index.ts": 'import type { Run } from "@caelush/core";\nexport {};\n' },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      const expansionIds = new Set(boundaries.expansionRuleIds());

      expect(expansionIds.has("STORAGE_MUST_NOT_DEPEND_ON_CORE")).toBe(true);
      expect(boundaries.PHASE_1A_FROZEN_RULE_IDS).not.toContain("STORAGE_MUST_NOT_DEPEND_ON_CORE");
      expect(Boolean(rules.findRule("source-import", "storage", "core"))).toBe(true);
      for (const violation of evaluated.violations) {
        expect(expansionIds.has(violation.rule)).toBe(true);
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("architecture v2 repository baseline integration", () => {
  it(
    "ships an expanded rule-set-2 baseline pinned to the Phase 1A commit",
    async () => {
      const document = JSON.parse(await readFile(CHECKED_IN_BASELINE_PATH, "utf8"));

      expect(document.schemaVersion).toBe(1);
      expect(document.ruleSetVersion).toBe(2);
      expect(document.baselineSourceCommit).toBe(rules.PHASE_1A_FINAL_COMMIT);
      expect(document.generatedByRuleExpansion).toBe(true);
      expect(document.entryCount).toBe(document.entries.length);
      expect(document.entryCount).toBeGreaterThan(0);
      expect(document.expansionHistory).toEqual([
        {
          fromRuleSetVersion: 1,
          toRuleSetVersion: 2,
          sourceCommit: rules.PHASE_1A_FINAL_COMMIT,
        },
      ]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "records only target-to-legacy or manifest debt in the expanded baseline",
    async () => {
      const document = JSON.parse(await readFile(CHECKED_IN_BASELINE_PATH, "utf8"));
      const entries = document.entries as BaselineEntry[];
      const kinds = new Set(entries.map((entry) => entry.edgeClass as string));

      expect([...kinds].sort()).toEqual(["package-manifest", "target-to-legacy"]);
      expect([...new Set(entries.map((entry) => entry.sourcePackage))].sort()).toEqual([
        "runtime",
        "storage",
      ]);

      for (const entry of entries) {
        if (entry.kind === "package-manifest") {
          // storage's devDependency on runtime is target-to-target, which the
          // Phase 1B allowlist newly forbids and therefore baselines as well.
          expect(
            rules.isAllowedTargetEdge(entry.sourcePackage, entry.targetPackage),
            `${entry.sourcePackage}->${entry.targetPackage}`,
          ).toBe(false);
          continue;
        }
        expect(rules.packageRole(entry.sourcePackage), entry.sourcePath).toBe("target");
        expect(rules.packageRole(entry.targetPackage), entry.sourcePath).toBe("legacy");
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the checked-in baseline deterministic, sorted and LF-only",
    async () => {
      const raw = await readFile(CHECKED_IN_BASELINE_PATH, "utf8");
      const document = JSON.parse(raw);

      // Line endings are intentionally not asserted: git may check the file out
      // with CRLF depending on core.autocrlf, which would turn this into a
      // platform check rather than an architecture one.
      expect(raw.endsWith("\n") || raw.endsWith("\r\n")).toBe(true);
      expect(document.entries).toEqual(boundaries.sortBaselineEntries(document.entries));
      expect(new Set(document.entries.map(boundaries.baselineKey)).size).toBe(
        document.entries.length,
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "passes the repository architecture check and its verify mode",
    async () => {
      const document = JSON.parse(await readFile(CHECKED_IN_BASELINE_PATH, "utf8"));
      const result = await boundaries.runBoundaryCheck({
        root: repositoryRoot,
        verifyBaseline: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.summary.ruleSetVersion).toBe(2);
      expect(result.summary.newViolations).toBe(0);
      expect(result.summary.staleBaselineEntries).toBe(0);
      expect(result.summary.matchedLegacyViolations).toBe(document.entryCount);
      expect(result.output).toContain("Architecture V2 boundaries PASS");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "shrinks or preserves, never grows, a copy of the repository baseline",
    async () => {
      // The scan root must be the repository, but the regenerated file must never
      // be the checked-in baseline, so the write targets a throwaway copy.
      const scratch = await mkdtemp(path.join(tmpdir(), "caelush-baseline-copy-"));
      temporaryDirectories.push(scratch);
      const copy = path.join(scratch, "legacy-import-baseline.json");
      const before = await readFile(CHECKED_IN_BASELINE_PATH, "utf8");
      await writeFile(copy, before, "utf8");

      const result = await boundaries.runBoundaryCheck({
        root: repositoryRoot,
        baselinePath: copy,
        writeBaseline: true,
        env: {},
      });
      const after = await readFile(copy, "utf8");

      expect(result.exitCode).toBe(0);
      expect(result.summary.written).toBe(true);
      expect(JSON.parse(after).entryCount).toBe(JSON.parse(before).entryCount);
      expect(await readFile(CHECKED_IN_BASELINE_PATH, "utf8")).toBe(before);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "exposes the expansion flags through the command line",
    async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)(process.execPath, [CHECKER_PATH, "--help"], {
        cwd: repositoryRoot,
      });

      expect(stdout).toContain("--accept-rule-expansion");
      expect(stdout).toContain("--baseline-source-commit");
      expect(stdout).toContain("Rule set version: 2");
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
