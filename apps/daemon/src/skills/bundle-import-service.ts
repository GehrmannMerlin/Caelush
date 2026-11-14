import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SkillNameSchema } from "@caelush/protocol";
import {
  createSkillIdentity,
  parseSkillManifest,
  type SkillManifest,
  type SkillScopeRank,
} from "@caelush/skills";
import { DEFAULT_SKILL_FILESYSTEM_POLICY, resolveSkillFilesystemPolicy } from "./skill-policy.js";
import {
  createSkillPackageFingerprint,
  normalizeSkillRelativePath,
  type SkillPackageFile,
} from "./skill-package.js";

const KiB = 1024;
const SAFE_MESSAGES = {
  SKILL_IMPORT_INVALID: "The selected Skill files are invalid or outside the allowed package.",
  SKILL_IMPORT_CANCELLED: "Skill import was cancelled before publication.",
  SKILL_IMPORT_STALE: "The installed Skill changed; refresh it before importing an update.",
  SKILL_IMPORT_PUBLISH_FAILED:
    "The Skill could not be published; the previous package was restored.",
  SKILL_PACKAGE_TOO_LARGE: "The Skill package exceeds its size limit.",
  SKILL_RESOURCE_TOO_LARGE: "A Skill resource exceeds its size limit.",
  SKILL_PACKAGE_FILE_LIMIT: "The Skill package exceeds its file count limit.",
  SYMLINK_ESCAPE: "A Skill destination contains a link outside its allowed directory.",
} as const;

export type SkillImportErrorCode = keyof typeof SAFE_MESSAGES;

export class SkillImportServiceError extends Error {
  constructor(readonly code: SkillImportErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "SkillImportServiceError";
  }
}

export type SkillImportTarget = "CURRENT_PROJECT" | "ALL_PROJECTS";

export interface SkillImportFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export interface SkillImportReceipt {
  readonly skillId: string;
  readonly name: string;
  readonly target: SkillImportTarget;
  readonly bundleRevision: string;
  readonly replaced: boolean;
}

export interface SkillImportService {
  import(input: {
    readonly workspaceId: string;
    readonly target: SkillImportTarget;
    readonly files: readonly SkillImportFile[];
    readonly expectedRevision?: string;
    readonly signal: AbortSignal;
  }): Promise<SkillImportReceipt>;
  recover(workspaceId: string, target: SkillImportTarget): Promise<void>;
}

export interface SkillImportServiceOptions {
  readonly userRoot: string;
  readonly resolveWorkspaceRoot: (workspaceId: string) => Promise<string>;
  readonly policy?: Partial<typeof DEFAULT_SKILL_FILESYSTEM_POLICY>;
  readonly afterFileStaged?: (relativePath: string) => void | Promise<void>;
}

interface ScopePaths {
  readonly rootDirectory: string;
  readonly stagingDirectory: string;
  readonly stagingParent: string;
}

