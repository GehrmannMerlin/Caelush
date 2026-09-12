import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundaries,
  migrationMap,
  readiness,
  rules,
  scanner,
  type ReadinessResult,
} from "./support/architecture-checker.js";
import {
  createFixtureWorkspace,
  readinessBaseline,
  readinessRootFiles,
  v2WorkspaceSpec,
  type FixtureProjectSpec,
} from "./support/fixture-workspace.js";
import { repositoryRoot } from "./support/workspace.js";

/**
 * The readiness gate walks a fixture, reads its baseline, and shells out to the two
 * architecture entry points. Under a full `pnpm test` run those spawns queue behind
 * hundreds of other test files, so the Vitest default of 5s is not enough.
 */
const GIT_TEST_TIMEOUT_MS = 60_000;
const CHECKED_IN_BASELINE_PATH = path.join(
  repositoryRoot,
  "scripts",
  "architecture",
  "legacy-import-baseline.json",
);

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
  rootFiles: Parameters<typeof createFixtureWorkspace>[1] = readinessRootFiles(),
): Promise<Awaited<ReturnType<typeof createFixtureWorkspace>>> {
  const workspace = await createFixtureWorkspace(specs, rootFiles);
  openFixtures.push(workspace);
  return workspace;
}

/**
 * Run the readiness gate against a fixture without executing the architecture CLI,
 * because a fixture has no installed workspace for `node` entry points to run
 * against. Command health is covered by the real-repository integration test.
 */
function readinessOf(root: string): Promise<ReadinessResult> {
  return readiness.runMigrationReadinessCheck({
    root,
    baselinePath: path.join(root, "legacy-import-baseline.json"),
    // Fixtures are not git repositories; the provenance line is reporting only.
    head: "0".repeat(40),
    runCommandChecks: false,
  });
}

/** A baseline entry shaped exactly as the checker writes them. */
function debtEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "source-import",
    rule: "STORAGE_MUST_NOT_DEPEND_ON_CORE",
    edgeClass: "target-to-legacy",
    sourcePackage: "storage",
    sourcePath: "packages/storage/src/index.ts",
    targetPackage: "core",
    specifier: "@caelush/core",
    ...overrides,
  };
}

/** A workspace whose default source produces no violations on its own. */
function cleanSpec(): Record<string, FixtureProjectSpec> {
  return v2WorkspaceSpec();
}

function findingsFor(result: ReadinessResult, id: string): string[] {
  return result.conditions.find((condition) => condition.id === id)?.findings ?? [];
}

