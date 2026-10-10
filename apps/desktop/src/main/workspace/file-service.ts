import { open, opendir, lstat, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { TextDecoder } from "node:util";
import path from "node:path";
import { WorkspaceIdSchema, WorkspaceRecordSchema, type WorkspaceId } from "@caelush/protocol";
import type { DesktopDaemonProxyLease } from "../protocol/local-proxy.js";

export const DESKTOP_WORKSPACE_MAX_PREVIEW_BYTES = 1024 * 1024;
export const DESKTOP_WORKSPACE_MAX_DIRECTORY_ENTRIES = 500;
export const DESKTOP_WORKSPACE_MAX_DIRECTORY_OFFSET = 100_000;
export const DESKTOP_WORKSPACE_MAX_DEPTH = 16;
const MAX_DIRECTORY_SCAN =
  DESKTOP_WORKSPACE_MAX_DIRECTORY_OFFSET + DESKTOP_WORKSPACE_MAX_DIRECTORY_ENTRIES + 1;
const MAX_WORKSPACE_RECORD_BYTES = 16 * 1024;
const HOST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PROFILE_ID_PATTERN = /^u_[0-9a-f]{64}$/u;
const RESERVED_WINDOWS_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export type DesktopWorkspaceEntryKind = "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER";

export interface DesktopWorkspaceEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: DesktopWorkspaceEntryKind;
  readonly extension: string;
  readonly sizeBytes?: number;
  readonly modifiedAtMs?: number;
  readonly canExpand: boolean;
  readonly canPreview: boolean;
}

export interface DesktopWorkspaceDirectoryPage {
  readonly workspaceId: WorkspaceId;
  readonly relativePath: string;
  readonly parentPath: string | null;
  readonly items: readonly DesktopWorkspaceEntry[];
  readonly nextOffset?: number;
  readonly hasMore: boolean;
}

export type DesktopWorkspaceTextPreview =
  | {
      readonly supported: true;
      readonly workspaceId: WorkspaceId;
      readonly relativePath: string;
      readonly name: string;
      readonly sizeBytes: number;
      readonly modifiedAtMs: number;
      readonly text: string;
    }
  | {
      readonly supported: false;
      readonly reason: "BINARY";
      readonly workspaceId: WorkspaceId;
      readonly relativePath: string;
      readonly name: string;
      readonly sizeBytes: number;
      readonly modifiedAtMs: number;
    };

export interface DesktopWorkspaceAccess {
  readonly workspaceId: WorkspaceId;
  readonly rootPath: string;
  readonly userId: string;
  readonly profileId: string;
  readonly generationId: string;
  readonly signal: AbortSignal;
}

export interface DesktopWorkspaceFileServiceOptions {
  readonly acquireLease: (signal: AbortSignal) => DesktopDaemonProxyLease | null;
  readonly fetcher?: typeof fetch;
  readonly platform?: NodeJS.Platform;
}

export type DesktopWorkspaceErrorCode =
  | "ACCOUNT_NOT_AUTHORIZED"
  | "DAEMON_UNAVAILABLE"
  | "WORKSPACE_NOT_REGISTERED"
  | "WORKSPACE_RECORD_INVALID"
  | "WORKSPACE_ROOT_UNAVAILABLE"
  | "PATH_INVALID"
  | "PATH_NOT_FOUND"
  | "PATH_NOT_FILE"
  | "PATH_NOT_DIRECTORY"
  | "PATH_REPARSE_POINT"
  | "FILE_TOO_LARGE"
  | "FILE_CHANGED"
  | "DIRECTORY_SCAN_LIMIT";

export class DesktopWorkspaceError extends Error {
  constructor(
    readonly code: DesktopWorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesktopWorkspaceError";
  }
}

