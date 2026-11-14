import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createSkillIdentity,
  parseSkillManifest,
  type SkillCandidate,
  type SkillDiagnostic,
  type SkillProviderPort,
  type SkillScopeRank,
} from "@caelush/skills";
import type { SkillDiscoveryResult } from "@caelush/skills";
import { DEFAULT_SKILL_FILESYSTEM_POLICY, resolveSkillFilesystemPolicy } from "./skill-policy.js";
import { createSkillPackageFingerprint } from "./skill-package.js";

const RESOURCE_DIRECTORIES = new Set(["references", "scripts", "assets"]);
const SAFE_MESSAGES = {
  ROOT_UNREADABLE: "A Skill source could not be scanned completely.",
  WORKSPACE_ROOT_UNAVAILABLE: "The workspace Skill source could not be resolved.",
  SYMLINK_ESCAPE: "A Skill source contains a link outside its allowed directory.",
  SYMLINK_LOOP: "A Skill source contains a link cycle and was skipped.",
  SCAN_DEPTH_LIMIT: "A Skill source exceeded the maximum scan depth.",
  SCAN_ENTRY_LIMIT: "A Skill source exceeded the maximum entry count.",
  SCAN_BYTE_LIMIT: "A Skill source exceeded the maximum scan byte count.",
  SCAN_CANCELLED: "Skill discovery was cancelled before all sources were scanned.",
  SKILL_PACKAGE_TOO_LARGE: "A Skill package exceeds its size limit and was skipped.",
  SKILL_RESOURCE_TOO_LARGE: "A Skill resource exceeds its size limit and was skipped.",
  SKILL_PACKAGE_FILE_LIMIT: "A Skill package exceeds its file count limit and was skipped.",
  SKILL_RESOURCE_DEPTH_LIMIT:
    "A Skill package resource exceeded the maximum depth and was skipped.",
  SKILL_SOURCE_CHANGED: "A Skill source changed while it was being scanned and was skipped.",
  SKILL_MANIFEST_INVALID_UTF8: "A Skill manifest is not valid UTF-8 and was skipped.",
  SKILL_MANIFEST_UNREADABLE: "A Skill manifest could not be read and was skipped.",
  SKILL_RESOURCE_UNREADABLE: "A Skill resource could not be read and was skipped.",
  SKILL_DIAGNOSTICS_TRUNCATED: "Additional Skill diagnostics were omitted.",
} as const;

type SafeDiagnosticCode = keyof typeof SAFE_MESSAGES;
type RootKind = "USER" | "PROJECT" | "BUILTIN";

export interface FilesystemSkillProviderOptions {
  readonly userRoot: string;
  readonly builtinRoots?: readonly string[];
  readonly resolveWorkspaceRoot: (workspaceId: string) => Promise<string>;
  readonly policy?: Partial<typeof DEFAULT_SKILL_FILESYSTEM_POLICY>;
}

export interface ResolvedSkillSourceLocator {
  readonly kind: RootKind;
  readonly workspaceId?: string;
  readonly rootDirectory: string;
  readonly packageDirectory: string;
}

export interface FilesystemSkillProvider extends SkillProviderPort {
  getWatchRoots(workspaceId: string): Promise<readonly string[]>;
  resolveLocator(locator: string, workspaceId?: string): Promise<ResolvedSkillSourceLocator | null>;
}

interface SkillRoot {
  readonly kind: RootKind;
  readonly path: string;
  readonly providerId: string;
  readonly scopeRank: SkillScopeRank;
  readonly workspaceId?: string;
  readonly workspaceRoot?: string;
}

interface ScanState {
  readonly signal: AbortSignal;
  readonly candidates: SkillCandidate[];
  readonly diagnostics: SkillDiagnostic[];
  readonly policy: ReturnType<typeof resolveSkillFilesystemPolicy>;
  complete: boolean;
  entries: number;
  bytes: number;
  stopped: boolean;
  diagnosticTruncated: boolean;
}

interface PackageBudget {
  bytes: number;
}

interface StableFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

class SkillScanCancelledError extends Error {}

