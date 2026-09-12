import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Every workspace project the fixture workspace declares. The fixture mirrors the
 * real repository layout (`packages/*` and `apps/*`) so the scanner and the rule
 * engine are exercised through their real discovery paths.
 */
export const FIXTURE_PACKAGES = [
  "protocol",
  "ai",
  "agent",
  "runtime",
  "coding-agent",
  "storage",
  "client",
];

/** Legacy package identities the fixture declares, so target->legacy can be tested. */
export const FIXTURE_LEGACY_PACKAGES = [
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
];

export const FIXTURE_APPS = ["daemon", "cli", "web", "launcher"];

export type FixtureProjectSpec = {
  source?: Record<string, string>;
  test?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /**
   * Explicit `exports` map. Omit it to get the repository default of a single
   * `"."` entry; pass `null` to emit no `exports` field at all.
   */
  exports?: Record<string, unknown> | null;
  /**
   * Override the manifest package name. The default derives `@caelush/<dir>` from
   * the project directory, so an override is how a test creates a project whose
   * declared name and directory disagree.
   */
  manifestName?: string;
};

export type FixtureWorkspace = {
  root: string;
  projectPath: (relativePath: string) => string;
  git: FixtureGit;
  cleanup: () => Promise<void>;
};

/**
 * Repository-level files a readiness test needs: the migration readiness gate
 * checks the root package.json scripts, the CI workflow, and a baseline file, none
 * of which belong to a workspace project.
 */
export type FixtureRootFiles = {
  packageJson?: Record<string, unknown>;
  workflow?: string;
  baseline?: unknown;
  extra?: Record<string, string>;
};

/**
 * Minimal git control for the audited baseline-expansion tests. The expansion
 * protocol proves that an admitted violation already existed at a recorded
 * commit, so those tests need a real repository whose HEAD they can move.
 */
export type FixtureGit = {
  init: () => Promise<string>;
  commitAll: (message: string) => Promise<string>;
  head: () => Promise<string>;
  isRepository: () => Promise<boolean>;
};

/**
 * Create a throwaway workspace on disk so the architecture checker can be tested
 * without depending on the real repository contents.
 *
 * @param specs project directory relative to the workspace root, e.g. `packages/agent`
 * @param rootFiles repository-level files the readiness gate inspects
 */
