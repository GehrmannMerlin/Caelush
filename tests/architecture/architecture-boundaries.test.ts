import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundaries,
  rules,
  scanner,
  type BaselineDocument,
  type BaselineEntry,
  type EvaluatedScan,
} from "./support/architecture-checker.js";
import { createFixtureWorkspace, v2WorkspaceSpec } from "./support/fixture-workspace.js";
import { repositoryRoot } from "./support/workspace.js";

const execFileAsync = promisify(execFile);
const CHECKER_PATH = path.join(repositoryRoot, "scripts", "architecture", "check-boundaries.mjs");
const CHECKED_IN_BASELINE_PATH = path.join(
  repositoryRoot,
  "scripts",
  "architecture",
  "legacy-import-baseline.json",
);

const FIXED_TIME = new Date("2026-09-12T00:00:00.000Z");
const FIXED_HEAD = "0000000000000000000000000000000000000000";
/**
 * Every fixture now carries a real repository, and the baseline tests spawn git
 * and walk a fixture tree several times per test. Under a full `pnpm test` run
 * those spawns queue behind hundreds of other test files, so the Vitest default
 * of 5s is not enough. The bound is a scheduling allowance, not a hidden wait: a
 * passing run finishes well inside it.
 */
const GIT_TEST_TIMEOUT_MS = 60_000;

/** @type {Awaited<ReturnType<typeof createFixtureWorkspace>>[]} */
const openFixtures: Awaited<ReturnType<typeof createFixtureWorkspace>>[] = [];

afterEach(async () => {
  await Promise.all(openFixtures.splice(0).map((open) => open.cleanup()));
});

async function fixture(
  specs: Parameters<typeof createFixtureWorkspace>[0],
): Promise<Awaited<ReturnType<typeof createFixtureWorkspace>>> {
  const workspace = await createFixtureWorkspace(specs);
  openFixtures.push(workspace);
  // Every growing baseline write now needs the audited rule-set expansion
  // protocol, which proves admission against a real commit. Giving every fixture
  // a repository keeps that proof honest instead of stubbing it out.
  await workspace.git.init();
  return workspace;
}

/**
 * Run the checker against a fixture.
 *
 * `createBaseline: false` is the strict mode: no expansion flags are supplied, so
 * any write that would add an entry must be refused. The default satisfies the
 * expansion protocol at the fixture's own commit, which is the tree the
 * violations live on.
 */
async function check(
  root: string,
  options: {
    writeBaseline?: boolean;
    verifyBaseline?: boolean;
    env?: Record<string, string | undefined>;
    createBaseline?: boolean;
  } = {},
) {
  const createBaseline = options.createBaseline !== false;
  const baselineSourceCommit =
    createBaseline && options.writeBaseline === true ? await currentHead(root) : undefined;

  return boundaries.runBoundaryCheck({
    root,
    baselinePath: path.join(root, "legacy-import-baseline.json"),
    writeBaseline: options.writeBaseline === true,
    verifyBaseline: options.verifyBaseline === true,
    acceptRuleExpansion: baselineSourceCommit !== undefined,
    baselineSourceCommit,
    gitHead: FIXED_HEAD,
    gitHeadDate: FIXED_TIME.toISOString(),
    env: options.env ?? {},
  });
}

function baselinePathOf(root: string): string {
  return path.join(root, "legacy-import-baseline.json");
}

async function currentHead(root: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.trim();
}

/** A workspace with one forbidden edge that already existed before Phase 1A. */
function legacyWorkspaceSpec() {
  return v2WorkspaceSpec({
    "packages/agent": {
      source: { "index.ts": 'import { shell } from "@caelush/runtime";\nexport {};\n' },
    },
  });
}

describe("architecture v2 specifier normalization", () => {
  it("normalizes every deep subpath to its owning Caelush package", () => {
    expect(scanner.normalizeCaelushSpecifier("@caelush/agent")).toBe("@caelush/agent");
    expect(scanner.normalizeCaelushSpecifier("@caelush/agent/context")).toBe("@caelush/agent");
    expect(scanner.normalizeCaelushSpecifier("@caelush/agent/tools/foo")).toBe("@caelush/agent");
    expect(scanner.normalizeCaelushSpecifier("@caelush/runtime/deep/path/module.js")).toBe(
      "@caelush/runtime",
    );
    expect(scanner.normalizeCaelushSpecifier("@caelush/coding-agent/tools")).toBe(
      "@caelush/coding-agent",
    );
    expect(scanner.normalizeCaelushSpecifier("node:fs")).toBeUndefined();
    expect(scanner.normalizeCaelushSpecifier("zod")).toBeUndefined();
    expect(scanner.normalizeCaelushSpecifier("@other/agent")).toBeUndefined();
  });

  it("derives a stable package identity from a specifier", () => {
    expect(scanner.packageIdentityFromSpecifier("@caelush/coding-agent")).toBe("coding-agent");
    expect(scanner.packageIdentityFromSpecifier("@caelush/protocol/api/run")).toBe("protocol");
    expect(scanner.packageIdentityFromSpecifier("typescript")).toBeUndefined();
  });
});