export function createFilesystemSkillProvider(
  options: FilesystemSkillProviderOptions,
): FilesystemSkillProvider {
  const policy = resolveSkillFilesystemPolicy(options.policy);

  return {
    async discover({ workspaceId, signal }): Promise<SkillDiscoveryResult> {
      const state: ScanState = {
        signal,
        candidates: [],
        diagnostics: [],
        policy,
        complete: true,
        entries: 0,
        bytes: 0,
        stopped: false,
        diagnosticTruncated: false,
      };

      const roots: SkillRoot[] = [
        { kind: "USER", path: options.userRoot, providerId: "user", scopeRank: 1 },
      ];
      try {
        const workspaceRoot = await options.resolveWorkspaceRoot(workspaceId);
        roots.push({
          kind: "PROJECT",
          path: join(workspaceRoot, ".agents", "skills"),
          providerId: `project:${workspaceId}`,
          scopeRank: 0,
          workspaceId,
          workspaceRoot,
        });
      } catch {
        addDiagnostic(state, "WORKSPACE_ROOT_UNAVAILABLE");
        state.complete = false;
      }
      for (const builtinRoot of options.builtinRoots ?? []) {
        roots.push({
          kind: "BUILTIN",
          path: builtinRoot,
          providerId: await builtinProviderId(builtinRoot),
          scopeRank: 2,
        });
      }

      for (const root of roots) {
        try {
          await scanRoot(root, state);
        } catch (error) {
          if (error instanceof SkillScanCancelledError) {
            addDiagnostic(state, "SCAN_CANCELLED");
            state.complete = false;
            state.stopped = true;
            break;
          }
          addDiagnostic(state, "ROOT_UNREADABLE");
          state.complete = false;
        }
      }

      state.candidates.sort(
        (left, right) =>
          compareCodePoints(left.manifest.name, right.manifest.name) ||
          compareCodePoints(left.skillId, right.skillId),
      );
      state.diagnostics.sort(
        (left, right) =>
          compareCodePoints(left.code, right.code) ||
          compareCodePoints(left.safeMessage, right.safeMessage),
      );
      return Object.freeze({
        candidates: Object.freeze(state.candidates),
        diagnostics: Object.freeze(state.diagnostics),
        complete: state.complete,
      });
    },

    async getWatchRoots(workspaceId) {
      const roots = [options.userRoot];
      try {
        roots.push(join(await options.resolveWorkspaceRoot(workspaceId), ".agents", "skills"));
      } catch {
        // Discovery reports this condition with a bounded diagnostic.
      }
      roots.push(...(options.builtinRoots ?? []));
      return Object.freeze([...new Set(roots.map((root) => resolve(root)))]);
    },

    async resolveLocator(locator, workspaceId) {
      const parsed = parseLocator(locator);
      if (parsed === undefined) return null;
      let rootDirectory: string;
      let workspacePath: string | undefined;
      switch (parsed.kind) {
        case "USER":
          if (parsed.providerId !== "user" || parsed.workspaceId !== undefined) return null;
          rootDirectory = options.userRoot;
          break;
        case "PROJECT":
          if (
            workspaceId === undefined ||
            workspaceId !== parsed.workspaceId ||
            parsed.providerId !== `project:${workspaceId}`
          )
            return null;
          workspacePath = await options.resolveWorkspaceRoot(workspaceId);
          rootDirectory = join(workspacePath, ".agents", "skills");
          break;
        case "BUILTIN": {
          const match = await findBuiltinRoot(options.builtinRoots ?? [], parsed.providerId);
          if (match === undefined) return null;
          rootDirectory = match;
          break;
        }
      }

      try {
        const canonicalRoot = await realpath(rootDirectory);
        if (workspacePath !== undefined) {
          const canonicalWorkspace = await realpath(workspacePath);
          if (!isWithin(canonicalWorkspace, canonicalRoot)) return null;
        }
        const packageDirectory = resolve(canonicalRoot, ...parsed.relativePath.split("/"));
        if (!isWithin(canonicalRoot, packageDirectory)) return null;
        const canonicalPackage = await realpath(packageDirectory);
        if (!isWithin(canonicalRoot, canonicalPackage)) return null;
        return Object.freeze({
          kind: parsed.kind,
          ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
          rootDirectory: canonicalRoot,
          packageDirectory: canonicalPackage,
        });
      } catch {
        return null;
      }
    },
  };
}

