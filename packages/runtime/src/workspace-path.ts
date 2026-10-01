import path from "node:path";
import type { WorkspaceRef } from "@caelush/protocol";
import type {
  RuntimeFileKind,
  RuntimeFileMetadata,
  RuntimeFileSystem,
} from "./filesystem/types.js";
import type { RuntimeFilesystemPolicy } from "./security/runtime-boundary.js";
import {
  RuntimeBoundaryError,
  RuntimeError,
  RuntimeFilesystemAccessDeniedError,
  RuntimePathNotFoundError,
  RuntimePathTypeError,
  RuntimeProtectedRootMutationError,
  RuntimeWorkspaceBoundaryMismatchError,
} from "./runtime-errors.js";
import { RuntimePatchError } from "./patch/errors.js";

export const MAX_WORKSPACE_PATH_BYTES = 4096;

export type RuntimeFilesystemOperation = "READ" | "LIST" | "SEARCH" | "WRITE" | "DELETE" | "MOVE";
export type FilesystemTargetRelation = "WORKSPACE" | "HOST_USER";
export type FilesystemTargetIndirection = "DIRECT" | "SYMLINK" | "REPARSE";

export interface ResolvedFilesystemTarget {
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly relation: FilesystemTargetRelation;
  readonly indirection: FilesystemTargetIndirection;
  readonly kind: RuntimeFileKind;
  readonly targetKind: RuntimeFileKind;
  readonly metadata: RuntimeFileMetadata | null;
  readonly identity?: string;
}

export interface ResolveFilesystemTargetInput {
  readonly path: string;
  readonly policy: RuntimeFilesystemPolicy;
  readonly operation: RuntimeFilesystemOperation;
  readonly allowMissing?: boolean;
}

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
  readonly canonicalPath?: string;
  readonly identity?: string;
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

function isAbsoluteInput(value: string): boolean {
  return (
    path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || isWindowsAbsoluteLike(value)
  );
}

function validatePathInput(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new RuntimeBoundaryError("filesystem path is invalid");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_PATH_BYTES) {
    throw new RuntimeBoundaryError("filesystem path exceeds its byte limit");
  }
  return normalizeInput(value);
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function classifyRelation(
  policy: RuntimeFilesystemPolicy,
  candidate: string,
  workspaceAlias?: string,
): FilesystemTargetRelation | undefined {
  if (
    isPathInsideOrEqual(policy.workspaceRoot, candidate) ||
    (workspaceAlias !== undefined && isPathInsideOrEqual(workspaceAlias, candidate))
  ) {
    return "WORKSPACE";
  }
  if (
    policy.boundary === "HOST_USER_SCOPE" &&
    isPathInsideOrEqual(policy.hostUserRoot, candidate)
  ) {
    return "HOST_USER";
  }
  return undefined;
}

function isMutation(operation: RuntimeFilesystemOperation): boolean {
  return operation === "WRITE" || operation === "DELETE" || operation === "MOVE";
}

function isProtectedTarget(policy: RuntimeFilesystemPolicy, candidate: string): boolean {
  if (path.normalize(candidate) === path.normalize(policy.hostUserRoot)) return true;
  return policy.protectedRoots.some((root) => isPathInsideOrEqual(root, candidate));
}

function assertTargetAllowed(
  policy: RuntimeFilesystemPolicy,
  relation: FilesystemTargetRelation | undefined,
  operation: RuntimeFilesystemOperation,
  canonicalPath: string,
): FilesystemTargetRelation {
  if (relation === undefined) {
    throw new RuntimeBoundaryError("path resolves outside the active filesystem boundary");
  }
  if (isMutation(operation)) {
    if (policy.boundary === "WORKSPACE_READ_ONLY") {
      throw new RuntimeFilesystemAccessDeniedError("The active filesystem policy is read-only.");
    }
    if (relation === "HOST_USER" && policy.boundary !== "HOST_USER_SCOPE") {
      throw new RuntimeFilesystemAccessDeniedError(
        "The active filesystem policy is workspace-bound.",
      );
    }
    if (isProtectedTarget(policy, canonicalPath)) {
      throw new RuntimeProtectedRootMutationError();
    }
  }
  return relation;
}

function relativeDisplayPath(
  logicalRoot: string,
  lexicalPath: string,
  canonicalPath: string,
): string {
  if (isPathInsideOrEqual(logicalRoot, lexicalPath)) {
    return path.relative(logicalRoot, lexicalPath).replaceAll(path.sep, "/") || ".";
  }
  return canonicalPath;
}

async function resolveExistingAncestor(
  filesystem: RuntimeFileSystem,
  absolutePath: string,
  operation: RuntimeFilesystemOperation,
): Promise<{ readonly canonicalPath: string; readonly indirection: FilesystemTargetIndirection }> {
  let current = absolutePath;
  const missingSegments: string[] = [];
  while ((await filesystem.getMetadata(current)) === null) {
    const parent = path.dirname(current);
    if (parent === current) throw new RuntimePathNotFoundError("path does not exist");
    missingSegments.push(path.basename(current));
    current = parent;
  }
  const metadata = await filesystem.getMetadata(current);
  if (metadata?.kind === "SYMLINK") {
    if (isMutation(operation)) throw new RuntimePatchError("SYMLINK_MUTATION_NOT_ALLOWED");
    return {
      canonicalPath: path.join(await filesystem.realpath(current), ...missingSegments.reverse()),
      indirection: "SYMLINK",
    };
  }
  return {
    canonicalPath: path.join(await filesystem.realpath(current), ...missingSegments.reverse()),
    indirection: "DIRECT",
  };
}