export class DesktopWorkspaceFileService {
  private readonly fetcher: typeof fetch;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: DesktopWorkspaceFileServiceOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.platform = options.platform ?? process.platform;
  }

  async listEntries(
    input: {
      readonly workspaceId: WorkspaceId;
      readonly relativePath: string;
      readonly offset?: number;
      readonly limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<DesktopWorkspaceDirectoryPage> {
    const relativePath = normalizeRelativePath(input.relativePath, this.platform);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 200;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > DESKTOP_WORKSPACE_MAX_DIRECTORY_OFFSET ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > DESKTOP_WORKSPACE_MAX_DIRECTORY_ENTRIES
    ) {
      throw new DesktopWorkspaceError("PATH_INVALID", "The requested directory page is invalid.");
    }

    return this.withWorkspace(input.workspaceId, signal, async (access) => {
      const target = await resolveSafeTarget(
        access.rootPath,
        relativePath,
        "DIRECTORY",
        this.platform,
      );
      const identityBefore = await lstat(target);
      const directory = await opendir(target);
      const [openedPathIdentity, openedPath] = await Promise.all([
        lstat(target).catch(() => null),
        realpath(target).catch(() => null),
      ]);
      if (
        openedPathIdentity === null ||
        openedPathIdentity.isSymbolicLink() ||
        !openedPathIdentity.isDirectory() ||
        !sameFileIdentity(identityBefore, openedPathIdentity) ||
        openedPath === null ||
        !isWithinRoot(access.rootPath, openedPath, this.platform)
      ) {
        await directory.close().catch(() => undefined);
        throw new DesktopWorkspaceError(
          "FILE_CHANGED",
          "The directory changed while it was opened.",
        );
      }
      const selected: string[] = [];
      let seen = 0;
      let hasMore = false;
      try {
        while (true) {
          const entry = await directory.read();
          if (entry === null) break;
          if (seen >= MAX_DIRECTORY_SCAN) {
            hasMore = true;
            break;
          }
          if (seen >= offset && selected.length < limit + 1) selected.push(entry.name);
          seen += 1;
          if (selected.length > limit) {
            hasMore = true;
            selected.pop();
            break;
          }
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      if (seen >= MAX_DIRECTORY_SCAN && offset + selected.length < seen) {
        throw new DesktopWorkspaceError(
          "DIRECTORY_SCAN_LIMIT",
          "This directory exceeds the safe browsing limit.",
        );
      }
      await assertDirectoryUnchanged(target, identityBefore, access.rootPath, this.platform);
      const items = await Promise.all(
        selected.map((name) =>
          describeEntry(access.rootPath, target, name, relativePath, this.platform),
        ),
      );
      items.sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true }),
      );
      const currentParent = relativePath === "" ? null : parentRelativePath(relativePath);
      const finalHasMore = hasMore || (selected.length === limit && seen === MAX_DIRECTORY_SCAN);
      return {
        workspaceId: input.workspaceId,
        relativePath,
        parentPath: currentParent,
        items,
        ...(finalHasMore ? { nextOffset: offset + items.length } : {}),
        hasMore: finalHasMore,
      };
    });
  }

  async previewText(
    input: { readonly workspaceId: WorkspaceId; readonly relativePath: string },
    signal?: AbortSignal,
  ): Promise<DesktopWorkspaceTextPreview> {
    const relativePath = normalizeRelativePath(input.relativePath, this.platform);
    if (relativePath === "") {
      throw new DesktopWorkspaceError("PATH_INVALID", "A file path is required.");
    }

    return this.withWorkspace(input.workspaceId, signal, async (access) => {
      const absolutePath = await resolveSafeTarget(
        access.rootPath,
        relativePath,
        "FILE",
        this.platform,
      );
      const before = await lstat(absolutePath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new DesktopWorkspaceError("PATH_NOT_FILE", "This item cannot be previewed as text.");
      }
      if (before.size > DESKTOP_WORKSPACE_MAX_PREVIEW_BYTES) {
        throw new DesktopWorkspaceError("FILE_TOO_LARGE", "This file is too large to preview.");
      }

      let handle;
      try {
        const noFollow = this.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
        handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow);
      } catch {
        throw new DesktopWorkspaceError("FILE_CHANGED", "The file changed while it was opened.");
      }
      try {
        const opened = await handle.stat();
        if (!sameFileIdentity(before, opened) || !opened.isFile() || opened.nlink !== 1) {
          throw new DesktopWorkspaceError("FILE_CHANGED", "The file changed while it was opened.");
        }
        const buffer = Buffer.alloc(DESKTOP_WORKSPACE_MAX_PREVIEW_BYTES + 1);
        const read = await handle.read(buffer, 0, buffer.byteLength, 0);
        const after = await handle.stat();
        const currentPathStats = await lstat(absolutePath);
        if (
          !sameFileVersion(opened, after) ||
          !sameFileIdentity(after, currentPathStats) ||
          read.bytesRead > DESKTOP_WORKSPACE_MAX_PREVIEW_BYTES
        ) {
          throw new DesktopWorkspaceError("FILE_CHANGED", "The file changed while it was read.");
        }
        if (after.size > DESKTOP_WORKSPACE_MAX_PREVIEW_BYTES) {
          throw new DesktopWorkspaceError("FILE_TOO_LARGE", "This file is too large to preview.");
        }
        const bytes = buffer.subarray(0, read.bytesRead);
        const common = {
          workspaceId: input.workspaceId,
          relativePath,
          name: pathFor(this.platform).basename(absolutePath),
          sizeBytes: after.size,
          modifiedAtMs: Math.trunc(after.mtimeMs),
        };
        if (bytes.includes(0)) return { ...common, supported: false, reason: "BINARY" };
        try {
          const text = new TextDecoder("utf-8", { fatal: true })
            .decode(bytes)
            .replace(/^\uFEFF/u, "");
          return { ...common, supported: true, text };
        } catch {
          return { ...common, supported: false, reason: "BINARY" };
        }
      } finally {
        await handle.close();
      }
    });
  }

  async authorizeWorkspace(
    workspaceId: WorkspaceId,
    signal?: AbortSignal,
  ): Promise<DesktopWorkspaceAccess> {
    return this.withWorkspace(workspaceId, signal, async (access) => access);
  }

  async withWorkspace<T>(
    workspaceId: WorkspaceId,
    signal: AbortSignal | undefined,
    action: (access: DesktopWorkspaceAccess) => Promise<T>,
  ): Promise<T> {
    if (!WorkspaceIdSchema.safeParse(workspaceId).success) {
      throw new DesktopWorkspaceError("PATH_INVALID", "The Workspace identity is invalid.");
    }
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    signal?.addEventListener("abort", abortRequest, { once: true });
    if (signal?.aborted) requestController.abort();
    const lease = this.options.acquireLease(requestController.signal);
    if (lease === null) {
      signal?.removeEventListener("abort", abortRequest);
      throw new DesktopWorkspaceError("ACCOUNT_NOT_AUTHORIZED", "Sign in to use this Workspace.");
    }
    try {
      if (
        lease.signal.aborted ||
        !HOST_TOKEN_PATTERN.test(lease.hostToken) ||
        !PROFILE_ID_PATTERN.test(lease.profileId) ||
        lease.profile.profileId !== lease.profileId
      ) {
        throw unauthorizedError();
      }
      const recordUrl = new URL(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
        lease.baseUrl,
      );
      const response = await this.fetcher(recordUrl, {
        method: "GET",
        headers: {
          origin: lease.baseUrl,
          "x-caelush-host-token": lease.hostToken,
        },
        redirect: "manual",
        signal: lease.signal,
      });
      if (response.status === 404) {
        throw new DesktopWorkspaceError(
          "WORKSPACE_NOT_REGISTERED",
          "This Workspace is not registered in the active Profile.",
        );
      }
      if (!response.ok) {
        throw new DesktopWorkspaceError(
          "DAEMON_UNAVAILABLE",
          "The protected local Agent could not verify this Workspace.",
        );
      }
      const recordBytes = await readBoundedResponse(response, MAX_WORKSPACE_RECORD_BYTES);
      let rawRecord: unknown;
      try {
        rawRecord = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recordBytes));
      } catch {
        throw new DesktopWorkspaceError(
          "WORKSPACE_RECORD_INVALID",
          "The local Agent returned an invalid Workspace record.",
        );
      }
      const record = WorkspaceRecordSchema.safeParse(rawRecord);
      if (!record.success || record.data.id !== workspaceId) {
        throw new DesktopWorkspaceError(
          "WORKSPACE_RECORD_INVALID",
          "The local Agent returned an invalid Workspace record.",
        );
      }
      const rootPath = await verifyWorkspaceRoot(record.data.canonicalPath, this.platform);
      const access: DesktopWorkspaceAccess = {
        workspaceId,
        rootPath,
        userId: lease.userId,
        profileId: lease.profileId,
        generationId: lease.generationId,
        signal: lease.signal,
      };
      if (requestController.signal.aborted || lease.signal.aborted) throw unauthorizedError();
      const result = await action(access);
      if (requestController.signal.aborted || lease.signal.aborted) throw unauthorizedError();
      return result;
    } catch (error) {
      if (error instanceof DesktopWorkspaceError) throw error;
      if (requestController.signal.aborted || lease.signal.aborted) throw unauthorizedError();
      if (isNotFound(error)) {
        throw new DesktopWorkspaceError(
          "PATH_NOT_FOUND",
          "The file or directory no longer exists.",
        );
      }
      throw new DesktopWorkspaceError(
        "DAEMON_UNAVAILABLE",
        "The Workspace request could not be completed safely.",
      );
    } finally {
      signal?.removeEventListener("abort", abortRequest);
      lease.release();
    }
  }
}