async function scanRoot(root: SkillRoot, state: ScanState): Promise<void> {
  checkCancelled(state);
  state.entries = 0;
  state.bytes = 0;
  state.stopped = false;
  let rootStat;
  try {
    rootStat = await stat(root.path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      if (root.kind === "USER") {
        addDiagnostic(state, "ROOT_UNREADABLE");
        state.complete = false;
      }
      return;
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    addDiagnostic(state, "ROOT_UNREADABLE");
    state.complete = false;
    return;
  }

  const canonicalRoot = await realpath(root.path);
  if (root.workspaceRoot !== undefined) {
    const canonicalWorkspace = await realpath(root.workspaceRoot);
    if (!isWithin(canonicalWorkspace, canonicalRoot)) {
      addDiagnostic(state, "SYMLINK_ESCAPE");
      state.complete = false;
      return;
    }
  }
  const visited = new Set<string>();

  const walk = async (directory: string, depth: number): Promise<void> => {
    checkCancelled(state);
    if (state.stopped) return;
    const canonicalDirectory = await realpath(directory);
    if (!isWithin(canonicalRoot, canonicalDirectory)) {
      addDiagnostic(state, "SYMLINK_ESCAPE");
      state.complete = false;
      return;
    }
    if (visited.has(canonicalDirectory)) {
      addDiagnostic(state, "SYMLINK_LOOP");
      state.complete = false;
      return;
    }
    visited.add(canonicalDirectory);

    let entries;
    try {
      entries = await readdir(canonicalDirectory, { withFileTypes: true });
    } catch {
      addDiagnostic(state, "ROOT_UNREADABLE");
      state.complete = false;
      return;
    }
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    const hasManifest = entries.some((entry) => entry.name === "SKILL.md");
    const resourceDirectories = new Set(
      hasManifest
        ? entries.filter((entry) => RESOURCE_DIRECTORIES.has(entry.name)).map((entry) => entry.name)
        : [],
    );

    for (const entry of entries) {
      checkCancelled(state);
      if (state.stopped) return;
      if (!consumeEntry(state)) return;
      const childPath = join(canonicalDirectory, entry.name);
      let childStat;
      let canonicalChild: string;
      try {
        canonicalChild = await realpath(childPath);
        if (!isWithin(canonicalRoot, canonicalChild)) {
          addDiagnostic(state, "SYMLINK_ESCAPE");
          state.complete = false;
          continue;
        }
        childStat = await stat(canonicalChild);
      } catch (error) {
        if (hasCode(error, "ELOOP")) {
          addDiagnostic(state, "SYMLINK_LOOP");
          state.complete = false;
          continue;
        }
        addDiagnostic(state, "ROOT_UNREADABLE");
        state.complete = false;
        continue;
      }

      if (childStat.isDirectory()) {
        if (hasManifest || resourceDirectories.has(entry.name)) continue;
        if (depth >= state.policy.maxDepth) {
          addDiagnostic(state, "SCAN_DEPTH_LIMIT");
          state.complete = false;
          continue;
        }
        await walk(childPath, depth + 1);
        continue;
      }
      if (entry.name === "SKILL.md" && childStat.isFile()) {
        await scanSkillPackage(root, canonicalRoot, canonicalDirectory, childPath, state);
      }
    }
  };

  await walk(canonicalRoot, 0);
}

async function scanSkillPackage(
  root: SkillRoot,
  canonicalRoot: string,
  packageDirectory: string,
  manifestPath: string,
  state: ScanState,
): Promise<void> {
  try {
    const manifestPackageLimit = Math.min(
      state.policy.maxManifestBytes,
      state.policy.maxPackageBytes,
    );
    const rootRemainingBytes = state.policy.maxBytesPerRoot - state.bytes;
    if (rootRemainingBytes <= 0) throw new SkillPackageFileError("SCAN_BYTE_LIMIT");
    const manifestFile = await readStableFile(
      manifestPath,
      packageDirectory,
      state,
      Math.min(manifestPackageLimit, rootRemainingBytes),
      rootRemainingBytes < manifestPackageLimit ? "SCAN_BYTE_LIMIT" : "SKILL_PACKAGE_TOO_LARGE",
    );
    const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes);
    const parsed = parseSkillManifest(sourceText);
    if (!parsed.ok) {
      for (const diagnostic of parsed.diagnostics) {
        addDiagnostic(state, diagnostic.code, diagnostic.safeMessage, diagnostic.severity);
      }
      return;
    }

    const packageFiles: StableFile[] = [{ relativePath: "SKILL.md", bytes: manifestFile.bytes }];
    const packageBudget: PackageBudget = { bytes: manifestFile.bytes.byteLength };
    const packageVisited = new Set<string>([await realpath(packageDirectory)]);
    const entries = await readdir(packageDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareCodePoints(left.name, right.name))) {
      if (!RESOURCE_DIRECTORIES.has(entry.name)) continue;
      const resourceRoot = join(packageDirectory, entry.name);
      let info;
      let canonicalResourceRoot: string;
      try {
        canonicalResourceRoot = await realpath(resourceRoot);
        if (!isWithin(packageDirectory, canonicalResourceRoot)) {
          throw new SkillPackageFileError("SYMLINK_ESCAPE");
        }
        info = await stat(canonicalResourceRoot);
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        if (error instanceof SkillPackageFileError) throw error;
        throw new SkillPackageFileError("SKILL_RESOURCE_UNREADABLE");
      }
      if (!info.isDirectory()) continue;
      if (packageVisited.has(canonicalResourceRoot)) {
        throw new SkillPackageFileError("SYMLINK_LOOP");
      }
      packageVisited.add(canonicalResourceRoot);
      await scanResourceDirectory(
        resourceRoot,
        entry.name,
        packageDirectory,
        packageVisited,
        packageFiles,
        packageBudget,
        state,
      );
      if (state.stopped) return;
    }

    if (packageFiles.length > state.policy.maxPackageFiles) {
      addDiagnostic(state, "SKILL_PACKAGE_FILE_LIMIT");
      return;
    }
    const relativePath = toPortableRelative(relative(canonicalRoot, packageDirectory));
    const privateLocator = JSON.stringify({
      kind: root.kind,
      ...(root.workspaceId === undefined ? {} : { workspaceId: root.workspaceId }),
      providerId: root.providerId,
      relativePath,
    });
    const candidate: SkillCandidate = Object.freeze({
      skillId: createSkillIdentity({
        scopeRank: root.scopeRank,
        providerId: root.providerId,
        privateLocator,
      }),
      manifest: Object.freeze({ ...parsed.manifest, body: "" }),
      scopeRank: root.scopeRank,
      providerId: root.providerId,
      privateLocator,
      bundleRevision: createSkillPackageFingerprint(packageFiles),
    });
    state.candidates.push(candidate);
  } catch (error) {
    if (error instanceof SkillScanCancelledError) throw error;
    if (error instanceof TypeError && error.message.includes("encoded data")) {
      addDiagnostic(state, "SKILL_MANIFEST_INVALID_UTF8");
      return;
    }
    if (error instanceof SkillPackageFileError) {
      addDiagnostic(state, error.code);
      if (
        error.code === "SYMLINK_ESCAPE" ||
        error.code === "SYMLINK_LOOP" ||
        error.code === "SKILL_SOURCE_CHANGED" ||
        error.code === "SCAN_BYTE_LIMIT" ||
        error.code === "SKILL_RESOURCE_DEPTH_LIMIT" ||
        error.code === "SKILL_RESOURCE_UNREADABLE"
      ) {
        state.complete = false;
      }
      if (error.code === "SCAN_BYTE_LIMIT") state.stopped = true;
      return;
    }
    addDiagnostic(state, "SKILL_MANIFEST_UNREADABLE");
  }
}

