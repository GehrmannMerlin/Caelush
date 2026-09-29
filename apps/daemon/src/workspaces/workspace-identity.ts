import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import {
  WorkspaceIdSchema,
  WorkspaceRefSchema,
  type WorkspaceId,
  type WorkspaceRef,
} from "@caelush/protocol";

export class WorkspacePathError extends Error {
  constructor(message = "Workspace path must be an existing absolute directory.") {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export function canonicalizeWorkspacePath(workspacePath: string): string {
  const candidate = workspacePath.trim();
  if (candidate.length === 0 || !isAbsolute(candidate)) throw new WorkspacePathError();

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(candidate);
    if (!statSync(canonicalPath).isDirectory()) throw new WorkspacePathError();
  } catch (error) {
    if (error instanceof WorkspacePathError) throw error;
    throw new WorkspacePathError();
  }
  return normalizeWorkspaceIdentityPath(canonicalPath);
}

export function createWorkspaceRef(workspacePath: string): WorkspaceRef {
  const canonicalPath = canonicalizeWorkspacePath(workspacePath);
  return WorkspaceRefSchema.parse({
    id: createStableWorkspaceId(canonicalPath),
    path: canonicalPath,
  });
}

export function createStableWorkspaceId(workspacePath: string): WorkspaceId {
  const normalizedPath = normalizeWorkspaceIdentityPath(workspacePath);
  const bytes = createHash("sha256").update(normalizedPath, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] ?? 0) & 0x0f;
  bytes[6] = (bytes[6] ?? 0) | 0x70;
  bytes[8] = (bytes[8] ?? 0) & 0x3f;
  bytes[8] = (bytes[8] ?? 0) | 0x80;
  const hex = bytes.toString("hex");
  return WorkspaceIdSchema.parse(
    `wsp_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export function normalizeWorkspaceIdentityPath(workspacePath: string): string {
  const normalized = resolve(workspacePath).replaceAll("\\", "/");
  const withoutTrailingSlash =
    normalized.length > 1 && !/^[A-Za-z]:\/$/.test(normalized)
      ? normalized.replace(/\/+$/, "")
      : normalized;
  return process.platform === "win32" ? withoutTrailingSlash.toLowerCase() : withoutTrailingSlash;
}

export function displayNameForWorkspacePath(canonicalPath: string): string {
  return basename(canonicalPath) || canonicalPath;
}