describe("architecture v2 AST import extraction", () => {
  const contents = [
    'import { a } from "@caelush/agent";',
    'import type { B } from "@caelush/runtime/types";',
    'export { c } from "@caelush/storage";',
    'export * from "@caelush/client";',
    'const lazy = await import("@caelush/protocol/api");',
    'const legacy = require("@caelush/events");',
    'import local = require("@caelush/memory");',
    'import "./relative.js";',
    'import fs from "node:fs";',
    "const text = \"import {} from '@caelush/not-real'\";",
  ].join("\n");

  it("detects static import, export-from, dynamic import and require forms", () => {
    const found = scanner
      .extractSourceImports("fixture.ts", contents)
      .map((entry) => `${entry.kind}:${entry.specifier}`);

    expect(found).toEqual(
      expect.arrayContaining([
        "static-import:@caelush/agent",
        "static-import:@caelush/runtime/types",
        "export-from:@caelush/storage",
        "export-from:@caelush/client",
        "dynamic-import:@caelush/protocol/api",
        "require-call:@caelush/events",
        "require-call:@caelush/memory",
      ]),
    );
  });

  it("does not treat string literals or relative and builtin imports as Caelush edges", () => {
    const specifiers = scanner
      .extractSourceImports("fixture.ts", contents)
      .map((entry) => entry.specifier);

    expect(specifiers).not.toContain("@caelush/not-real");
    expect(specifiers).toContain("./relative.js");
    expect(specifiers).toContain("node:fs");
    expect(specifiers.filter((specifier) => specifier.startsWith("@caelush/"))).toEqual([
      "@caelush/agent",
      "@caelush/runtime/types",
      "@caelush/storage",
      "@caelush/client",
      "@caelush/protocol/api",
      "@caelush/events",
      "@caelush/memory",
    ]);
  });

  it("records one-based line and column positions", () => {
    const imports = scanner.extractSourceImports(
      "fixture.ts",
      'const a = 1;\nimport x from "@caelush/agent";\n',
    );

    expect(imports).toEqual([
      { kind: "static-import", specifier: "@caelush/agent", line: 2, column: 15 },
    ]);
  });

  it("ignores a dynamic import it cannot resolve statically", () => {
    const imports = scanner.extractSourceImports(
      "fixture.ts",
      'const name = "@caelush/agent";\nconst mod = await import(name);\n',
    );

    expect(imports).toEqual([]);
  });
});

describe("architecture v2 source scope selection", () => {
  it("scans project src trees at any depth", () => {
    expect(scanner.isScannableSourcePath("packages/agent/src/index.ts")).toBe(true);
    expect(scanner.isScannableSourcePath("packages/agent/src/loop/kernel.mts")).toBe(true);
    expect(scanner.isScannableSourcePath("apps/web/src/app/main.tsx")).toBe(true);
  });

  it("excludes generated output, dependency installs and non-source scopes", () => {
    expect(scanner.isScannableSourcePath("packages/agent/dist/index.js")).toBe(false);
    expect(scanner.isScannableSourcePath("packages/agent/node_modules/x/index.js")).toBe(false);
    expect(scanner.isScannableSourcePath("packages/agent/build/index.js")).toBe(false);
    expect(scanner.isScannableSourcePath("packages/agent/coverage/index.js")).toBe(false);
    expect(scanner.isScannableSourcePath("packages/agent/src/generated/client.ts")).toBe(false);
    expect(scanner.isScannableSourcePath("packages/agent/test/index.ts")).toBe(false);
    expect(scanner.isScannableSourcePath("packages/agent/src/index.md")).toBe(false);
  });

  it("scans project test trees only when the test scope is requested", () => {
    expect(scanner.isScannableSourcePath("packages/agent/test/loop.test.ts", "test")).toBe(true);
    expect(scanner.isScannableSourcePath("packages/agent/src/index.ts", "test")).toBe(false);
  });
});

