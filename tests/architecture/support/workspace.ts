import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const packageNames = [
  "protocol",
  "core",
  "llm",
  "context",
  "tools",
  "runtime",
  "security",
  "verification",
  "events",
  "storage",
  "observability",
  "shared",
  "client",
] as const;

export const appNames = ["daemon", "cli", "web"] as const;

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
