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

export const FIXTURE_APPS = ["daemon", "cli", "web"];

export type FixtureProjectSpec = {
  source?: Record<string, string>;
  test?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export type FixtureWorkspace = {
  root: string;
  projectPath: (relativePath: string) => string;
  cleanup: () => Promise<void>;
};

/**
 * Create a throwaway workspace on disk so the architecture checker can be tested
 * without depending on the real repository contents.
 *
 * @param specs project directory relative to the workspace root, e.g. `packages/agent`
 */
export async function createFixtureWorkspace(
  specs: Record<string, FixtureProjectSpec>,
): Promise<FixtureWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-architecture-fixture-"));

  for (const [projectDirectory, spec] of Object.entries(specs)) {
    const absoluteProject = path.join(root, ...projectDirectory.split("/"));
    await mkdir(absoluteProject, { recursive: true });

    await writeFile(
      path.join(absoluteProject, "package.json"),
      `${JSON.stringify(
        {
          name: `@caelush/${projectDirectory.split("/")[1]}`,
          version: "0.1.0",
          private: true,
          type: "module",
          exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
          ...(spec.dependencies ? { dependencies: spec.dependencies } : {}),
          ...(spec.devDependencies ? { devDependencies: spec.devDependencies } : {}),
          ...(spec.peerDependencies ? { peerDependencies: spec.peerDependencies } : {}),
          ...(spec.optionalDependencies ? { optionalDependencies: spec.optionalDependencies } : {}),
        },
        null,
        2,
      )}\n`,
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
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
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