async function scanResourceDirectory(
  directory: string,
  resourcePrefix: string,
  packageDirectory: string,
  visited: Set<string>,
  files: StableFile[],
  packageBudget: PackageBudget,
  state: ScanState,
  depth = 0,
): Promise<void> {
  checkCancelled(state);
  if (state.stopped) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new SkillPackageFileError("SKILL_RESOURCE_UNREADABLE");
  }
  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  for (const entry of entries) {
    checkCancelled(state);
    if (state.stopped) return;
    if (!consumeEntry(state)) return;
    const childPath = join(directory, entry.name);
    let targetPath: string;
    let childInfo;
    try {
      targetPath = await realpath(childPath);
      if (!isWithin(packageDirectory, targetPath)) {
        throw new SkillPackageFileError("SYMLINK_ESCAPE");
      }
      childInfo = await stat(targetPath);
    } catch (error) {
      if (hasCode(error, "ELOOP")) throw new SkillPackageFileError("SYMLINK_LOOP");
      if (error instanceof SkillPackageFileError) throw error;
      throw new SkillPackageFileError("SKILL_RESOURCE_UNREADABLE");
    }

    if (childInfo.isDirectory()) {
      if (depth >= state.policy.maxDepth) {
        throw new SkillPackageFileError("SKILL_RESOURCE_DEPTH_LIMIT");
      }
      if (visited.has(targetPath)) {
        throw new SkillPackageFileError("SYMLINK_LOOP");
      }
      visited.add(targetPath);
      await scanResourceDirectory(
        childPath,
        `${resourcePrefix}/${entry.name}`,
        packageDirectory,
        visited,
        files,
        packageBudget,
        state,
        depth + 1,
      );
      continue;
    }
    if (!childInfo.isFile()) continue;
    if (files.length >= state.policy.maxPackageFiles) {
      throw new SkillPackageFileError("SKILL_PACKAGE_FILE_LIMIT");
    }
    if (Number(childInfo.size) > state.policy.maxResourceBytes) {
      throw new SkillPackageFileError("SKILL_RESOURCE_TOO_LARGE");
    }
    const remainingPackageBytes = state.policy.maxPackageBytes - packageBudget.bytes;
    if (Number(childInfo.size) > remainingPackageBytes) {
      throw new SkillPackageFileError("SKILL_PACKAGE_TOO_LARGE");
    }
    const rootRemainingBytes = state.policy.maxBytesPerRoot - state.bytes;
    if (Number(childInfo.size) > rootRemainingBytes) {
      throw new SkillPackageFileError("SCAN_BYTE_LIMIT");
    }
    const relativePath = `${resourcePrefix}/${entry.name}`;
    assertPortableRelativePath(relativePath);
    const file = await readStableFile(
      childPath,
      packageDirectory,
      state,
      Math.min(state.policy.maxResourceBytes, remainingPackageBytes, rootRemainingBytes),
      rootRemainingBytes < Math.min(state.policy.maxResourceBytes, remainingPackageBytes)
        ? "SCAN_BYTE_LIMIT"
        : remainingPackageBytes <= state.policy.maxResourceBytes
          ? "SKILL_PACKAGE_TOO_LARGE"
          : "SKILL_RESOURCE_TOO_LARGE",
    );
    packageBudget.bytes += file.bytes.byteLength;
    files.push({ relativePath, bytes: file.bytes });
  }
}