export async function createFixtureWorkspace(
  specs: Record<string, FixtureProjectSpec>,
  rootFiles: FixtureRootFiles = {},
): Promise<FixtureWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-architecture-fixture-"));

  if (rootFiles.packageJson) {
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify(rootFiles.packageJson, null, 2)}\n`,
      "utf8",
    );
  }
  if (rootFiles.baseline !== undefined) {
    await writeFile(
      path.join(root, "legacy-import-baseline.json"),
      `${JSON.stringify(rootFiles.baseline, null, 2)}\n`,
      "utf8",
    );
  }
  if (rootFiles.workflow !== undefined) {
    const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(workflowPath, rootFiles.workflow, "utf8");
  }
  for (const [relativePath, contents] of Object.entries(rootFiles.extra ?? {})) {
    const absolute = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }

  for (const [projectDirectory, spec] of Object.entries(specs)) {
    const absoluteProject = path.join(root, ...projectDirectory.split("/"));
    await mkdir(absoluteProject, { recursive: true });

    const manifest: Record<string, unknown> = {
      name: spec.manifestName ?? `@caelush/${projectDirectory.split("/")[1]}`,
      version: "0.1.0",
      private: true,
      type: "module",
    };

    if (spec.exports !== null) {
      manifest.exports = spec.exports ?? {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      };
    }
    if (spec.dependencies) manifest.dependencies = spec.dependencies;
    if (spec.devDependencies) manifest.devDependencies = spec.devDependencies;
    if (spec.peerDependencies) manifest.peerDependencies = spec.peerDependencies;
    if (spec.optionalDependencies) manifest.optionalDependencies = spec.optionalDependencies;

    await writeFile(
      path.join(absoluteProject, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const scopes: [string, Record<string, string>][] = [
      ["src", spec.source ?? {}],
      ["test", spec.test ?? {}],
    ];

    for (const [scope, files] of scopes) {
      for (const [fileName, contents] of Object.entries(files)) {
        const absoluteFile = path.join(absoluteProject, scope, ...fileName.split("/"));
        await mkdir(path.dirname(absoluteFile), { recursive: true });
        await writeFile(absoluteFile, contents, "utf8");
      }
    }
  }

  return {
    root,
    projectPath: (relativePath: string) => path.join(root, ...relativePath.split("/")),
    git: {
      isRepository: async () => {
        try {
          await runGit(root, ["rev-parse", "--git-dir"]);
          return true;
        } catch {
          return false;
        }
      },
      init: async () => {
        await runGit(root, ["init", "--quiet"]);
        await runGit(root, ["config", "user.email", "fixture@caelush.invalid"]);
        await runGit(root, ["config", "user.name", "Architecture Fixture"]);
        await runGit(root, ["config", "commit.gpgsign", "false"]);
        await runGit(root, ["add", "-A"]);
        await runGit(root, ["commit", "--quiet", "--no-verify", "-m", "fixture baseline"]);
        return (await runGit(root, ["rev-parse", "HEAD"])).trim();
      },
      commitAll: async (message: string) => {
        await runGit(root, ["add", "-A"]);
        await runGit(root, ["commit", "--quiet", "--no-verify", "-m", message]);
        return (await runGit(root, ["rev-parse", "HEAD"])).trim();
      },
      head: async () => (await runGit(root, ["rev-parse", "HEAD"])).trim(),
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: "2026-09-12T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-09-12T00:00:00Z",
    },
  });
  return stdout;
}

/** Root scripts the migration readiness gate requires. */
export const READINESS_ROOT_SCRIPTS = {
  "check:architecture": "node scripts/architecture/check-boundaries.mjs",
  "check:architecture:verify": "node scripts/architecture/check-boundaries.mjs --verify-baseline",
  "check:architecture:readiness": "node scripts/architecture/check-migration-readiness.mjs",
  "check:architecture:ci":
    "pnpm check:architecture && pnpm check:architecture:verify && pnpm check:architecture:readiness",
};

/** A CI workflow that satisfies the readiness gate's wiring expectations. */
export const READINESS_WORKFLOW = [
  "name: CI",
  "on:",
  "  push:",
  "jobs:",
  "  architecture:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: pnpm check:architecture:ci",
  "",
].join("\n");

/** An empty but structurally valid baseline document. */
export function readinessBaseline(
  entries: unknown[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ruleSetVersion: 2,
    baselineSourceCommit: "0000000000000000000000000000000000000000",
    generatedByRuleExpansion: false,
    entryCount: entries.length,
    countsByRule: {},
    countsBySourcePackage: {},
    entries,
    ...overrides,
  };
}

/**
 * Paths the migration readiness gate expects to exist in a checkout. A fixture is
 * not a checkout, so it creates stand-ins for them: the gate's purpose is to
 * confirm the real entry points are present and runnable, and the real-repository
 * test covers the runnable half.
 */
export const READINESS_ENTRY_POINT_PATHS = [
  "scripts/architecture/v2-rules.mjs",
  "scripts/architecture/v2-migration-map.mjs",
  "scripts/architecture/scan-workspace.mjs",
  "scripts/architecture/check-boundaries.mjs",
  "scripts/architecture/check-migration-readiness.mjs",
];

/** Repository-level files that make a fixture pass every readiness wiring check. */
export function readinessRootFiles(baselineEntries: unknown[] = []): FixtureRootFiles {
  const baseline = readinessBaseline(baselineEntries);
  return {
    packageJson: { name: "fixture", private: true, scripts: { ...READINESS_ROOT_SCRIPTS } },
    workflow: READINESS_WORKFLOW,
    baseline,
    extra: {
      ...Object.fromEntries(
        READINESS_ENTRY_POINT_PATHS.map((entryPoint) => [entryPoint, "// fixture stand-in\n"]),
      ),
      // The gate also checks that the canonical baseline path exists, which is a
      // different location from the one a test may point --baseline at.
      "scripts/architecture/legacy-import-baseline.json": `${JSON.stringify(baseline, null, 2)}\n`,
    },
  };
}

/**
 * Build a fixture spec set for the complete Architecture V2 workspace shape with
 * minimal, valid source entries. Overrides are merged per project so a caller can
 * add manifest dependencies without dropping the default source entry.
 */
export function v2WorkspaceSpec(
  overrides: Record<string, FixtureProjectSpec> = {},
): Record<string, FixtureProjectSpec> {
  const specs: Record<string, FixtureProjectSpec> = {};
  for (const name of FIXTURE_PACKAGES) {
    specs[`packages/${name}`] = { source: { "index.ts": "export {};\n" } };
  }
  for (const name of FIXTURE_LEGACY_PACKAGES) {
    specs[`packages/${name}`] = { source: { "index.ts": "export {};\n" } };
  }
  for (const name of FIXTURE_APPS) {
    specs[`apps/${name}`] = { source: { "index.ts": "export {};\n" } };
  }

  for (const [projectDirectory, override] of Object.entries(overrides)) {
    const base = specs[projectDirectory] ?? {};
    specs[projectDirectory] = {
      ...base,
      ...override,
      source: { ...base.source, ...override.source },
      ...(base.test || override.test ? { test: { ...base.test, ...override.test } } : {}),
    };
  }

  return specs;
}