export function normalizeRelativePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    value.includes("\0")
  ) {
    throw new DesktopWorkspaceError("PATH_INVALID", "The Workspace path is invalid.");
  }
  if (value === "" || value === ".") return "";
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new DesktopWorkspaceError("PATH_INVALID", "The Workspace path must be relative.");
  }
  const separators = platform === "win32" ? /[\\/]/u : /\//u;
  if (platform === "win32" && value.includes("\\")) {
    throw new DesktopWorkspaceError("PATH_INVALID", "The Workspace path format is invalid.");
  }
  const parts = value.split(separators);
  if (
    parts.length > DESKTOP_WORKSPACE_MAX_DEPTH ||
    parts.some((part) => !isSafePathSegment(part, platform))
  ) {
    throw new DesktopWorkspaceError(
      "PATH_INVALID",
      "The Workspace path contains an unsupported segment.",
    );
  }
  return parts.join("/");
}

export function isSafePathSegment(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (value.length === 0 || value === "." || value === ".." || /[\u0000-\u001f\u007f]/u.test(value))
    return false;
  if (/%(?:2e|2f|5c)/iu.test(value)) return false;
  if (platform === "win32") {
    return (
      !/[<>:"|?*\\/]/u.test(value) && !/[. ]$/u.test(value) && !RESERVED_WINDOWS_NAMES.test(value)
    );
  }
  return !value.includes("/");
}

export async function resolveWorkspaceFilePath(
  rootPath: string,
  relativePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const normalized = normalizeRelativePath(relativePath, platform);
  if (normalized === "") {
    throw new DesktopWorkspaceError("PATH_INVALID", "A file path is required.");
  }
  return resolveSafeTarget(rootPath, normalized, "FILE", platform);
}

async function describeEntry(
  rootPath: string,
  directoryPath: string,
  name: string,
  relativeDirectory: string,
  platform: NodeJS.Platform,
): Promise<DesktopWorkspaceEntry> {
  const entryPath = pathFor(platform).join(directoryPath, name);
  let metadata;
  try {
    metadata = await lstat(entryPath);
  } catch {
    throw new DesktopWorkspaceError(
      "FILE_CHANGED",
      "A directory entry changed while it was listed.",
    );
  }
  const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
  const validName = isSafePathSegment(name, platform);
  const kind: DesktopWorkspaceEntryKind = metadata.isSymbolicLink()
    ? "SYMLINK"
    : metadata.isDirectory()
      ? "DIRECTORY"
      : metadata.isFile() && metadata.nlink === 1
        ? "FILE"
        : "OTHER";
  const canonicalEntry = await realpath(entryPath).catch(() => null);
  if (canonicalEntry !== null && !isWithinRoot(rootPath, canonicalEntry, platform)) {
    return {
      name,
      relativePath,
      kind: "SYMLINK",
      extension: pathFor(platform).extname(name).slice(0, 32).toLowerCase(),
      canExpand: false,
      canPreview: false,
    };
  }
  return {
    name,
    relativePath,
    kind: validName ? kind : "OTHER",
    extension: pathFor(platform).extname(name).slice(0, 32).toLowerCase(),
    ...(metadata.isFile() ? { sizeBytes: metadata.size } : {}),
    modifiedAtMs: Math.trunc(metadata.mtimeMs),
    canExpand: validName && kind === "DIRECTORY",
    canPreview: validName && kind === "FILE",
  };
}

async function resolveSafeTarget(
  rootPath: string,
  relativePath: string,
  expectedKind: "FILE" | "DIRECTORY",
  platform: NodeJS.Platform,
): Promise<string> {
  const segments = relativePath === "" ? [] : relativePath.split("/");
  let current = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    current = pathFor(platform).join(current, segments[index]!);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      throw new DesktopWorkspaceError("PATH_NOT_FOUND", "The file or directory no longer exists.");
    }
    if (metadata.isSymbolicLink()) {
      throw new DesktopWorkspaceError(
        "PATH_REPARSE_POINT",
        "Workspace links are not followed by the Desktop file browser.",
      );
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new DesktopWorkspaceError(
        "PATH_NOT_DIRECTORY",
        "A Workspace path segment is not a directory.",
      );
    }
    if (!metadata.isFile() && !metadata.isDirectory()) {
      throw new DesktopWorkspaceError(
        "PATH_REPARSE_POINT",
        "Special filesystem entries cannot be opened.",
      );
    }
    const canonical = await realpath(current).catch(() => null);
    if (canonical === null || !isWithinRoot(rootPath, canonical, platform)) {
      throw new DesktopWorkspaceError(
        "PATH_REPARSE_POINT",
        "The requested path escapes the Workspace root.",
      );
    }
  }
  const metadata = await lstat(current);
  if (metadata.isSymbolicLink()) {
    throw new DesktopWorkspaceError(
      "PATH_REPARSE_POINT",
      "Workspace links are not followed by the Desktop file browser.",
    );
  }
  if (expectedKind === "DIRECTORY" && !metadata.isDirectory()) {
    throw new DesktopWorkspaceError("PATH_NOT_DIRECTORY", "The selected item is not a directory.");
  }
  if (expectedKind === "FILE" && !metadata.isFile()) {
    throw new DesktopWorkspaceError("PATH_NOT_FILE", "The selected item is not a regular file.");
  }
  const canonical = await realpath(current).catch(() => null);
  if (canonical === null || !isWithinRoot(rootPath, canonical, platform)) {
    throw new DesktopWorkspaceError(
      "PATH_REPARSE_POINT",
      "The requested path escapes the Workspace root.",
    );
  }
  return current;
}

