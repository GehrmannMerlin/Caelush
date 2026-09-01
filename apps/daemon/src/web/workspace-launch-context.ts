import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  WorkspaceIdSchema,
  WorkspaceRefSchema,
  type WorkspaceId,
  type WorkspaceRef,
} from "@caelush/protocol";

export function createWorkspaceRef(workspacePath: string): WorkspaceRef {
  const canonicalPath = canonicalWorkspacePath(workspacePath);
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

function canonicalWorkspacePath(workspacePath: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(workspacePath);
  } catch {
    throw new Error("The Web workspace is unavailable.");
  }
  try {
    if (!statSync(canonicalPath).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("The Web workspace is unavailable.");
  }
  return canonicalPath;
}