describe("architecture v2 rule engine", () => {
  it("keeps every frozen rule id unique and derived from its edge", () => {
    expect(new Set(rules.RULE_IDS).size).toBe(rules.RULE_IDS.length);
    expect(rules.RULE_IDS).toContain("AGENT_MUST_NOT_DEPEND_ON_RUNTIME");
    expect(rules.RULE_IDS).toContain("AI_MUST_NOT_DEPEND_ON_AGENT");
    expect(rules.RULE_IDS).toContain("CLIENT_MUST_NOT_DEPEND_ON_AGENT");
    expect(rules.RULE_IDS).toContain("STORAGE_MUST_NOT_DEPEND_ON_CLIENT");
    expect(rules.RULE_IDS).toContain("CODING_AGENT_MUST_NOT_DEPEND_ON_STORAGE");
    expect(rules.RULE_IDS.some((id) => id.includes("MUST_NOT_DECLARE_DEPENDENCY_ON"))).toBe(true);
  });

  it("resolves a rule only for a forbidden direction and layer", () => {
    expect(rules.findRule("source-import", "agent", "runtime")?.id).toBe(
      "AGENT_MUST_NOT_DEPEND_ON_RUNTIME",
    );
    expect(rules.findRule("source-import", "runtime", "agent")?.id).toBe(
      "RUNTIME_MUST_NOT_DEPEND_ON_AGENT",
    );
    expect(rules.findRule("source-import", "agent", "daemon")?.id).toBe(
      "AGENT_MUST_NOT_DEPEND_ON_DAEMON",
    );
    // Allowed directions carry no rule.
    expect(rules.findRule("source-import", "agent", "protocol")).toBeUndefined();
    expect(rules.findRule("source-import", "agent", "ai")).toBeUndefined();
    expect(rules.findRule("source-import", "coding-agent", "agent")).toBeUndefined();
    expect(rules.findRule("source-import", "storage", "protocol")).toBeUndefined();
    expect(rules.findRule("source-import", "runtime", "protocol")).toBeUndefined();
    expect(rules.findRule("package-manifest", "agent", "runtime")?.id).toBe(
      "AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
    );
    expect(rules.findRule("package-manifest", "coding-agent", "agent")).toBeUndefined();
    expect(rules.findRule("package-manifest", "runtime", "protocol")).toBeUndefined();
  });

  it("declares both a source and a manifest rule for each forbidden edge", () => {
    const edgeOf = (rule: { from: string; to: string }) => `${rule.from}->${rule.to}`;
    const sourceEdges = new Set(
      rules.DEPENDENCY_RULES.filter((rule) => rule.layer === "source-import").map(edgeOf),
    );
    const manifestEdges = new Set(
      rules.DEPENDENCY_RULES.filter((rule) => rule.layer === "package-manifest").map(edgeOf),
    );

    expect(sourceEdges.size).toBeGreaterThan(0);
    for (const edge of sourceEdges) {
      expect([...manifestEdges], `${String(edge)} has no manifest rule`).toContain(edge);
    }
  });
});

