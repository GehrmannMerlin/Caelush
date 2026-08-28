import path from "node:path";
import type { ContextFileSystem } from "./filesystem.js";
import type { WorkspaceScope } from "./workspace.js";

export type ProjectRootReason =
  "VCS_MARKER" | "WORKSPACE_MARKER" | "PROJECT_MANIFEST" | "CWD_FALLBACK";

export interface ProjectRootDetectionResult {
  readonly projectRoot: string;
  readonly reason: ProjectRootReason;
  readonly marker?: string;
  readonly evidencePath?: string;
}

const workspaceMarkers = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "rush.json"] as const;
const projectManifests = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
] as const;

function ancestors(start: string, root: string): readonly string[] {
  const result: string[] = [];
  let cursor = start;
  while (true) {
    result.push(cursor);
    if (cursor === root) return result;
    const parent = path.dirname(cursor);
    if (parent === cursor) return result;
    cursor = parent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filesystem: ContextFileSystem, targetPath: string): Promise<boolean> {
  return (await filesystem.getMetadata(targetPath)) !== null;
}

async function hasWorkspacesField(
  filesystem: ContextFileSystem,
  packagePath: string,
): Promise<boolean> {
  try {
    const file = await filesystem.readTextFile(packagePath, { maxBytes: 1024 * 1024 });
    const parsed: unknown = JSON.parse(file.text);
    return isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "workspaces");
  } catch {
    return false;
  }
}

async function findSimpleMarker(
  filesystem: ContextFileSystem,
  directories: readonly string[],
  names: readonly string[],
): Promise<ProjectRootDetectionResult | null> {
  for (const directory of directories) {
    for (const name of names) {
      const evidencePath = path.join(directory, name);
      if (await exists(filesystem, evidencePath)) {
        return {
          projectRoot: directory,
          reason: "WORKSPACE_MARKER",
          marker: name,
          evidencePath,
        };
      }
    }
  }
  return null;
}

export class ProjectRootDetector {
  constructor(private readonly filesystem: ContextFileSystem) {}

  async detect(scope: WorkspaceScope): Promise<ProjectRootDetectionResult> {
    const directories = ancestors(scope.realCwd, scope.realRoot);
    for (const directory of directories) {
      const gitPath = path.join(directory, ".git");
      if (await exists(this.filesystem, gitPath)) {
        return {
          projectRoot: directory,
          reason: "VCS_MARKER",
          marker: ".git",
          evidencePath: gitPath,
        };
      }
    }

    const simpleMarker = await findSimpleMarker(this.filesystem, directories, workspaceMarkers);
    if (simpleMarker !== null) return simpleMarker;
    for (const directory of directories) {
      const packagePath = path.join(directory, "package.json");
      if (
        (await exists(this.filesystem, packagePath)) &&
        (await hasWorkspacesField(this.filesystem, packagePath))
      ) {
        return {
          projectRoot: directory,
          reason: "WORKSPACE_MARKER",
          marker: "package.json#workspaces",
          evidencePath: packagePath,
        };
      }
    }

    for (const directory of directories) {
      for (const name of projectManifests) {
        const evidencePath = path.join(directory, name);
        if (await exists(this.filesystem, evidencePath)) {
          return { projectRoot: directory, reason: "PROJECT_MANIFEST", marker: name, evidencePath };
        }
      }
    }
    return { projectRoot: scope.realCwd, reason: "CWD_FALLBACK" };
  }
}

export { ancestors };