export class WorkspacePathResolver {
  constructor(
    private readonly scope: Readonly<{
      readonly workspace: WorkspaceRef;
      readonly logicalRoot: string;
      readonly realRoot: string;
      readonly filesystem: RuntimeFileSystem;
      readonly policy: RuntimeFilesystemPolicy;
    }>,
  ) {}

  async resolveFilesystemTarget(
    input: ResolveFilesystemTargetInput,
  ): Promise<ResolvedFilesystemTarget> {
    if (
      input.policy.workspaceId !== this.scope.policy.workspaceId ||
      path.normalize(input.policy.workspaceRoot) !== path.normalize(this.scope.policy.workspaceRoot)
    ) {
      throw new RuntimeWorkspaceBoundaryMismatchError(
        "filesystem policy does not match the opened workspace",
      );
    }
    const normalized = validatePathInput(input.path);
    const absoluteInput = isAbsoluteInput(normalized);
    const absolutePath = path.normalize(
      absoluteInput ? normalized : path.resolve(this.scope.logicalRoot, normalized),
    );
    const lexicalRelation = classifyRelation(input.policy, absolutePath, this.scope.realRoot);
    if (lexicalRelation === undefined) {
      throw new RuntimeBoundaryError("path resolves outside the active filesystem boundary");
    }

    const metadata = await this.scope.filesystem.getMetadata(absolutePath);
    let canonicalPath: string;
    let indirection: FilesystemTargetIndirection = "DIRECT";
    let targetKind: RuntimeFileKind = "MISSING";
    if (metadata === null) {
      if (input.allowMissing !== true) throw new RuntimePathNotFoundError("path does not exist");
      const ancestor = await resolveExistingAncestor(
        this.scope.filesystem,
        absolutePath,
        input.operation,
      );
      canonicalPath = path.normalize(ancestor.canonicalPath);
      indirection = ancestor.indirection;
    } else {
      targetKind = metadata.kind;
      try {
        canonicalPath = path.normalize(await this.scope.filesystem.realpath(absolutePath));
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimePathNotFoundError("path could not be canonicalized", { cause: error });
      }
      if (metadata.kind === "SYMLINK") indirection = "SYMLINK";
      const canonicalMetadata = await this.scope.filesystem.getMetadata(canonicalPath);
      if (canonicalMetadata !== null) targetKind = canonicalMetadata.kind;
    }
    const relation = assertTargetAllowed(
      input.policy,
      classifyRelation(input.policy, canonicalPath, this.scope.realRoot),
      input.operation,
      canonicalPath,
    );
    if (isMutation(input.operation) && indirection !== "DIRECT") {
      throw new RuntimePatchError("SYMLINK_MUTATION_NOT_ALLOWED");
    }
    const displayPath = relativeDisplayPath(this.scope.logicalRoot, absolutePath, canonicalPath);
    return {
      absolutePath,
      canonicalPath,
      relativePath: displayPath,
      relation,
      indirection,
      kind: metadata?.kind ?? "MISSING",
      targetKind,
      metadata,
      ...(metadata?.identity === undefined ? {} : { identity: metadata.identity }),
    };
  }

  async resolveExisting(workspacePath: string): Promise<ResolvedWorkspacePath> {
    const target = await this.resolveFilesystemTarget({
      path: workspacePath,
      policy: this.scope.policy,
      operation: "READ",
    });
    if (target.kind === "MISSING") throw new RuntimePathNotFoundError("path does not exist");
    return {
      absolutePath: target.absolutePath,
      realPath: target.canonicalPath,
      relativePath: target.relativePath,
      kind: target.kind,
      metadata: target.metadata!,
    };
  }

  async resolveMutationTarget(workspacePath: string): Promise<ResolvedMutationPath> {
    const target = await this.resolveFilesystemTarget({
      path: workspacePath,
      policy: this.scope.policy,
      operation: "WRITE",
      allowMissing: true,
    });
    return {
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      metadata: target.metadata,
      canonicalPath: target.canonicalPath,
      ...(target.identity === undefined ? {} : { identity: target.identity }),
    };
  }

  resolveLexical(workspacePath: string): ResolvedLexicalPath {
    const normalized = validatePathInput(workspacePath);
    const absolutePath = path.normalize(
      isAbsoluteInput(normalized) ? normalized : path.resolve(this.scope.logicalRoot, normalized),
    );
    if (classifyRelation(this.scope.policy, absolutePath, this.scope.realRoot) === undefined) {
      throw new RuntimeBoundaryError("path resolves outside the active filesystem boundary");
    }
    return {
      absolutePath,
      relativePath: relativeDisplayPath(this.scope.logicalRoot, absolutePath, absolutePath),
    };
  }

  assertKind(pathValue: ResolvedWorkspacePath, kind: RuntimeFileKind): void {
    if (pathValue.kind !== kind) {
      throw new RuntimePathTypeError(`path is not a ${kind.toLowerCase()}`);
    }
  }
}