export function createSkillImportService(options: SkillImportServiceOptions): SkillImportService {
  const policy = resolveSkillFilesystemPolicy(options.policy);
  const userRoot = resolve(options.userRoot);
  let operationQueue: Promise<void> = Promise.resolve();

  const service: SkillImportService = {
    async import(input) {
      return withOperationLock(async () => {
        checkCancelled(input.signal);
        if (input.target !== "CURRENT_PROJECT" && input.target !== "ALL_PROJECTS") {
          throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
        }
        const prepared = validateImportFiles(input.files, policy);
        const scope = await resolveScopePaths(input.workspaceId, input.target);
        await mkdir(scope.stagingDirectory, { recursive: true });
        await ensureSafeStagingDirectory(scope);
        await recoverStaging(scope);
        const targetName = prepared.manifest.name;
        const destination = join(scope.rootDirectory, targetName);
        if (!isWithin(scope.rootDirectory, destination)) {
          throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
        }
        const previous = await inspectDestination(destination, scope.rootDirectory, policy);
        if (input.expectedRevision !== undefined) {
          if (previous === undefined || previous.bundleRevision !== input.expectedRevision) {
            throw new SkillImportServiceError("SKILL_IMPORT_STALE");
          }
        }

        const stagePath = join(scope.stagingDirectory, `stage-${targetName}-${randomUUID()}`);
        const backupPath = join(scope.stagingDirectory, `backup-${targetName}-${randomUUID()}`);
        let previousMoved = false;
        let published = false;
        try {
          await mkdir(stagePath, { recursive: false });
          for (const file of prepared.files) {
            checkCancelled(input.signal);
            const destinationFile = join(stagePath, ...file.relativePath.split("/"));
            await mkdir(dirname(destinationFile), { recursive: true });
            await writeFile(destinationFile, file.bytes, { flag: "wx", mode: 0o600 });
            await options.afterFileStaged?.(file.relativePath);
            checkCancelled(input.signal);
          }
          const staged = await readPackageFromDisk(
            stagePath,
            scope.stagingDirectory,
            policy,
            input.signal,
          );
          if (staged.bundleRevision !== prepared.bundleRevision) {
            throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
          }
          checkCancelled(input.signal);
          const currentRoot = await realpath(scope.rootDirectory);
          if (currentRoot !== scope.rootDirectory)
            throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
          if (input.expectedRevision !== undefined) {
            const latestPrevious = await inspectDestination(
              destination,
              scope.rootDirectory,
              policy,
            );
            if (latestPrevious?.bundleRevision !== input.expectedRevision) {
              throw new SkillImportServiceError("SKILL_IMPORT_STALE");
            }
          }
          const destinationState = await inspectDestination(
            destination,
            scope.rootDirectory,
            policy,
          );
          if (destinationState !== undefined) {
            await rename(destination, backupPath);
            previousMoved = true;
          }
          checkCancelled(input.signal);
          await rename(stagePath, destination);
          published = true;
          if (previousMoved)
            await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
        } catch (error) {
          if (!published && previousMoved) {
            const destinationExists = await lstat(destination).then(
              () => true,
              () => false,
            );
            if (!destinationExists) await rename(backupPath, destination).catch(() => undefined);
          }
          await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
          if (error instanceof SkillImportServiceError) throw error;
          if (input.signal.aborted || isAbortError(error)) {
            throw new SkillImportServiceError("SKILL_IMPORT_CANCELLED");
          }
          throw new SkillImportServiceError("SKILL_IMPORT_PUBLISH_FAILED");
        }

        const rank: SkillScopeRank = input.target === "CURRENT_PROJECT" ? 0 : 1;
        const providerId =
          input.target === "CURRENT_PROJECT" ? `project:${input.workspaceId}` : "user";
        const kind = input.target === "CURRENT_PROJECT" ? "PROJECT" : "USER";
        const privateLocator = JSON.stringify({
          kind,
          ...(input.target === "CURRENT_PROJECT" ? { workspaceId: input.workspaceId } : {}),
          providerId,
          relativePath: targetName,
        });
        const skillId = createSkillIdentity({ scopeRank: rank, providerId, privateLocator });
        return Object.freeze({
          skillId,
          name: targetName,
          target: input.target,
          bundleRevision: prepared.bundleRevision,
          replaced: previous !== undefined,
        });
      });
    },

    async recover(workspaceId, target) {
      return withOperationLock(async () => {
        if (target !== "CURRENT_PROJECT" && target !== "ALL_PROJECTS") {
          throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
        }
        const scope = await resolveScopePaths(workspaceId, target);
        await mkdir(scope.stagingDirectory, { recursive: true });
        await ensureSafeStagingDirectory(scope);
        await recoverStaging(scope);
      });
    },
  };
  return service;

  function withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function resolveScopePaths(
    workspaceId: string,
    target: SkillImportTarget,
  ): Promise<ScopePaths> {
    if (workspaceId.length < 1 || workspaceId.length > 256)
      throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    if (target === "ALL_PROJECTS") {
      await mkdir(userRoot, { recursive: true });
      const rootDirectory = await realpath(userRoot);
      return {
        rootDirectory,
        stagingDirectory: join(dirname(rootDirectory), ".skills-import-staging"),
        stagingParent: dirname(rootDirectory),
      };
    }
    let workspacePath: string;
    try {
      workspacePath = await realpath(await options.resolveWorkspaceRoot(workspaceId));
    } catch {
      throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    }
    const rootPath = join(workspacePath, ".agents", "skills");
    await mkdir(rootPath, { recursive: true });
    const rootDirectory = await realpath(rootPath);
    if (!isWithin(workspacePath, rootDirectory))
      throw new SkillImportServiceError("SYMLINK_ESCAPE");
    const stagingDirectory = join(dirname(rootDirectory), ".skills-import-staging");
    const canonicalStagingParent = await realpath(dirname(rootDirectory));
    if (!isWithin(workspacePath, canonicalStagingParent))
      throw new SkillImportServiceError("SYMLINK_ESCAPE");
    return { rootDirectory, stagingDirectory, stagingParent: canonicalStagingParent };
  }

  async function ensureSafeStagingDirectory(scope: ScopePaths): Promise<void> {
    try {
      const info = await lstat(scope.stagingDirectory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new SkillImportServiceError("SYMLINK_ESCAPE");
      const canonical = await realpath(scope.stagingDirectory);
      if (!isWithin(scope.stagingParent, canonical))
        throw new SkillImportServiceError("SYMLINK_ESCAPE");
    } catch (error) {
      if (error instanceof SkillImportServiceError) throw error;
      throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    }
  }

  async function recoverStaging(scope: ScopePaths): Promise<void> {
    const entries = await readdir(scope.stagingDirectory, { withFileTypes: true }).catch(() => []);
    const recoverable: Array<{ readonly path: string; readonly name: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const backup = /^backup-([a-z0-9-]+)-[0-9a-f-]{36}$/u.exec(entry.name);
      if (backup?.[1] !== undefined) {
        recoverable.push({ path: join(scope.stagingDirectory, entry.name), name: backup[1] });
      } else {
        await rm(join(scope.stagingDirectory, entry.name), { recursive: true, force: true });
      }
    }
    for (const item of recoverable) {
      const destination = join(scope.rootDirectory, item.name);
      const destinationExists = await lstat(destination).then(
        () => true,
        () => false,
      );
      if (destinationExists) {
        await rm(item.path, { recursive: true, force: true });
      } else {
        await rename(item.path, destination).catch(() => undefined);
      }
    }
  }
}

function validateImportFiles(
  incoming: readonly SkillImportFile[],
  policy: ReturnType<typeof resolveSkillFilesystemPolicy>,
): {
  readonly files: SkillPackageFile[];
  readonly manifest: SkillManifest;
  readonly bundleRevision: string;
} {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  if (incoming.length > policy.maxPackageFiles)
    throw new SkillImportServiceError("SKILL_PACKAGE_FILE_LIMIT");
  const seen = new Set<string>();
  const files: SkillPackageFile[] = [];
  let totalBytes = 0;
  for (const file of incoming) {
    if (typeof file.relativePath !== "string" || !(file.bytes instanceof Uint8Array)) {
      throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    }
    let relativePath: string;
    try {
      relativePath = normalizeSkillRelativePath(file.relativePath);
    } catch {
      throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    }
    const key = relativePath.toLowerCase();
    if (seen.has(key)) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    seen.add(key);
    const isManifest = relativePath === "SKILL.md";
    const maxFileBytes = isManifest ? policy.maxManifestBytes : policy.maxResourceBytes;
    if (file.bytes.byteLength > maxFileBytes) {
      throw new SkillImportServiceError(
        isManifest ? "SKILL_PACKAGE_TOO_LARGE" : "SKILL_RESOURCE_TOO_LARGE",
      );
    }
    if (file.bytes.byteLength > policy.maxPackageBytes - totalBytes) {
      throw new SkillImportServiceError("SKILL_PACKAGE_TOO_LARGE");
    }
    totalBytes += file.bytes.byteLength;
    files.push({ relativePath, bytes: Uint8Array.from(file.bytes) });
  }
  const manifestBytes = files.find((file) => file.relativePath === "SKILL.md")?.bytes;
  if (manifestBytes === undefined) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  let manifestResult: ReturnType<typeof parseSkillManifest>;
  try {
    manifestResult = parseSkillManifest(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
    );
  } catch {
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  if (!manifestResult.ok || !SkillNameSchema.safeParse(manifestResult.manifest.name).success) {
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  return {
    files,
    manifest: manifestResult.manifest,
    bundleRevision: createSkillPackageFingerprint(files),
  };
}

async function inspectDestination(
  destination: string,
  allowedRoot: string,
  policy: ReturnType<typeof resolveSkillFilesystemPolicy>,
): Promise<{ readonly bundleRevision: string } | undefined> {
  let info;
  try {
    info = await lstat(destination);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  const canonicalDestination = await realpath(destination);
  if (!isWithin(allowedRoot, canonicalDestination))
    throw new SkillImportServiceError("SYMLINK_ESCAPE");
  const files = await readPackageFromDisk(
    canonicalDestination,
    allowedRoot,
    policy,
    new AbortController().signal,
  );
  return { bundleRevision: files.bundleRevision };
}

async function readPackageFromDisk(
  packageDirectory: string,
  allowedRoot: string,
  policy: ReturnType<typeof resolveSkillFilesystemPolicy>,
  signal: AbortSignal,
): Promise<{ readonly files: SkillPackageFile[]; readonly bundleRevision: string }> {
  const canonicalPackage = await realpath(packageDirectory);
  if (!isWithin(allowedRoot, canonicalPackage)) throw new SkillImportServiceError("SYMLINK_ESCAPE");
  const files: SkillPackageFile[] = [];
  const visited = new Set<string>([canonicalPackage]);
  let totalBytes = 0;
  let entryCount = 0;
  const addFile = async (filePath: string, relativePath: string): Promise<void> => {
    checkCancelled(signal);
    const isManifest = relativePath === "SKILL.md";
    const limit = isManifest ? policy.maxManifestBytes : policy.maxResourceBytes;
    const remaining = policy.maxPackageBytes - totalBytes;
    if (remaining < 0) throw new SkillImportServiceError("SKILL_PACKAGE_TOO_LARGE");
    const tooLargeCode: SkillImportErrorCode =
      remaining < limit
        ? "SKILL_PACKAGE_TOO_LARGE"
        : isManifest
          ? "SKILL_PACKAGE_TOO_LARGE"
          : "SKILL_RESOURCE_TOO_LARGE";
    const bytes = await readPackageFile(
      filePath,
      canonicalPackage,
      Math.min(limit, remaining),
      signal,
      tooLargeCode,
    );
    if (!isManifest && bytes.byteLength > policy.maxResourceBytes) {
      throw new SkillImportServiceError("SKILL_RESOURCE_TOO_LARGE");
    }
    totalBytes += bytes.byteLength;
    files.push({ relativePath, bytes });
    if (files.length > policy.maxPackageFiles)
      throw new SkillImportServiceError("SKILL_PACKAGE_FILE_LIMIT");
    if (totalBytes > policy.maxPackageBytes)
      throw new SkillImportServiceError("SKILL_PACKAGE_TOO_LARGE");
  };
  await addFile(join(canonicalPackage, "SKILL.md"), "SKILL.md");
  const rootEntries = await readdir(canonicalPackage, { withFileTypes: true });
  rootEntries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of rootEntries) {
    checkCancelled(signal);
    if (["references", "scripts", "assets"].includes(entry.name) && entry.isSymbolicLink()) {
      throw new SkillImportServiceError("SYMLINK_ESCAPE");
    }
    entryCount += 1;
    if (entryCount > policy.maxEntriesPerRoot)
      throw new SkillImportServiceError("SKILL_PACKAGE_FILE_LIMIT");
    if (!["references", "scripts", "assets"].includes(entry.name)) continue;
    const resourceRoot = join(canonicalPackage, entry.name);
    const canonicalResourceRoot = await realpath(resourceRoot);
    if (!isWithin(canonicalPackage, canonicalResourceRoot))
      throw new SkillImportServiceError("SYMLINK_ESCAPE");
    if (!(await stat(canonicalResourceRoot)).isDirectory()) continue;
    if (visited.has(canonicalResourceRoot))
      throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    visited.add(canonicalResourceRoot);
    await walk(resourceRoot, entry.name, 0);
  }
  const manifestBytes = files.find((file) => file.relativePath === "SKILL.md")?.bytes;
  if (manifestBytes === undefined) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  let parsed;
  try {
    parsed = parseSkillManifest(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  if (!parsed.ok || !SkillNameSchema.safeParse(parsed.manifest.name).success) {
    throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
  }
  return { files, bundleRevision: createSkillPackageFingerprint(files) };

  async function walk(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > policy.maxDepth) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      checkCancelled(signal);
      if (entry.isSymbolicLink()) throw new SkillImportServiceError("SYMLINK_ESCAPE");
      entryCount += 1;
      if (entryCount > policy.maxEntriesPerRoot)
        throw new SkillImportServiceError("SKILL_PACKAGE_FILE_LIMIT");
      const childPath = join(directory, entry.name);
      const canonicalPath = await realpath(childPath);
      if (!isWithin(canonicalPackage, canonicalPath))
        throw new SkillImportServiceError("SYMLINK_ESCAPE");
      const info = await stat(canonicalPath);
      if (info.isDirectory()) {
        if (depth >= policy.maxDepth) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
        if (visited.has(canonicalPath)) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
        visited.add(canonicalPath);
        await walk(childPath, `${prefix}/${entry.name}`, depth + 1);
      } else if (info.isFile()) {
        await addFile(childPath, `${prefix}/${entry.name}`);
      }
    }
  }
}

async function readPackageFile(
  filePath: string,
  packageRoot: string,
  maxBytes: number,
  signal: AbortSignal,
  tooLargeCode: SkillImportErrorCode,
): Promise<Uint8Array> {
  checkCancelled(signal);
  const linkInfo = await lstat(filePath);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw new SkillImportServiceError("SYMLINK_ESCAPE");
  }
  const canonical = await realpath(filePath);
  if (!isWithin(packageRoot, canonical)) throw new SkillImportServiceError("SYMLINK_ESCAPE");
  const file = await open(canonical, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new SkillImportServiceError("SKILL_IMPORT_INVALID");
    if (before.size > BigInt(maxBytes)) throw new SkillImportServiceError(tooLargeCode);
    const chunks: Buffer[] = [];
    let copied = 0;
    const chunk = Buffer.alloc(Math.min(64 * KiB, maxBytes + 1));
    while (copied <= maxBytes) {
      checkCancelled(signal);
      const capacity = Math.min(chunk.byteLength, maxBytes + 1 - copied);
      const { bytesRead } = await file.read(chunk, 0, capacity, copied);
      if (bytesRead === 0) break;
      copied += bytesRead;
      if (copied > maxBytes) throw new SkillImportServiceError(tooLargeCode);
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(copied) !== after.size
    ) {
      throw new SkillImportServiceError("SKILL_IMPORT_STALE");
    }
    return Buffer.concat(chunks, copied);
  } finally {
    await file.close();
  }
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new SkillImportServiceError("SKILL_IMPORT_CANCELLED");
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const relativePath = relative(normalizedRoot, normalizedCandidate);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
