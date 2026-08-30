import path from "node:path";
import type { WorkspaceRef } from "@caelush/protocol";
import { isPathInsideOrEqual } from "@caelush/shared";
import type {
  RuntimeFileKind,
  RuntimeFileMetadata,
  RuntimeFileSystem,
} from "./filesystem/types.js";
import {
  RuntimeError,
  RuntimeBoundaryError,
  RuntimePathNotFoundError,
  RuntimePathTypeError,
} from "./runtime-errors.js";
import { RuntimePatchError } from "./patch/errors.js";

export const MAX_WORKSPACE_PATH_BYTES = 4096;

export interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly realPath: string;
  readonly relativePath: string;
  readonly kind: RuntimeFileKind;
  readonly metadata: RuntimeFileMetadata;
}

export interface ResolvedMutationPath {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly metadata: RuntimeFileMetadata | null;
}

export interface ResolvedLexicalPath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

function isWindowsAbsoluteLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

function normalizeInput(value: string): string {
  return value.replaceAll("\\", "/");
}

function validateRelativeInput(value: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new RuntimeBoundaryError("workspace-relative path is invalid");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_PATH_BYTES) {
    throw new RuntimeBoundaryError("workspace-relative path exceeds its byte limit");
  }
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    isWindowsAbsoluteLike(value)
  ) {
    throw new RuntimeBoundaryError("absolute paths are not allowed");
  }
  return normalizeInput(value);
}

export class WorkspacePathResolver {
  constructor(
    private readonly scope: Readonly<{
      readonly workspace: WorkspaceRef;
      readonly logicalRoot: string;
      readonly realRoot: string;
      readonly filesystem: RuntimeFileSystem;
    }>,
  ) {}

  async resolveExisting(workspaceRelativePath: string): Promise<ResolvedWorkspacePath> {
    const normalized = validateRelativeInput(workspaceRelativePath);
    const absolutePath = path.normalize(path.resolve(this.scope.logicalRoot, normalized));
    if (!isPathInsideOrEqual(this.scope.logicalRoot, absolutePath)) {
      throw new RuntimeBoundaryError("path resolves outside the workspace");
    }
    let metadata: RuntimeFileMetadata | null;
    try {
      metadata = await this.scope.filesystem.getMetadata(absolutePath);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimePathNotFoundError("path could not be inspected", { cause: error });
    }
    if (metadata === null) throw new RuntimePathNotFoundError("path does not exist");
    let realPath: string;
    try {
      realPath = path.normalize(await this.scope.filesystem.realpath(absolutePath));
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimePathNotFoundError("path does not exist", { cause: error });
    }
    if (!isPathInsideOrEqual(this.scope.realRoot, realPath)) {
      throw new RuntimeBoundaryError("path resolves outside the workspace");
    }
    const relativePath =
      path.relative(this.scope.logicalRoot, absolutePath).replaceAll(path.sep, "/") || ".";
    return { absolutePath, realPath, relativePath, kind: metadata.kind, metadata };
  }

  async resolveMutationTarget(workspaceRelativePath: string): Promise<ResolvedMutationPath> {
    const normalized = validateRelativeInput(workspaceRelativePath);
    const absolutePath = path.normalize(path.resolve(this.scope.logicalRoot, normalized));
    if (!isPathInsideOrEqual(this.scope.logicalRoot, absolutePath)) {
      throw new RuntimePatchError("PATH_OUTSIDE_WORKSPACE");
    }
    const relativePath =
      path.relative(this.scope.logicalRoot, absolutePath).replaceAll(path.sep, "/") || ".";
    const segments = relativePath === "." ? [] : relativePath.split("/");
    let current = this.scope.logicalRoot;
    let targetMetadata: RuntimeFileMetadata | null = null;
    for (const segment of segments) {
      current = path.join(current, segment);
      targetMetadata = await this.scope.filesystem.getMetadata(current);
      if (targetMetadata === null) break;
      if (targetMetadata.kind === "SYMLINK") {
        throw new RuntimePatchError("SYMLINK_MUTATION_NOT_ALLOWED");
      }
    }
    let containmentPath = current;
    let containmentMetadata = targetMetadata;
    while (containmentMetadata === null && containmentPath !== this.scope.logicalRoot) {
      containmentPath = path.dirname(containmentPath);
      containmentMetadata = await this.scope.filesystem.getMetadata(containmentPath);
    }
    try {
      const realPath = path.normalize(await this.scope.filesystem.realpath(containmentPath));
      if (!isPathInsideOrEqual(this.scope.realRoot, realPath)) {
        throw new RuntimePatchError("PATH_OUTSIDE_WORKSPACE");
      }
    } catch (error) {
      if (error instanceof RuntimePatchError) throw error;
      throw new RuntimePatchError("PATH_NOT_FOUND");
    }
    return { absolutePath, relativePath, metadata: targetMetadata };
  }

  resolveLexical(workspaceRelativePath: string): ResolvedLexicalPath {
    const normalized = validateRelativeInput(workspaceRelativePath);
    const absolutePath = path.normalize(path.resolve(this.scope.logicalRoot, normalized));
    if (!isPathInsideOrEqual(this.scope.logicalRoot, absolutePath)) {
      throw new RuntimeBoundaryError("path resolves outside the workspace");
    }
    const relativePath =
      path.relative(this.scope.logicalRoot, absolutePath).replaceAll(path.sep, "/") || ".";
    return { absolutePath, relativePath };
  }

  assertKind(pathValue: ResolvedWorkspacePath, kind: RuntimeFileKind): void {
    if (pathValue.kind !== kind) {
      throw new RuntimePathTypeError(`path is not a ${kind.toLowerCase()}`);
    }
  }
}