async function verifyWorkspaceRoot(value: string, platform: NodeJS.Platform): Promise<string> {
  if (!pathFor(platform).isAbsolute(value)) {
    throw new DesktopWorkspaceError(
      "WORKSPACE_ROOT_UNAVAILABLE",
      "The registered Workspace root is unavailable.",
    );
  }
  const rootPath = pathFor(platform).resolve(value);
  try {
    const metadata = await lstat(rootPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("unsafe root");
    const canonical = await realpath(rootPath);
    if (!samePath(rootPath, canonical, platform)) throw new Error("changed root");
    return canonical;
  } catch {
    throw new DesktopWorkspaceError(
      "WORKSPACE_ROOT_UNAVAILABLE",
      "The registered Workspace root is unavailable or unsafe.",
    );
  }
}

async function assertDirectoryUnchanged(
  directoryPath: string,
  before: Awaited<ReturnType<typeof lstat>>,
  rootPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const [after, canonical] = await Promise.all([
    lstat(directoryPath).catch(() => null),
    realpath(directoryPath).catch(() => null),
  ]);
  if (
    after === null ||
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameFileIdentity(before, after) ||
    canonical === null ||
    !isWithinRoot(rootPath, canonical, platform)
  ) {
    throw new DesktopWorkspaceError("FILE_CHANGED", "The directory changed while it was listed.");
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    throw new DesktopWorkspaceError(
      "WORKSPACE_RECORD_INVALID",
      "The local Agent returned an invalid Workspace record.",
    );
  }
  if (response.body === null)
    throw new DesktopWorkspaceError(
      "WORKSPACE_RECORD_INVALID",
      "The local Agent returned an empty Workspace record.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new DesktopWorkspaceError(
          "WORKSPACE_RECORD_INVALID",
          "The local Agent returned an oversized Workspace record.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parentRelativePath(value: string): string {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? (path.win32 as unknown as typeof path.posix) : path.posix;
}

function isWithinRoot(rootPath: string, candidatePath: string, platform: NodeJS.Platform): boolean {
  const implementation = pathFor(platform);
  const relative = implementation.relative(
    implementation.resolve(rootPath),
    implementation.resolve(candidatePath),
  );
  return relative === "" || (!relative.startsWith("..") && !implementation.isAbsolute(relative));
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const implementation = pathFor(platform);
  const normalize = (value: string) => implementation.resolve(value).replace(/[\\/]+$/u, "");
  const a = normalize(left);
  const b = normalize(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameFileIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameFileVersion(
  left: {
    readonly dev: number | bigint;
    readonly ino: number | bigint;
    readonly size: number | bigint;
    readonly mtimeMs: number | bigint;
  },
  right: {
    readonly dev: number | bigint;
    readonly ino: number | bigint;
    readonly size: number | bigint;
    readonly mtimeMs: number | bigint;
  },
): boolean {
  return (
    sameFileIdentity(left, right) &&
    String(left.size) === String(right.size) &&
    String(left.mtimeMs) === String(right.mtimeMs)
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function unauthorizedError(): DesktopWorkspaceError {
  return new DesktopWorkspaceError(
    "ACCOUNT_NOT_AUTHORIZED",
    "The active account or Daemon generation changed.",
  );
}
