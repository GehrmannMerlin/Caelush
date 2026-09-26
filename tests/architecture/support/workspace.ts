import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * Legacy Architecture V1 package identities plus the Architecture V2 target
 * packages that exist as source-of-truth destinations. `ai`, `agent`, and
 * `coding-agent` were added by Architecture V2 Phase 1A as empty skeletons; the
 * legacy packages stay listed until their own migration phase renames or
 * deletes them.
 *
 * `tools` was removed by Architecture V2 Phase 4F: the legacy `@caelush/tools`
 * package is gone, its general responsibilities live in `agent`, its Coding
 * responsibilities in `coding-agent`. It is deliberately not listed here, and
 * `phase-4f-tool-system-final-boundaries.test.ts` asserts instead that the
 * directory and every workspace reference to it are absent. The legacy
 * `llm` package was fully retired by Architecture V2 Phase 5F and is likewise
 * intentionally absent from the workspace inventory. The legacy `events`
 * package was retired by Architecture V2 Phase 6H and is likewise absent;
 * `phase-6h-event-package-retirement.test.ts` owns its tombstone assertions.
 */
export const packageNames = [
  "protocol",
  "ai",
  "core",
  "agent",
  "runtime",
  "security",
  "verification",
  "memory",
  "storage",
  "observability",
  "shared",
  "client",
  "coding-agent",
] as const;

/** The workspace package that Phase 4F retired. It must never reappear. */
export const retiredLegacyToolPackage = {
  directory: "packages/tools",
  name: "@caelush/tools",
} as const;

export const appNames = ["daemon", "cli", "web", "launcher"] as const;

export type WorkspaceManifest = {
  name?: unknown;
  private?: unknown;
  type?: unknown;
  exports?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};

export async function readManifest(relativePath: string): Promise<WorkspaceManifest> {
  const contents = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  return JSON.parse(contents) as WorkspaceManifest;
}

export function allWorkspaceManifestPaths(): string[] {
  return [
    ...packageNames.map((name) => `packages/${name}/package.json`),
    ...appNames.map((name) => `apps/${name}/package.json`),
  ];
}

export function allWorkspaceNames(): string[] {
  return [
    ...packageNames.map((name) => `@caelush/${name}`),
    ...appNames.map((name) => `@caelush/${name}`),
  ];
}

export async function pathExists(relativePath: string): Promise<boolean> {
  try {
    await stat(path.join(repositoryRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(entryPath)));
    } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function workspaceSourceContents(): Promise<string[]> {
  const sourceRoots = [
    ...packageNames.map((name) => path.join(repositoryRoot, "packages", name, "src")),
    ...appNames.map((name) => path.join(repositoryRoot, "apps", name, "src")),
  ];
  const sourceFiles: string[] = [];

  for (const sourceRoot of sourceRoots) {
    if (await pathExists(path.relative(repositoryRoot, sourceRoot))) {
      sourceFiles.push(...(await collectSourceFiles(sourceRoot)));
    }
  }

  return Promise.all(sourceFiles.map((sourceFile) => readFile(sourceFile, "utf8")));
}

export function dependencyEntries(manifest: WorkspaceManifest): Record<string, unknown> {
  return {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
}