async function readStableFile(
  filePath: string,
  allowedRoot: string,
  state: ScanState,
  maxBytes: number,
  tooLargeCode: "SCAN_BYTE_LIMIT" | "SKILL_PACKAGE_TOO_LARGE" | "SKILL_RESOURCE_TOO_LARGE",
): Promise<StableFile> {
  const resolvedBefore = await realpath(filePath);
  if (!isWithin(allowedRoot, resolvedBefore)) throw new SkillPackageFileError("SYMLINK_ESCAPE");
  checkCancelled(state);
  const file = await open(resolvedBefore, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new SkillPackageFileError("SKILL_MANIFEST_UNREADABLE");
    if (before.size > BigInt(maxBytes)) throw new SkillPackageFileError(tooLargeCode);
    const chunks: Buffer[] = [];
    let copiedBytes = 0;
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    while (copiedBytes <= maxBytes) {
      checkCancelled(state);
      const capacity = Math.min(chunk.byteLength, maxBytes + 1 - copiedBytes);
      const { bytesRead } = await file.read(chunk, 0, capacity, copiedBytes);
      if (bytesRead === 0) break;
      copiedBytes += bytesRead;
      if (copiedBytes > maxBytes) throw new SkillPackageFileError(tooLargeCode);
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    checkCancelled(state);
    const after = await file.stat({ bigint: true });
    const resolvedAfter = await realpath(filePath);
    if (
      resolvedBefore !== resolvedAfter ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(copiedBytes) !== after.size
    ) {
      throw new SkillPackageFileError("SKILL_SOURCE_CHANGED");
    }
    state.bytes += copiedBytes;
    return { relativePath: basename(filePath), bytes: Buffer.concat(chunks, copiedBytes) };
  } finally {
    await file.close();
  }
}

function consumeEntry(state: ScanState): boolean {
  if (state.entries >= state.policy.maxEntriesPerRoot) {
    addDiagnostic(state, "SCAN_ENTRY_LIMIT");
    state.complete = false;
    state.stopped = true;
    return false;
  }
  state.entries += 1;
  return true;
}

function checkCancelled(state: ScanState): void {
  if (state.signal.aborted) throw new SkillScanCancelledError();
}

function addDiagnostic(
  state: ScanState,
  code: SafeDiagnosticCode | string,
  safeMessage?: string,
  severity: SkillDiagnostic["severity"] = "WARNING",
): void {
  if (state.diagnostics.length >= state.policy.maxDiagnostics) {
    if (!state.diagnosticTruncated) {
      state.diagnosticTruncated = true;
      const last = state.diagnostics[state.diagnostics.length - 1];
      if (last !== undefined) {
        state.diagnostics[state.diagnostics.length - 1] = {
          code: "SKILL_DIAGNOSTICS_TRUNCATED",
          severity: "WARNING",
          safeMessage: SAFE_MESSAGES.SKILL_DIAGNOSTICS_TRUNCATED,
        };
      }
    }
    return;
  }
  state.diagnostics.push({
    code,
    severity,
    safeMessage:
      safeMessage ??
      SAFE_MESSAGES[code as SafeDiagnosticCode] ??
      "A Skill source has a diagnostic.",
  });
}

async function builtinProviderId(root: string): Promise<string> {
  let canonical = resolve(root);
  try {
    canonical = await realpath(root);
  } catch {
    // Missing builtin roots remain configured sources and will become visible if supplied later.
  }
  return `builtin:${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 24)}`;
}

async function findBuiltinRoot(
  roots: readonly string[],
  providerId: string,
): Promise<string | undefined> {
  for (const root of roots) {
    if ((await builtinProviderId(root)) === providerId) return root;
  }
  return undefined;
}

function parseLocator(locator: string):
  | {
      readonly kind: RootKind;
      readonly providerId: string;
      readonly relativePath: string;
      readonly workspaceId?: string;
    }
  | undefined {
  try {
    const value: unknown = JSON.parse(locator);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      (record["kind"] !== "USER" && record["kind"] !== "PROJECT" && record["kind"] !== "BUILTIN") ||
      typeof record["providerId"] !== "string" ||
      typeof record["relativePath"] !== "string" ||
      (record["workspaceId"] !== undefined && typeof record["workspaceId"] !== "string")
    ) {
      return undefined;
    }
    if (record["relativePath"] !== ".") assertPortableRelativePath(record["relativePath"]);
    return {
      kind: record["kind"],
      providerId: record["providerId"],
      relativePath: record["relativePath"],
      ...(typeof record["workspaceId"] === "string" ? { workspaceId: record["workspaceId"] } : {}),
    };
  } catch {
    return undefined;
  }
}

function assertPortableRelativePath(value: string): void {
  if (
    value === "" ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    value.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new SkillPackageFileError("SYMLINK_ESCAPE");
  }
}

function toPortableRelative(value: string): string {
  return value === "" || value === "." ? "." : value.split(sep).join("/");
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

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

class SkillPackageFileError extends Error {
  constructor(readonly code: SafeDiagnosticCode) {
    super(SAFE_MESSAGES[code]);
  }
}