describe("architecture v2 boundary evaluation", () => {
  it(
    "passes a workspace whose imports follow the allowed direction",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/coding-agent": {
            source: {
              "index.ts": [
                'import { buildAgent } from "@caelush/agent";',
                'import type { RunId } from "@caelush/protocol";',
                'import { shell } from "@caelush/runtime";',
                'import { complete } from "@caelush/ai";',
              ].join("\n"),
            },
            dependencies: {
              "@caelush/agent": "workspace:*",
              "@caelush/protocol": "workspace:*",
              "@caelush/runtime": "workspace:*",
              "@caelush/ai": "workspace:*",
            },
          },
          "packages/agent": {
            source: { "index.ts": 'import type { Run } from "@caelush/protocol";\nexport {};\n' },
            dependencies: { "@caelush/protocol": "workspace:*" },
          },
        }),
      );

      const scan = await scanner.scanWorkspace(workspace.root);
      expect(boundaries.evaluateScan(scan).violations).toEqual([]);

      await check(workspace.root, { writeBaseline: true });
      const verified = await check(workspace.root, { verifyBaseline: true });
      expect(verified.exitCode).toBe(0);
      expect(verified.output).toContain("Architecture V2 boundaries PASS");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails on a forbidden source import and names the rule and package",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: { "index.ts": 'import { shell } from "@caelush/runtime";\nexport {};\n' },
          },
        }),
      );

      await check(workspace.root, { writeBaseline: true });
      const baselineDocument = JSON.parse(await readFile(baselinePathOf(workspace.root), "utf8"));
      expect(baselineDocument.entries).toEqual([
        expect.objectContaining({
          kind: "source-import",
          sourcePackage: "agent",
          sourcePath: "packages/agent/src/index.ts",
          targetPackage: "runtime",
          rule: "AGENT_MUST_NOT_DEPEND_ON_RUNTIME",
          specifier: "@caelush/runtime",
        }),
      ]);

      await writeFile(
        workspace.projectPath("packages/agent/src/extra.ts"),
        'import { openStore } from "@caelush/storage";\nexport {};\n',
        "utf8",
      );

      const failed = await check(workspace.root);
      expect(failed.exitCode).toBe(1);
      expect(failed.output).toContain("Architecture V2 violation");
      expect(failed.output).toContain("Source:\npackages/agent/src/extra.ts");
      expect(failed.output).toContain("Source package:\n@caelush/agent");
      expect(failed.output).toContain("Illegal dependency:\n@caelush/storage");
      expect(failed.output).toContain("Rule:\nAGENT_MUST_NOT_DEPEND_ON_STORAGE");
      expect(failed.output).toContain("Import:\n@caelush/storage");
      expect(failed.output).toContain("Kind:\nsource-import");
      expect(failed.output).toContain("Status:\nNEW_VIOLATION");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "normalizes a deep subpath import to one package edge",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: {
              "index.ts": [
                'import { a } from "@caelush/runtime/deep/one";',
                'import { b } from "@caelush/runtime/deep/two";',
                'import { c } from "@caelush/runtime";',
              ].join("\n"),
            },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      const dependencyEdges = evaluated.violations.filter(
        (violation) => violation.kind === "source-import",
      );

      expect(dependencyEdges).toHaveLength(1);
      expect(dependencyEdges[0]?.targetPackage).toBe("runtime");
      expect(dependencyEdges[0]?.specifier).toBe("@caelush/runtime");
      expect(dependencyEdges[0]?.detail.occurrenceCount).toBe(3);
      expect(dependencyEdges[0]?.detail.rawSpecifier).toBe("@caelush/runtime/deep/one");
      // The two deep subpaths also bypass the export surface, which Phase 1B
      // reports separately instead of collapsing into the package edge.
      expect(
        evaluated.violations.filter((violation) => violation.kind === "private-import"),
      ).toHaveLength(2);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "detects dynamic import and export-from boundaries",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: {
              "index.ts": [
                'export { openStore } from "@caelush/storage";',
                'export const load = async () => import("@caelush/storage/runtime");',
                'export const viaClient = async () => import("@caelush/client");',
                'export const viaCoding = async () => import("@caelush/coding-agent");',
                'export const viaDaemon = async () => import("@caelush/daemon/api");',
              ].join("\n"),
            },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      const ruleIds = evaluated.violations
        .filter((violation) => violation.kind === "source-import")
        .map((violation) => violation.rule)
        .sort();

      expect(ruleIds).toEqual([
        "AGENT_MUST_NOT_DEPEND_ON_CLIENT",
        "AGENT_MUST_NOT_DEPEND_ON_CODING_AGENT",
        "AGENT_MUST_NOT_DEPEND_ON_DAEMON",
        "AGENT_MUST_NOT_DEPEND_ON_STORAGE",
      ]);
      const storage = evaluated.violations.find(
        (violation) => violation.kind === "source-import" && violation.targetPackage === "storage",
      );
      expect(storage?.detail.importKinds).toEqual(["export-from", "dynamic-import"]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "detects an illegal workspace dependency in package.json without source imports",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/ai": {
            source: { "index.ts": "export {};\n" },
            devDependencies: { "@caelush/agent": "workspace:*" },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));

      expect(evaluated.violations).toHaveLength(1);
      const [violation] = evaluated.violations;
      expect(violation?.kind).toBe("package-manifest");
      expect(violation?.rule).toBe("AI_MUST_NOT_DECLARE_DEPENDENCY_ON_AGENT");
      expect(violation?.sourcePath).toBe("packages/ai/package.json");
      expect(violation?.dependencyField).toBe("devDependencies");
      expect(violation?.specifier).toBe("@caelush/agent");

      await check(workspace.root, { writeBaseline: true });
      const frozen = await check(workspace.root);
      expect(frozen.exitCode).toBe(0);
      expect(frozen.summary.matchedLegacyViolations).toBe(1);

      const manifestPath = workspace.projectPath("packages/ai/package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.devDependencies["@caelush/runtime"] = "workspace:*";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const failed = await check(workspace.root);
      expect(failed.exitCode).toBe(1);
      expect(failed.output).toContain("Dependency field:\ndevDependencies");
      expect(failed.output).toContain("AI_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME");
      expect(failed.output).toContain("Status:\nNEW_VIOLATION");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "scans every manifest dependency section",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/client": {
            source: { "index.ts": "export {};\n" },
            dependencies: { "@caelush/agent": "workspace:*" },
            devDependencies: { "@caelush/runtime": "workspace:*" },
            peerDependencies: { "@caelush/storage": "workspace:*" },
            optionalDependencies: { "@caelush/coding-agent": "workspace:*" },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      const found = evaluated.violations
        .map((violation) => `${violation.dependencyField}:${violation.rule}`)
        .sort();

      expect(found).toEqual([
        "dependencies:CLIENT_MUST_NOT_DECLARE_DEPENDENCY_ON_AGENT",
        "devDependencies:CLIENT_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
        "optionalDependencies:CLIENT_MUST_NOT_DECLARE_DEPENDENCY_ON_CODING_AGENT",
        "peerDependencies:CLIENT_MUST_NOT_DECLARE_DEPENDENCY_ON_STORAGE",
      ]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the Web and CLI hosts off the kernel and persistence packages",
    async () => {
      const hostSource = [
        'import { openStore } from "@caelush/storage";',
        'export const a = async () => import("@caelush/agent");',
        'export const b = async () => import("@caelush/runtime");',
        'export const c = async () => import("@caelush/coding-agent");',
      ].join("\n");
      const workspace = await fixture(
        v2WorkspaceSpec({
          "apps/web": { source: { "index.ts": hostSource } },
          "apps/cli": { source: { "index.ts": hostSource } },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      const ruleIds = evaluated.violations.map((violation) => violation.rule);

      expect(ruleIds).toContain("WEB_MUST_NOT_DEPEND_ON_AGENT");
      expect(ruleIds).toContain("WEB_MUST_NOT_DEPEND_ON_RUNTIME");
      expect(ruleIds).toContain("WEB_MUST_NOT_DEPEND_ON_STORAGE");
      expect(ruleIds).toContain("WEB_MUST_NOT_DEPEND_ON_CODING_AGENT");
      expect(ruleIds).toContain("CLI_MUST_NOT_DEPEND_ON_AGENT");
      expect(ruleIds).toContain("CLI_MUST_NOT_DEPEND_ON_RUNTIME");
      expect(ruleIds).toContain("CLI_MUST_NOT_DEPEND_ON_STORAGE");
      expect(ruleIds).toContain("CLI_MUST_NOT_DEPEND_ON_CODING_AGENT");
      expect(evaluated.violations).toHaveLength(8);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "does not flag a project for importing itself through a deep subpath",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: { "index.ts": 'import { x } from "@caelush/agent/context";\nexport {};\n' },
          },
        }),
      );

      const evaluated = boundaries.evaluateScan(await scanner.scanWorkspace(workspace.root));
      expect(evaluated.violations).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "separates diagnostic test-scope edges from the authoritative source scope",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "apps/web": {
            source: { "index.ts": "export {};\n" },
            test: { "host.test.ts": 'import { gateway } from "@caelush/agent";\n' },
          },
        }),
      );

      const withoutTests = await scanner.scanWorkspace(workspace.root);
      expect(boundaries.evaluateScan(withoutTests).violations).toEqual([]);

      const withTests = await scanner.scanWorkspace(workspace.root, { includeTests: true });
      expect(withTests.testSourceEdges).toHaveLength(1);
      expect(withTests.testSourceEdges[0]?.sourcePath).toBe("apps/web/test/host.test.ts");
      expect(boundaries.evaluateScan(withTests).violations).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("architecture v2 legacy baseline ratchet", () => {
  it(
    "freezes an existing violation when it is present in the baseline",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());

      const written = await check(workspace.root, { writeBaseline: true });
      expect(written.exitCode).toBe(0);

      const result = await check(workspace.root);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Architecture V2 boundaries PASS");
      expect(result.summary.matchedLegacyViolations).toBe(1);
      expect(result.summary.baselineEntries).toBe(1);
      expect(result.summary.newViolations).toBe(0);
      expect(result.summary.staleBaselineEntries).toBe(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails on a new violation that is absent from the baseline",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await check(workspace.root, { writeBaseline: true });

      await writeFile(
        workspace.projectPath("packages/agent/src/extra.ts"),
        'import { openStore } from "@caelush/storage";\nexport {};\n',
        "utf8",
      );

      const result = await check(workspace.root);
      expect(result.exitCode).toBe(1);
      expect(result.summary.newViolations).toBe(1);
      expect(result.summary.matchedLegacyViolations).toBe(1);
      expect(result.summary.staleBaselineEntries).toBe(0);
      expect(result.output).toContain("AGENT_MUST_NOT_DEPEND_ON_STORAGE");
      expect(result.output).toContain("NEW_VIOLATION");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails with a stale baseline entry after the violation disappears",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await check(workspace.root, { writeBaseline: true });

      await writeFile(workspace.projectPath("packages/agent/src/index.ts"), "export {};\n", "utf8");

      const result = await check(workspace.root);
      expect(result.exitCode).toBe(1);
      expect(result.summary.staleBaselineEntries).toBe(1);
      expect(result.summary.newViolations).toBe(0);
      expect(result.output).toContain("Architecture V2 stale baseline entry");
      expect(result.output).toContain("packages/agent/src/index.ts");
      expect(result.output).toContain("Dependency:\n@caelush/runtime");
      expect(result.output).toContain("remove resolved violation from");
      expect(result.output).toContain("scripts/architecture/legacy-import-baseline.json");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the baseline stable when a baselined file is edited or gains another import",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await check(workspace.root, { writeBaseline: true });
      const before = await readFile(baselinePathOf(workspace.root), "utf8");

      await writeFile(
        workspace.projectPath("packages/agent/src/index.ts"),
        [
          "// a long new comment line",
          "// another new comment line",
          'import { tty } from "@caelush/runtime";',
          'import { shell } from "@caelush/runtime";',
          "export {};",
        ].join("\n"),
        "utf8",
      );

      const result = await check(workspace.root, { verifyBaseline: true });
      expect(result.exitCode).toBe(0);
      expect(result.summary.matchedLegacyViolations).toBe(JSON.parse(before).entryCount);
      expect(await readFile(baselinePathOf(workspace.root), "utf8")).toBe(before);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "detects baseline drift even while the frozen violations still match",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: {
              "index.ts": [
                'import { shell } from "@caelush/runtime";',
                'import { openStore } from "@caelush/storage";',
                "export {};",
              ].join("\n"),
            },
          },
        }),
      );
      await check(workspace.root, { writeBaseline: true });

      const document = JSON.parse(await readFile(baselinePathOf(workspace.root), "utf8"));
      expect(document.entryCount).toBe(2);
      document.entries = document.entries.slice(0, 1);
      document.entryCount = 1;
      await writeFile(
        baselinePathOf(workspace.root),
        boundaries.renderBaselineDocument(document),
        "utf8",
      );

      const result = await check(workspace.root, { verifyBaseline: true });
      expect(result.exitCode).toBe(1);
      expect(result.summary.newViolations).toBe(1);
      expect(result.summary.staleBaselineEntries).toBe(0);
      expect(result.output).toContain("Architecture V2 baseline drift detected");
      expect(result.output).toContain("missing from file:  1");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "reports a missing baseline instead of silently passing",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());

      const result = await check(workspace.root);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Architecture V2 baseline missing");
      expect(result.output).toContain("--write-baseline");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a malformed baseline document",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await writeFile(
        baselinePathOf(workspace.root),
        JSON.stringify({ entries: [{ kind: "source-import" }] }),
        "utf8",
      );

      await expect(check(workspace.root)).rejects.toThrow(/missing string field/u);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a baseline write in CI when it would add unreviewed entries",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await check(workspace.root, { writeBaseline: true });
      const before = await readFile(baselinePathOf(workspace.root), "utf8");

      await writeFile(
        workspace.projectPath("packages/agent/src/extra.ts"),
        'import { openStore } from "@caelush/storage";\nexport {};\n',
        "utf8",
      );

      const result = await check(workspace.root, { writeBaseline: true, env: { CI: "true" } });
      expect(result.exitCode).toBe(1);
      expect(result.summary.refused).toBe("ci-baseline-growth");
      expect(result.output).toContain("CI never grows the baseline");
      expect(await readFile(baselinePathOf(workspace.root), "utf8")).toBe(before);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "allows a CI baseline write that only shrinks the baseline",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await check(workspace.root, { writeBaseline: true });

      await writeFile(workspace.projectPath("packages/agent/src/index.ts"), "export {};\n", "utf8");

      const result = await check(workspace.root, { writeBaseline: true, env: { CI: "true" } });
      expect(result.exitCode).toBe(0);
      expect(result.summary.entries).toBe(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "refuses to create a missing baseline from CI while violations exist",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      const baseline = baselinePathOf(workspace.root);

      const result = await check(workspace.root, { writeBaseline: true, env: { CI: "true" } });

      expect(result.exitCode).toBe(1);
      expect(result.summary.refused).toBe("ci-baseline-growth");
      await expect(readFile(baseline, "utf8")).rejects.toThrow(/ENOENT/u);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "records reproducible provenance in the baseline",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await check(workspace.root, { writeBaseline: true });

      const first = await readFile(baselinePathOf(workspace.root), "utf8");
      const document = JSON.parse(first);
      // Phase 1B renamed the provenance field: the baseline now records which
      // commit its admitted violations were proven to exist at, and that commit is
      // read from the scan root rather than from the caller's gitHead override.
      const head = await currentHead(workspace.root);
      expect(document.baselineSourceCommit).toBe(head);
      expect(document.ruleSetVersion).toBe(rules.RULE_SET_VERSION);
      expect(document.generatedAt).toBe(FIXED_TIME.toISOString());
      expect(document.generatedByRuleExpansion).toBe(true);

      await check(workspace.root, { writeBaseline: true });
      const regenerated = JSON.parse(await readFile(baselinePathOf(workspace.root), "utf8"));
      expect(regenerated.entryCount).toBe(document.entryCount);
      expect(regenerated.baselineSourceCommit).toBe(head);
      expect(regenerated.generatedAt).toBe(FIXED_TIME.toISOString());
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "never rewrites the baseline during an ordinary check",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await check(workspace.root, { writeBaseline: true });
      const before = await readFile(baselinePathOf(workspace.root), "utf8");

      await writeFile(
        workspace.projectPath("packages/agent/src/extra.ts"),
        'import { openStore } from "@caelush/storage";\nexport {};\n',
        "utf8",
      );

      const failed = await check(workspace.root);
      expect(failed.exitCode).toBe(1);
      expect(await readFile(baselinePathOf(workspace.root), "utf8")).toBe(before);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "produces a deterministic, sorted, one-entry-per-line baseline",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: {
              "zeta.ts": 'import { s } from "@caelush/storage";\nexport {};\n',
              "alpha.ts": 'import { c } from "@caelush/client";\nexport {};\n',
            },
            devDependencies: { "@caelush/runtime": "workspace:*" },
          },
        }),
      );

      await check(workspace.root, { writeBaseline: true });
      const rendered = await readFile(baselinePathOf(workspace.root), "utf8");

      expect(rendered.endsWith("\n")).toBe(true);
      expect(rendered).not.toContain("\r\n");

      const parsed = JSON.parse(rendered) as BaselineDocument;
      expect(parsed.entryCount).toBe(3);
      expect(parsed.entries).toHaveLength(3);
      expect(parsed.entries.map((entry) => entry.sourcePath)).toEqual([
        "packages/agent/package.json",
        "packages/agent/src/alpha.ts",
        "packages/agent/src/zeta.ts",
      ]);

      const entryLines = rendered
        .split("\n")
        .filter((line) => line.trimStart().startsWith('{ "kind":'));
      expect(entryLines).toHaveLength(3);

      await check(workspace.root, { writeBaseline: true });
      expect(await readFile(baselinePathOf(workspace.root), "utf8")).toBe(rendered);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it("keeps baseline keys and ordering independent of discovery order", () => {
    const entries: BaselineEntry[] = [
      {
        kind: "source-import",
        edgeClass: "target-to-legacy",
        sourcePackage: "agent",
        sourcePath: "packages/agent/src/b.ts",
        targetPackage: "runtime",
        rule: "AGENT_MUST_NOT_DEPEND_ON_RUNTIME",
        specifier: "@caelush/runtime",
      },
      {
        kind: "package-manifest",
        edgeClass: "package-manifest",
        sourcePackage: "agent",
        sourcePath: "packages/agent/package.json",
        targetPackage: "runtime",
        rule: "AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
        specifier: "@caelush/runtime",
        dependencyField: "dependencies",
      },
      {
        kind: "source-import",
        edgeClass: "target-to-legacy",
        sourcePackage: "agent",
        sourcePath: "packages/agent/src/a.ts",
        targetPackage: "storage",
        rule: "AGENT_MUST_NOT_DEPEND_ON_STORAGE",
        specifier: "@caelush/storage",
      },
    ];

    const sorted = boundaries.sortBaselineEntries(entries);
    expect(sorted.map((entry) => entry.sourcePath)).toEqual([
      "packages/agent/package.json",
      "packages/agent/src/a.ts",
      "packages/agent/src/b.ts",
    ]);
    expect(boundaries.baselineKey(sorted[0]!)).not.toBe(boundaries.baselineKey(sorted[1]!));
    expect(boundaries.sortBaselineEntries([...sorted].reverse())).toEqual(sorted);
  });

  it(
    "round-trips a rendered baseline document through the parser",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      const scan = await scanner.scanWorkspace(workspace.root);
      const document = boundaries.buildBaselineDocument(boundaries.evaluateScan(scan), {
        gitHead: FIXED_HEAD,
        generatedAt: FIXED_TIME.toISOString(),
      });

      const parsed = boundaries.parseBaselineDocument(
        JSON.parse(boundaries.renderBaselineDocument(document)),
      );
      expect(parsed).toEqual(document.entries);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "detects duplicate baseline entries",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await check(workspace.root, { writeBaseline: true });
      const document = JSON.parse(await readFile(baselinePathOf(workspace.root), "utf8"));
      document.entries = [document.entries[0], document.entries[0]];

      await writeFile(
        baselinePathOf(workspace.root),
        boundaries.renderBaselineDocument(document),
        "utf8",
      );

      const result = await check(workspace.root);
      expect(result.exitCode).toBe(1);
      expect(result.summary.duplicateBaselineEntries).toBe(1);
      expect(result.output).toContain("duplicate baseline entries");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails a new violation and a stale entry in the same run",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      await check(workspace.root, { writeBaseline: true });

      await writeFile(workspace.projectPath("packages/agent/src/index.ts"), "export {};\n", "utf8");
      await writeFile(
        workspace.projectPath("packages/agent/src/extra.ts"),
        'import { openStore } from "@caelush/storage";\nexport {};\n',
        "utf8",
      );

      const result = await check(workspace.root);
      expect(result.exitCode).toBe(1);
      expect(result.summary.newViolations).toBe(1);
      expect(result.summary.staleBaselineEntries).toBe(1);
      expect(result.output).toContain("NEW_VIOLATION");
      expect(result.output).toContain("Architecture V2 stale baseline entry");
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("architecture v2 comparison semantics", () => {
  it("matches entries by edge identity rather than by location", () => {
    const baselineEntries: BaselineEntry[] = [
      {
        kind: "source-import",
        edgeClass: "target-to-legacy",
        sourcePackage: "agent",
        sourcePath: "packages/agent/src/a.ts",
        targetPackage: "runtime",
        rule: "AGENT_MUST_NOT_DEPEND_ON_RUNTIME",
        specifier: "@caelush/runtime",
      },
    ];
    const evaluated: EvaluatedScan = {
      violations: [
        {
          ...baselineEntries[0]!,
          line: 99,
          column: 7,
          detail: { rawSpecifier: "@caelush/runtime" },
        },
      ],
      sourceEdges: 1,
      manifestEdges: 0,
      privateImports: 0,
      crossWorkspaceRelativeImports: 0,
    };

    const comparison = boundaries.compareWithBaseline(evaluated, baselineEntries);
    expect(comparison.matched).toHaveLength(1);
    expect(comparison.newViolations).toEqual([]);
    expect(comparison.staleEntries).toEqual([]);
  });

  it("distinguishes a manifest entry from a source entry for the same edge", () => {
    const evaluated: EvaluatedScan = {
      violations: [
        {
          kind: "package-manifest",
          edgeClass: "package-manifest",
          sourcePackage: "agent",
          sourcePath: "packages/agent/package.json",
          targetPackage: "runtime",
          rule: "AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
          specifier: "@caelush/runtime",
          dependencyField: "dependencies",
          line: 8,
          column: 5,
          detail: {},
        },
      ],
      sourceEdges: 0,
      manifestEdges: 1,
      privateImports: 0,
      crossWorkspaceRelativeImports: 0,
    };
    const baselineEntries: BaselineEntry[] = [
      {
        kind: "source-import",
        edgeClass: "target-to-legacy",
        sourcePackage: "agent",
        sourcePath: "packages/agent/src/a.ts",
        targetPackage: "runtime",
        rule: "AGENT_MUST_NOT_DEPEND_ON_RUNTIME",
        specifier: "@caelush/runtime",
      },
    ];

    const comparison = boundaries.compareWithBaseline(evaluated, baselineEntries);
    expect(comparison.newViolations).toHaveLength(1);
    expect(comparison.staleEntries).toHaveLength(1);
  });
});

describe("architecture v2 repository integration", () => {
  it(
    "ships a checked-in baseline that matches the current checkout",
    async () => {
      const result = await boundaries.runBoundaryCheck({
        root: repositoryRoot,
        verifyBaseline: true,
      });

      expect(result.output).toContain("Architecture V2 boundaries PASS");
      expect(result.exitCode).toBe(0);
      expect(result.summary.newViolations).toBe(0);
      expect(result.summary.staleBaselineEntries).toBe(0);
      expect(result.summary.duplicateBaselineEntries).toBe(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "parses the real source scope and resolves every Caelush specifier",
    async () => {
      const scan = await scanner.scanWorkspace(repositoryRoot);

      expect(scan.projects.length).toBeGreaterThanOrEqual(18);
      expect(scan.sourceFileCount).toBeGreaterThan(300);
      expect(scan.sourceImportCount).toBeGreaterThan(1000);
      expect(scan.unknownCaelushSpecifiers).toEqual([]);
      expect(scan.sourceEdges.length).toBeGreaterThan(100);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the checked-in baseline deterministic and reviewed",
    async () => {
      const raw = await readFile(CHECKED_IN_BASELINE_PATH, "utf8");
      const document = JSON.parse(raw);

      expect(document.schemaVersion).toBe(1);
      expect(document.ruleSetVersion).toBe(rules.RULE_SET_VERSION);
      expect(document.entryCount).toBe(document.entries.length);
      // Line endings are intentionally not asserted here: git may check the file
      // out with CRLF depending on core.autocrlf, which would make this test a
      // platform check rather than an architecture check. Content correctness is
      // what matters, and it is enforced by pnpm check:architecture:verify.
      expect(document.entries).toEqual(boundaries.sortBaselineEntries(document.entries));
      expect(new Set(document.entries.map(boundaries.baselineKey)).size).toBe(
        document.entries.length,
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "exposes a working read-only command-line entry point",
    async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [CHECKER_PATH, "--verify-baseline"],
        {
          cwd: repositoryRoot,
        },
      );

      expect(stdout).toContain("Architecture V2 boundaries PASS");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "fails the command-line entry point when a forbidden edge is injected",
    async () => {
      const workspace = await fixture(
        v2WorkspaceSpec({
          "packages/agent": {
            source: { "index.ts": 'import { shell } from "@caelush/runtime";\nexport {};\n' },
          },
        }),
      );
      await check(workspace.root, { writeBaseline: true });
      const baseline = baselinePathOf(workspace.root);

      await expect(
        execFileAsync(
          process.execPath,
          [CHECKER_PATH, "--root", workspace.root, "--baseline", baseline],
          {
            cwd: repositoryRoot,
          },
        ),
      ).resolves.toMatchObject({
        stdout: expect.stringContaining("Architecture V2 boundaries PASS"),
      });

      await writeFile(
        workspace.projectPath("packages/agent/src/extra.ts"),
        'import { openStore } from "@caelush/storage";\nexport {};\n',
        "utf8",
      );

      await expect(
        execFileAsync(
          process.execPath,
          [CHECKER_PATH, "--root", workspace.root, "--baseline", baseline],
          {
            cwd: repositoryRoot,
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("NEW_VIOLATION"),
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a CI baseline write from the command line when it would grow the baseline",
    async () => {
      const workspace = await fixture(legacyWorkspaceSpec());
      const baseline = baselinePathOf(workspace.root);
      await check(workspace.root, { writeBaseline: true });

      await writeFile(
        workspace.projectPath("packages/agent/src/extra.ts"),
        'import { openStore } from "@caelush/storage";\nexport {};\n',
        "utf8",
      );

      await expect(
        execFileAsync(
          process.execPath,
          [CHECKER_PATH, "--root", workspace.root, "--baseline", baseline, "--write-baseline"],
          { cwd: repositoryRoot, env: { ...process.env, CI: "true" } },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("CI never grows the baseline"),
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "rejects an unknown command-line argument with the usage message",
    async () => {
      await expect(
        execFileAsync(process.execPath, [CHECKER_PATH, "--not-a-flag"], { cwd: repositoryRoot }),
      ).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("Unknown argument: --not-a-flag"),
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