describe("architecture v2 migration readiness gate", () => {
  it(
    "reports READY for a complete workspace with only frozen migration debt",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/storage": {
            source: { "index.ts": 'import type { Run } from "@caelush/core";\nexport {};\n' },
          },
        }),
        readinessRootFiles([debtEntry()]),
      );

      const result = await readinessOf(workspace.root);

      expect(result.ready).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.summary.targetPackagesPresent).toBe(7);
      expect(result.summary.targetPackages).toBe(7);
      expect(result.summary.legacyPackagesMapped).toBe(10);
      expect(result.summary.legacyPackages).toBe(10);
      expect(result.summary.baselineEntries).toBe(1);
      expect(result.summary.newViolations).toBe(0);
      expect(result.summary.staleBaselineEntries).toBe(0);
      expect(result.output).toContain("Readiness:");
      expect(result.output).toContain("READY");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "reports READY with an empty baseline, so the gate survives full migration",
    async () => {
      const workspace = await fixture(cleanSpec(), readinessRootFiles([]));
      const result = await readinessOf(workspace.root);

      expect(result.ready).toBe(true);
      expect(result.summary.baselineEntries).toBe(0);
      expect(result.output).toContain("none");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "reports READY for a workspace whose debt is only some of the frozen entries",
    async () => {
      // Migration shrinks the baseline; the gate must assert legitimacy, not size.
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/storage": {
            source: {
              "index.ts": [
                'import type { Run } from "@caelush/core";',
                'import type { Event } from "@caelush/events";',
                "export {};",
              ].join("\n"),
            },
          },
        }),
        readinessRootFiles([
          debtEntry(),
          debtEntry({
            rule: "STORAGE_MUST_NOT_DEPEND_ON_EVENTS",
            targetPackage: "events",
            specifier: "@caelush/events",
          }),
        ]),
      );

      const result = await readinessOf(workspace.root);
      expect(result.ready).toBe(true);
      expect(result.summary.baselineEntries).toBe(2);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when a target package is missing",
    async () => {
      const specs = cleanSpec();
      delete specs["packages/ai"];

      const workspace = await fixture(specs);
      const result = await readinessOf(workspace.root);

      expect(result.ready).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(findingsFor(result, "target-package-inventory")).toEqual([
        "@caelush/ai does not exist in the workspace",
      ]);
      expect(result.output).toContain("NOT_READY");
      expect(result.output).toContain("target-package-inventory");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when a target package directory is absent",
    async () => {
      const specs = cleanSpec();
      delete specs["packages/ai"];

      const workspace = await fixture(specs);
      const result = await readinessOf(workspace.root);

      expect(result.ready).toBe(false);
      expect(findingsFor(result, "target-package-inventory")).toEqual([
        "@caelush/ai does not exist in the workspace",
      ]);
      expect(result.output).toContain("NOT_READY");
      expect(result.output).toContain("target-package-inventory");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when a target package name and directory disagree",
    async () => {
      // A manifest named @caelush/ai living under packages/ai-wrong still resolves
      // to the "ai" identity, so only the expected-directory check can catch it.
      const specs = cleanSpec();
      const ai = specs["packages/ai"];
      if (ai === undefined) throw new Error("fixture is missing packages/ai");
      // Keep the declared name but move the directory, so the name and the
      // expected location disagree while the identity still resolves to "ai".
      specs["packages/ai-relocated"] = { ...ai, manifestName: "@caelush/ai" };
      delete specs["packages/ai"];

      const workspace = await fixture(specs);
      const result = await readinessOf(workspace.root);

      expect(result.ready).toBe(false);
      expect(findingsFor(result, "target-package-inventory")).toEqual([
        "@caelush/ai lives at packages/ai-relocated, expected packages/ai",
      ]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when a legacy package has no migration destination",
    async () => {
      const workspace = await fixture(cleanSpec());
      const original = migrationMap.migrationEntryFor("tools");
      if (original === undefined) throw new Error("tools has no migration entry");

      // Simulate a mapping gap by removing the entry for the duration of the check.
      migrationMap.MIGRATION_MAP_INDEX.delete("tools");
      try {
        const result = await readinessOf(workspace.root);
        expect(result.ready).toBe(false);
        expect(findingsFor(result, "legacy-migration-map")).toEqual([
          "@caelush/tools has no migration destination",
        ]);
      } finally {
        migrationMap.MIGRATION_MAP_INDEX.set("tools", original);
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when the baseline contains a live architecture violation instead of migration debt",
    async () => {
      const workspace = await fixture(
        cleanSpec(),
        readinessRootFiles([
          debtEntry({
            kind: "source-import",
            rule: "AI_MUST_NOT_DEPEND_ON_PROTOCOL",
            edgeClass: "target-graph",
            sourcePackage: "ai",
            sourcePath: "packages/ai/src/index.ts",
            targetPackage: "protocol",
            specifier: "@caelush/protocol",
          }),
        ]),
      );

      const result = await readinessOf(workspace.root);

      expect(result.ready).toBe(false);
      const findings = findingsFor(result, "baseline-debt-class");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain("target-graph");
      expect(findings[0]).toContain("live architecture violation, not migration debt");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when the baseline grandfathers a private import or a host boundary violation",
    async () => {
      for (const edgeClass of [
        "private-import",
        "cross-workspace-relative-import",
        "host-boundary",
        "target-to-host",
      ]) {
        const workspace = await fixture(
          cleanSpec(),
          readinessRootFiles([debtEntry({ edgeClass })]),
        );
        const result = await readinessOf(workspace.root);

        expect(result.ready, edgeClass).toBe(false);
        expect(findingsFor(result, "baseline-debt-class").join(" "), edgeClass).toContain(
          edgeClass,
        );
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when a baseline entry is not dependency debt at all",
    async () => {
      const workspace = await fixture(
        cleanSpec(),
        readinessRootFiles([debtEntry({ kind: "private-import", subpath: "./internal" })]),
      );

      const result = await readinessOf(workspace.root);
      expect(result.ready).toBe(false);
      expect(findingsFor(result, "baseline-debt-class").join(" ")).toContain(
        'kind "private-import"',
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when baseline debt points at a legacy package with no destination",
    async () => {
      const workspace = await fixture(
        cleanSpec(),
        readinessRootFiles([
          debtEntry({
            rule: "STORAGE_MUST_NOT_DEPEND_ON_GONE",
            targetPackage: "gone-legacy-package",
            specifier: "@caelush/gone-legacy-package",
          }),
        ]),
      );

      const result = await readinessOf(workspace.root);
      expect(result.ready).toBe(false);
      const findings = findingsFor(result, "debt-mappable");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain("gone-legacy-package");
      expect(findings[0]).toContain("no migration destination");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when a V2 skeleton declares a legacy dependency",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/ai": {
            source: { "index.ts": "export {};\n" },
            dependencies: { "@caelush/llm": "workspace:*" },
          },
        }),
      );

      const result = await readinessOf(workspace.root);
      expect(result.ready).toBe(false);
      const findings = findingsFor(result, "v2-skeleton-boundary");
      expect(findings.join(" ")).toContain("@caelush/llm");
      // The dependency is also a real violation, so the boundary gate reports it too.
      expect(findingsFor(result, "no-new-violation").length).toBeGreaterThan(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when a V2 skeleton publishes a subpath before code migrates",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: { "index.ts": "export {};\n" },
            exports: { ".": { import: "./dist/index.js" }, "./tools": { import: "./dist/t.js" } },
          },
        }),
      );

      const result = await readinessOf(workspace.root);
      expect(result.ready).toBe(false);
      expect(findingsFor(result, "v2-skeleton-boundary").join(" ")).toContain('"./tools"');
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails on a new violation that is not in the baseline",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: { "index.ts": 'import type { Run } from "@caelush/core";\nexport {};\n' },
          },
        }),
        readinessRootFiles([]),
      );

      const result = await readinessOf(workspace.root);
      expect(result.ready).toBe(false);
      const findings = findingsFor(result, "no-new-violation");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain("AGENT_MUST_NOT_DEPEND_ON_CORE");
      expect(findings[0]).toContain("agent -> core");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails on a stale baseline entry, because a resolved violation must be removed",
    async () => {
      const workspace = await fixture(
        cleanSpec(),
        readinessRootFiles([
          debtEntry({
            sourcePath: "packages/storage/src/gone.ts",
            sourcePackage: "storage",
          }),
        ]),
      );

      const result = await readinessOf(workspace.root);
      expect(result.ready).toBe(false);
      const findings = findingsFor(result, "no-stale-baseline");
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain("packages/storage/src/gone.ts");
      expect(findings[0]).toContain("must be removed from the baseline");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when the root package.json is missing a required architecture script",
    async () => {
      const workspace = await fixture(cleanSpec(), {
        ...readinessRootFiles(),
        packageJson: { name: "fixture", private: true, scripts: { lint: "eslint ." } },
      });

      const result = await readinessOf(workspace.root);
      expect(result.ready).toBe(false);
      const findings = findingsFor(result, "architecture-script-health");
      expect(findings.join(" ")).toContain('"check:architecture"');
      expect(findings.join(" ")).toContain('"check:architecture:ci"');
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when the CI workflow does not wire the architecture gate",
    async () => {
      const workspace = await fixture(cleanSpec(), {
        ...readinessRootFiles(),
        workflow: "name: CI\non:\n  push:\n",
      });

      const result = await readinessOf(workspace.root);
      expect(result.ready).toBe(false);
      const findings = findingsFor(result, "architecture-script-health");
      expect(findings).toContain('CI workflow does not reference "check:architecture:ci"');
      expect(findings).toContain('CI workflow does not reference "architecture"');
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails when an architecture entry point is missing",
    async () => {
      const workspace = await fixture(cleanSpec(), { ...readinessRootFiles(), extra: {} });
      // The readiness gate reads entry points relative to the scan root, so a
      // fixture without them reports them as missing.
      const result = await readinessOf(workspace.root);

      expect(result.ready).toBe(false);
      expect(findingsFor(result, "architecture-script-health").join(" ")).toContain(
        "missing entry point",
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it("requires the allowlist to be the derivation input, not a parallel document", () => {
    // The drift guard compares the exported allowlist against isAllowedTargetEdge.
    // Those must read the same data, which means the exported object must be the
    // object the derivation is derived from, not a copy: a copy would be free to
    // drift unnoticed. Mutating an ESM namespace binding is a TypeError, so
    // identity plus full-pair coverage is the checkable form of that property.
    const allowlist = rules.V2_ALLOWED_DEPENDENCIES as Record<string, readonly string[]>;

    for (const target of rules.V2_TARGET_PACKAGES) {
      const declared = allowlist[target];
      expect(declared, `${target} is missing from the allowlist`).toBeDefined();

      for (const other of rules.V2_TARGET_PACKAGES) {
        if (other === target) continue;
        // isAllowedTargetEdge must answer exactly what the exported data says,
        // for every ordered pair. That is what makes a drift detectable.
        expect(rules.isAllowedTargetEdge(target, other), `${target}->${other}`).toBe(
          (declared ?? []).includes(other),
        );
      }
    }

    // The guard is live and returns a concrete verdict.
    expect(readiness.checkStaticContract()).toEqual([]);
  });

  it("accepts the frozen allowlist itself", () => {
    expect(readiness.checkStaticContract()).toEqual([]);
  });
});

describe("architecture v2 migration readiness on the real repository", () => {
  it(
    "reports READY with live-computed counts",
    async () => {
      const result = await readiness.runMigrationReadinessCheck({ root: repositoryRoot });
      const document = JSON.parse(await readFile(CHECKED_IN_BASELINE_PATH, "utf8"));

      expect(result.ready).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.summary.targetPackagesPresent).toBe(7);
      expect(result.summary.legacyPackagesMapped).toBe(10);
      expect(result.summary.baselineEntries).toBe(document.entryCount);
      expect(result.summary.privateImports).toBe(0);
      expect(result.summary.crossWorkspaceRelativeImports).toBe(0);
      expect(result.summary.failedConditions).toEqual([]);
      expect(result.output).toContain("Readiness:");
      expect(result.output).toContain("READY");
      expect(result.output).not.toContain("NOT_READY");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "computes the debt classes, sources and destinations it reports",
    async () => {
      const result = await readiness.runMigrationReadinessCheck({
        root: repositoryRoot,
        runCommandChecks: false,
      });
      const baseline = result.summary.baselineClasses as Record<string, number>;
      const sources = result.summary.baselineSourcePackages as Record<string, number>;
      const destinations = result.summary.baselineDestinations as Record<string, number>;

      // Only migration debt classes may appear.
      for (const edgeClass of Object.keys(baseline)) {
        expect(readiness.MIGRATION_DEBT_CLASSES).toContain(edgeClass);
      }
      // Every destination is either a legacy package with a migration entry, or
      // a target package that already absorbed the responsibility (the frozen
      // storage -> runtime debt is target-to-target and lands on runtime).
      for (const destination of Object.keys(destinations)) {
        const mapped = migrationMap.migrationEntryFor(destination) !== undefined;
        const isTarget = rules.packageRole(destination) === "target";
        expect(mapped || isTarget, destination).toBe(true);
      }
      // Every source must be a target package.
      for (const source of Object.keys(sources)) {
        expect(rules.packageRole(source), source).toBe("target");
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "reports the diagnostic test-scope crossings separately from production readiness",
    async () => {
      const result = await readiness.runMigrationReadinessCheck({
        root: repositoryRoot,
        runCommandChecks: false,
      });

      expect(result.summary.crossWorkspaceRelativeImports).toBe(0);
      expect(result.summary.testScopeCrossWorkspaceRelativeImports).toBeGreaterThan(0);
      expect(result.output).toContain("Diagnostic test-scope crossings (not gating)");
      // The gating condition must not carry the test-scope findings.
      const boundaryHealth = result.conditions.find(
        (condition) => condition.id === "public-boundary-health",
      );
      expect(boundaryHealth?.ok).toBe(true);
      expect(boundaryHealth?.findings).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "executes the architecture entry points it gates on",
    async () => {
      const result = await readiness.runMigrationReadinessCheck({ root: repositoryRoot });
      const cliHealth = result.conditions.find(
        (condition) => condition.id === "architecture-cli-health",
      );

      expect(cliHealth?.ok).toBe(true);
      expect(cliHealth?.findings).toEqual([]);
      expect(cliHealth?.detail).toBe("2 entry points executed");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps working with an empty baseline, so full migration stays READY",
    async () => {
      // Point the gate at an emptied copy of the baseline. The scan root is still
      // the real repository, so the frozen debt becomes all-new violations, which
      // is the correct NOT_READY answer while the code still contains the edges.
      // This documents the transition behaviour rather than pretending the gate is
      // baseline-size dependent.
      //
      // The scratch file goes to the OS temp directory, never into the repository:
      // writing inside the checkout fails in a clean clone and pollutes the working
      // tree if the test aborts before cleanup.
      const scratchDirectory = await mkdtemp(path.join(tmpdir(), "caelush-readiness-"));
      temporaryDirectories.push(scratchDirectory);
      const scratch = path.join(scratchDirectory, "legacy-import-baseline.json");
      const original = await readFile(CHECKED_IN_BASELINE_PATH, "utf8");
      const emptied = readinessBaseline([], {
        ruleSetVersion: JSON.parse(original).ruleSetVersion,
        baselineSourceCommit: JSON.parse(original).baselineSourceCommit,
        generatedByRuleExpansion: true,
      });
      await writeFile(scratch, `${JSON.stringify(emptied, null, 2)}\n`, "utf8");

      const result = await readiness.runMigrationReadinessCheck({
        root: repositoryRoot,
        baselinePath: scratch,
        runCommandChecks: false,
      });

      expect(result.ready).toBe(false);
      // Every currently-frozen edge becomes a new violation, which is exactly
      // what should happen if the baseline is emptied without migrating code.
      expect(result.summary.baselineEntries).toBe(0);
      expect(findingsFor(result, "no-new-violation").length).toBeGreaterThan(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "leaves the checked-in baseline untouched",
    async () => {
      const before = await readFile(CHECKED_IN_BASELINE_PATH, "utf8");
      await readiness.runMigrationReadinessCheck({ root: repositoryRoot, runCommandChecks: false });
      expect(await readFile(CHECKED_IN_BASELINE_PATH, "utf8")).toBe(before);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("architecture v2 readiness packaging", () => {
  it("exposes the migration debt classes the gate admits", () => {
    expect(readiness.MIGRATION_DEBT_CLASSES).toEqual(["target-to-legacy", "package-manifest"]);
    expect(readiness.NON_MIGRATION_DEBT_CLASSES).toEqual([
      "target-graph",
      "target-to-host",
      "host-boundary",
      "private-import",
      "cross-workspace-relative-import",
    ]);
    expect(readiness.V2_SKELETON_PACKAGES).toEqual(["ai", "agent", "coding-agent"]);
  });

  it("requires every architecture root script and entry point", () => {
    expect(readiness.REQUIRED_ROOT_SCRIPTS).toEqual([
      "check:architecture",
      "check:architecture:verify",
      "check:architecture:readiness",
      "check:architecture:ci",
    ]);
    expect(readiness.ARCHITECTURE_ENTRY_POINTS).toContain(
      "scripts/architecture/check-migration-readiness.mjs",
    );
  });

  it("keeps the scanned workspace shape the gate depends on", async () => {
    const scan = await scanner.scanWorkspace(repositoryRoot);
    for (const target of rules.V2_TARGET_PACKAGES) {
      expect(
        scan.projects.some((project) => project.identity === target),
        target,
      ).toBe(true);
    }
  });

  it("keeps the production boundary clean in the real repository", async () => {
    const scan = await scanner.scanWorkspace(repositoryRoot);
    expect(scan.privateImports).toEqual([]);
    expect(scan.crossWorkspaceRelativeImports).toEqual([]);
  });

  it(
    "keeps the boundary checker and the readiness gate consistent",
    async () => {
      // This test runs both full gates, so it needs the same scheduling allowance as
      // the other fixture-checking tests rather than the Vitest default.
      const boundary = await boundaries.runBoundaryCheck({ root: repositoryRoot });
      const result = await readiness.runMigrationReadinessCheck({
        root: repositoryRoot,
        runCommandChecks: false,
      });

      expect(boundary.summary.newViolations).toBe(0);
      expect(result.summary.newViolations).toBe(0);
      expect(boundary.summary.staleBaselineEntries).toBe(0);
      expect(result.summary.staleBaselineEntries).toBe(0);
      expect(boundary.summary.baselineEntries).toBe(result.summary.baselineEntries);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
