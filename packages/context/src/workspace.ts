import path from "node:path";
import type { WorkspaceRef } from "@caelush/protocol";
import { ContextBoundaryError, ContextInvalidWorkspaceError } from "./errors.js";
import type { ContextFileSystem } from "./filesystem.js";

export interface WorkspaceScope {
  readonly workspace: WorkspaceRef;
  readonly logicalRoot: string;
  readonly realRoot: string;
  readonly cwd: string;
  readonly realCwd: string;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "" || path.isAbsolute(relative)) return true;
  return relative.split(path.sep)[0] !== "..";
}

async function resolveRealPath(
  filesystem: ContextFileSystem,
  targetPath: string,
  description: string,
): Promise<string> {
  try {
    return await filesystem.realpath(targetPath);
  } catch (error) {
    throw new ContextInvalidWorkspaceError(`${description} does not exist: ${targetPath}`, {
      cause: error,
    });
  }
}

export class WorkspaceScopeResolver {
  constructor(private readonly filesystem: ContextFileSystem) {}

  async resolve(workspace: WorkspaceRef, cwd?: string): Promise<WorkspaceScope> {
    if (!path.isAbsolute(workspace.path)) {
      throw new ContextInvalidWorkspaceError("workspace.path must be an absolute path");
    }

    const logicalRoot = path.normalize(workspace.path);
    const rootMetadata = await this.filesystem.getMetadata(logicalRoot);
    if (rootMetadata === null) {
      throw new ContextInvalidWorkspaceError(`workspace does not exist: ${logicalRoot}`);
    }
    const realRoot = await resolveRealPath(this.filesystem, logicalRoot, "workspace");
    const realRootMetadata = await this.filesystem.getMetadata(realRoot);
    if (realRootMetadata?.kind !== "DIRECTORY") {
      throw new ContextInvalidWorkspaceError(`workspace is not a directory: ${logicalRoot}`);
    }

    const logicalCwd =
      cwd === undefined
        ? logicalRoot
        : path.isAbsolute(cwd)
          ? path.normalize(cwd)
          : path.resolve(logicalRoot, cwd);
    if (!isInside(logicalRoot, logicalCwd)) {
      throw new ContextBoundaryError(`cwd is outside workspace: ${logicalCwd}`);
    }

    const realCwd = await resolveRealPath(this.filesystem, logicalCwd, "cwd");
    if (!isInside(realRoot, realCwd)) {
      throw new ContextBoundaryError(`cwd resolves outside workspace: ${realCwd}`);
    }

    return { workspace, logicalRoot, realRoot, cwd: logicalCwd, realCwd };
  }
}

export function isWithinWorkspace(root: string, candidate: string): boolean {
  return isInside(root, candidate);
}
