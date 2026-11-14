import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { SkillBundleRefV1Schema, SkillNameSchema, type SkillBundleRefV1 } from "@caelush/protocol";
import {
  parseSkillManifest,
  type BoundedSkillResource,
  type SkillBundlePort,
  type SkillCandidate,
} from "@caelush/skills";
import { DEFAULT_SKILL_FILESYSTEM_POLICY, resolveSkillFilesystemPolicy } from "./skill-policy.js";
import {
  createSkillFileFingerprint,
  createSkillPackageFingerprint,
  normalizeSkillRelativePath,
  sha256Hex,
  type SkillPackageFile,
} from "./skill-package.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const BUNDLE_MANIFEST_MAX_BYTES = 8 * MiB;
const bundleNamePattern = /^[a-f0-9]{64}$/u;
const SAFE_MESSAGES = {
  SKILL_NOT_FOUND: "The Skill was not found in the effective catalog.",
  SKILL_SELECTION_STALE: "The selected Skill revision has changed.",
  SKILL_SOURCE_CHANGED: "A Skill source changed while it was being captured.",
  SYMLINK_ESCAPE: "A Skill source contains a link outside its allowed directory.",
  SKILL_BUNDLE_INVALID: "The Skill bundle is invalid and was not published.",
  SKILL_ARTIFACT_INVALID: "The stored Skill bundle failed its integrity check.",
  SKILL_RESOURCE_DENIED: "The Skill resource is not part of this bundle.",
  SKILLS_QUOTA_EXCEEDED: "The Skill bundle store does not have enough available space.",
  SKILL_BUNDLE_BUSY: "The Skill bundle store has too many active preparations.",
  SKILL_CAPTURE_CANCELLED: "Skill capture was cancelled before publication.",
  SKILL_SOURCE_UNAVAILABLE: "The Skill source could not be read safely.",
  SKILL_PACKAGE_TOO_LARGE: "The Skill package exceeds its size limit.",
  SKILL_RESOURCE_TOO_LARGE: "A Skill resource exceeds its size limit.",
  SKILL_PACKAGE_FILE_LIMIT: "The Skill package exceeds its file count limit.",
  SKILL_PACKAGE_DEPTH_LIMIT: "The Skill package exceeds its directory depth limit.",
  SKILL_PACKAGE_ENTRY_LIMIT: "The Skill package exceeds its entry limit.",
} as const;

export type SkillBundleStoreErrorCode = keyof typeof SAFE_MESSAGES;

export class SkillBundleStoreError extends Error {
  constructor(readonly code: SkillBundleStoreErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "SkillBundleStoreError";
  }
}

export interface SkillBundleSource {
  readonly candidate: SkillCandidate;
  /** Opaque logical scope such as USER or PROJECT:<workspaceId>; raw paths are not persisted. */
  readonly scopeId: string;
  readonly rootDirectory: string;
  readonly packageDirectory: string;
}

export interface SkillBundleReferenceAuthority {
  isReferenced(reference: SkillBundleRefV1): boolean | Promise<boolean>;
}

export interface SkillBundleGarbageCollectionResult {
  readonly removedBundles: number;
  readonly removedStaging: number;
  readonly removedBytes: number;
}

export interface FilesystemSkillBundleStore extends SkillBundlePort {
  collectGarbage(): Promise<SkillBundleGarbageCollectionResult>;
  releasePreparingReference(artifactRef: string): void;
}

export interface FilesystemSkillBundleStoreOptions {
  readonly rootDirectory: string;
  readonly resolveSource: (skillId: string) => Promise<SkillBundleSource | null>;
  readonly references?: SkillBundleReferenceAuthority;
  readonly quotaBytes?: number;
  readonly policy?: Partial<typeof DEFAULT_SKILL_FILESYSTEM_POLICY>;
  readonly now?: () => number;
  readonly preparingReferenceTtlMs?: number;
  readonly maxPreparingReferences?: number;
  /** Test seam for changing a source between the final copy read and its stability check. */
  readonly beforeSourceStabilityCheck?: (relativePath: string) => void | Promise<void>;
}

interface BundleManifestFile {
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
}

interface BundleManifest {
  readonly schemaVersion: 1;
  readonly bundleRevision: string;
  readonly manifestFingerprint: string;
  readonly totalBytes: number;
  readonly files: readonly BundleManifestFile[];
}

interface BundleReferenceMetadata {
  readonly schemaVersion: 1;
  readonly artifactRef: string;
  readonly bundleRevision: string;
  readonly manifestFingerprint: string;
  readonly scopeHash: string;
}

interface VerifiedBundle {
  readonly manifest: BundleManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

const bundleManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    bundleRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    manifestFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    totalBytes: z.number().int().nonnegative().safe(),
    files: z
      .array(
        z
          .object({
            relativePath: z.string().min(1).max(1024),
            size: z.number().int().nonnegative().safe(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .min(1)
      .max(4096),
  })
  .strict();

const referenceMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactRef: z.string().regex(/^skill:[A-Za-z0-9_-]{43}$/u),
    bundleRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    manifestFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export function createFilesystemSkillBundleStore(
  options: FilesystemSkillBundleStoreOptions,
): FilesystemSkillBundleStore {
  const policy = resolveSkillFilesystemPolicy(options.policy);
  const rootDirectory = resolve(options.rootDirectory);
  const bundleDirectory = join(rootDirectory, "bundles");
  const stagingDirectory = join(rootDirectory, "staging");
  const referencesDirectory = join(rootDirectory, "references");
  const scopeIndexDirectory = join(rootDirectory, "scope-index");
  const quotaBytes = options.quotaBytes ?? policy.bundleQuotaBytes;
  const leaseTtlMs = options.preparingReferenceTtlMs ?? 5 * 60 * 1000;
  const maxPreparingReferences = options.maxPreparingReferences ?? 4096;
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) {
    throw new RangeError("Skill bundle quota must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1 || leaseTtlMs > 60 * 60 * 1000) {
    throw new RangeError("Skill preparation reference lifetime is invalid.");
  }
  if (
    !Number.isSafeInteger(maxPreparingReferences) ||
    maxPreparingReferences < 1 ||
    maxPreparingReferences > 65_536
  ) {
    throw new RangeError("Skill preparation reference limit is invalid.");
  }
  const now = options.now ?? Date.now;
  const preparingReferences = new Map<string, number>();
  let writeQueue: Promise<void> = Promise.resolve();

  const store: FilesystemSkillBundleStore = {
    async capture({ skillId, expectedRevision, signal }) {
      return withWriteLock(async () => {
        checkCancelled(signal);
        let source: SkillBundleSource | null;
        try {
          source = await options.resolveSource(skillId);
        } catch {
          throw new SkillBundleStoreError("SKILL_SOURCE_UNAVAILABLE");
        }
        if (source === null || source.candidate.skillId !== skillId) {
          throw new SkillBundleStoreError("SKILL_NOT_FOUND");
        }
        if (
          expectedRevision !== undefined &&
          source.candidate.bundleRevision !== undefined &&
          expectedRevision !== source.candidate.bundleRevision
        ) {
          throw new SkillBundleStoreError("SKILL_SELECTION_STALE");
        }
        let files: SkillPackageFile[];
        try {
          files = await captureSourceFiles(
            source,
            signal,
            policy,
            options.beforeSourceStabilityCheck,
          );
        } catch (error) {
          if (error instanceof SkillBundleStoreError) throw error;
          if (signal.aborted || isAbortError(error)) {
            throw new SkillBundleStoreError("SKILL_CAPTURE_CANCELLED");
          }
          if (error instanceof TypeError) throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
          if (isCode(error, "ELOOP")) throw new SkillBundleStoreError("SYMLINK_ESCAPE");
          if (isCode(error, "ENOENT")) throw new SkillBundleStoreError("SKILL_SELECTION_STALE");
          throw new SkillBundleStoreError("SKILL_SOURCE_UNAVAILABLE");
        }
        const bundleRevision = createSkillPackageFingerprint(files);
        if (
          (source.candidate.bundleRevision !== undefined &&
            source.candidate.bundleRevision !== bundleRevision) ||
          (expectedRevision !== undefined && expectedRevision !== bundleRevision)
        ) {
          throw new SkillBundleStoreError("SKILL_SOURCE_CHANGED");
        }
        const rawManifest = files.find((file) => file.relativePath === "SKILL.md");
        if (rawManifest === undefined) throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
        const parsedManifest = parseSkillManifest(
          new TextDecoder("utf-8", { fatal: true }).decode(rawManifest.bytes),
        );
        if (
          !parsedManifest.ok ||
          parsedManifest.manifest.name !== source.candidate.manifest.name ||
          !SkillNameSchema.safeParse(parsedManifest.manifest.name).success
        ) {
          throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
        }
        const manifestFingerprint = createSkillFileFingerprint(rawManifest.bytes);
        const bundleManifest = makeBundleManifest(bundleRevision, manifestFingerprint, files);
        await ensureDirectories();
        const blobName = bundleRevision.slice("sha256:".length);
        const blobPath = join(bundleDirectory, blobName);
        const existing = await tryVerifyBundle(blobPath, bundleRevision);
        if (existing === undefined) {
          await collectGarbageUnsafe();
          const usedBytes = await storedBytesUnsafe();
          if (usedBytes > quotaBytes - bundleManifest.totalBytes) {
            throw new SkillBundleStoreError("SKILLS_QUOTA_EXCEEDED");
          }
          await publishBundle(blobPath, bundleManifest, files, signal);
        }
        const reference = await getOrCreateScopedReference(source.scopeId, bundleManifest);
        checkCancelled(signal);
        lease(reference.artifactRef);
        return SkillBundleRefV1Schema.parse(reference);
      });
    },

    async read({ bundle, relativePath, signal }): Promise<BoundedSkillResource> {
      return withWriteLock(async () => {
        checkCancelled(signal);
        const parsedRef = SkillBundleRefV1Schema.safeParse(bundle);
        if (!parsedRef.success || !/^sha256:[a-f0-9]{64}$/u.test(bundle.bundleRevision)) {
          throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
        }
        let normalizedPath: string;
        try {
          normalizedPath = normalizeSkillRelativePath(relativePath);
        } catch {
          throw new SkillBundleStoreError("SKILL_RESOURCE_DENIED");
        }
        const reference = await readReferenceMetadata(bundle.artifactRef);
        if (
          reference === undefined ||
          reference.bundleRevision !== bundle.bundleRevision ||
          reference.manifestFingerprint !== bundle.manifestFingerprint
        ) {
          throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
        }
        const verified = await verifyBundleSafely(
          join(bundleDirectory, bundle.bundleRevision.slice("sha256:".length)),
          bundle.bundleRevision,
        );
        if (verified.manifest.manifestFingerprint !== bundle.manifestFingerprint) {
          throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
        }
        checkCancelled(signal);
        const content = verified.files.get(normalizedPath);
        if (content === undefined) throw new SkillBundleStoreError("SKILL_RESOURCE_DENIED");
        return toBoundedSkillResource(normalizedPath, content);
      });
    },

    async collectGarbage() {
      return withWriteLock(collectGarbageUnsafe);
    },

    releasePreparingReference(artifactRef) {
      preparingReferences.delete(artifactRef);
    },
  };

  function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function ensureDirectories(): Promise<void> {
    try {
      await mkdir(rootDirectory, { recursive: true });
      const canonicalRoot = await realpath(rootDirectory);
      for (const directory of [
        bundleDirectory,
        stagingDirectory,
        referencesDirectory,
        scopeIndexDirectory,
      ]) {
        await mkdir(directory, { recursive: true });
        const info = await lstat(directory);
        const canonical = await realpath(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || !isWithin(canonicalRoot, canonical)) {
          throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
        }
      }
    } catch (error) {
      if (error instanceof SkillBundleStoreError) throw error;
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
  }

  async function publishBundle(
    blobPath: string,
    manifest: BundleManifest,
    files: readonly SkillPackageFile[],
    signal: AbortSignal,
  ): Promise<void> {
    const stagingPath = join(stagingDirectory, randomUUID());
    try {
      await mkdir(stagingPath, { recursive: false });
      for (const file of files) {
        checkCancelled(signal);
        const safePath = normalizeSkillRelativePath(file.relativePath);
        const destination = join(stagingPath, ...safePath.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
      }
      checkCancelled(signal);
      await writeFile(join(stagingPath, "bundle.json"), JSON.stringify(manifest), {
        flag: "wx",
        mode: 0o600,
      });
      const verified = await verifyBundle(stagingPath, manifest.bundleRevision);
      if (verified.manifest.manifestFingerprint !== manifest.manifestFingerprint) {
        throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
      }
      checkCancelled(signal);
      await rename(stagingPath, blobPath);
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof SkillBundleStoreError) throw error;
      if (isAbortError(error) || signal.aborted) {
        throw new SkillBundleStoreError("SKILL_CAPTURE_CANCELLED");
      }
      if (isCode(error, "EEXIST") || isCode(error, "ENOTEMPTY")) {
        const existing = await tryVerifyBundle(blobPath, manifest.bundleRevision);
        if (existing !== undefined) return;
      }
      throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
    }
  }

  async function getOrCreateScopedReference(
    scopeId: string,
    manifest: BundleManifest,
  ): Promise<SkillBundleRefV1> {
    if (scopeId.length < 1 || scopeId.length > 256)
      throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
    const scopeHash = createHash("sha256").update(scopeId, "utf8").digest("hex");
    const bundleHash = manifest.bundleRevision.slice("sha256:".length);
    const indexPath = join(scopeIndexDirectory, scopeHash, `${bundleHash}.json`);
    await mkdir(join(scopeIndexDirectory, scopeHash), { recursive: true });
    const scopeIndexInfo = await lstat(join(scopeIndexDirectory, scopeHash));
    const canonicalScopeIndexDirectory = await realpath(join(scopeIndexDirectory, scopeHash));
    if (
      !scopeIndexInfo.isDirectory() ||
      scopeIndexInfo.isSymbolicLink() ||
      !isWithin(scopeIndexDirectory, canonicalScopeIndexDirectory)
    ) {
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    try {
      const indexInfo = await lstat(indexPath);
      if (!indexInfo.isFile() || indexInfo.isSymbolicLink()) {
        throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      }
      const index = JSON.parse(await readFile(indexPath, "utf8")) as { artifactRef?: unknown };
      if (typeof index.artifactRef === "string") {
        const existing = await readReferenceMetadata(index.artifactRef);
        if (
          existing?.bundleRevision === manifest.bundleRevision &&
          existing.manifestFingerprint === manifest.manifestFingerprint &&
          existing.scopeHash === scopeHash
        ) {
          return {
            bundleRevision: existing.bundleRevision,
            manifestFingerprint: existing.manifestFingerprint,
            artifactRef: existing.artifactRef,
          };
        }
      }
    } catch (error) {
      if (error instanceof SkillBundleStoreError) throw error;
      if (!isCode(error, "ENOENT")) throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    const artifactRef = `skill:${randomBytes(32).toString("base64url")}`;
    const metadata: BundleReferenceMetadata = {
      schemaVersion: 1,
      artifactRef,
      bundleRevision: manifest.bundleRevision,
      manifestFingerprint: manifest.manifestFingerprint,
      scopeHash,
    };
    const metadataPath = referencePath(artifactRef);
    const scopeIndexPath = indexPath;
    const transactionDirectory = join(stagingDirectory, `reference-${randomUUID()}`);
    try {
      await mkdir(dirname(metadataPath), { recursive: true });
      await mkdir(dirname(scopeIndexPath), { recursive: true });
      await mkdir(transactionDirectory, { recursive: false });
      await writeFile(join(transactionDirectory, "reference.json"), JSON.stringify(metadata), {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(join(transactionDirectory, "index.json"), JSON.stringify({ artifactRef }), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(join(transactionDirectory, "reference.json"), metadataPath);
      // Windows rename does not replace an existing file. This index is only a
      // deduplication hint; removing a stale hint cannot invalidate old refs.
      await rm(scopeIndexPath, { force: true });
      await rename(join(transactionDirectory, "index.json"), scopeIndexPath);
      return {
        bundleRevision: manifest.bundleRevision,
        manifestFingerprint: manifest.manifestFingerprint,
        artifactRef,
      };
    } catch {
      await rm(transactionDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(metadataPath, { force: true }).catch(() => undefined);
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    } finally {
      await rm(transactionDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function readReferenceMetadata(
    artifactRef: string,
  ): Promise<BundleReferenceMetadata | undefined> {
    const token = referenceToken(artifactRef);
    if (token === undefined) return undefined;
    try {
      const filePath = referencePath(artifactRef);
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined;
      const parsed = referenceMetadataSchema.safeParse(
        JSON.parse(await readFile(filePath, "utf8")),
      );
      return parsed.success && parsed.data.artifactRef === artifactRef ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  function referencePath(artifactRef: string): string {
    const token = referenceToken(artifactRef);
    if (token === undefined) throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    return join(referencesDirectory, `${token}.json`);
  }

  function referenceToken(artifactRef: string): string | undefined {
    if (!/^skill:[A-Za-z0-9_-]{43}$/u.test(artifactRef)) return undefined;
    return artifactRef.slice("skill:".length);
  }

  function lease(artifactRef: string): void {
    prunePreparingReferences();
    if (
      !preparingReferences.has(artifactRef) &&
      preparingReferences.size >= maxPreparingReferences
    ) {
      throw new SkillBundleStoreError("SKILL_BUNDLE_BUSY");
    }
    preparingReferences.set(artifactRef, now() + leaseTtlMs);
  }

  function prunePreparingReferences(): void {
    const timestamp = now();
    for (const [artifactRef, expiresAt] of preparingReferences) {
      if (expiresAt <= timestamp) preparingReferences.delete(artifactRef);
    }
  }

  async function collectGarbageUnsafe(): Promise<SkillBundleGarbageCollectionResult> {
    await ensureDirectories();
    prunePreparingReferences();
    let removedStaging = 0;
    for (const entry of await safeDirectories(stagingDirectory)) {
      await rm(join(stagingDirectory, entry), { recursive: true, force: true });
      removedStaging += 1;
    }
    let removedBundles = 0;
    let removedBytes = 0;
    for (const bundleName of await safeDirectories(bundleDirectory)) {
      if (!bundleNamePattern.test(bundleName)) continue;
      const blobPath = join(bundleDirectory, bundleName);
      let verified: VerifiedBundle;
      try {
        verified = await verifyBundle(blobPath, `sha256:${bundleName}`);
      } catch {
        // Corrupt blobs are retained for explicit repair; GC never hides integrity failures.
        continue;
      }
      const bundleRefs = await readReferencesForBundle(verified.manifest.bundleRevision);
      let referenced = false;
      for (const reference of bundleRefs) {
        if (preparingReferences.has(reference.artifactRef)) {
          referenced = true;
          break;
        }
        if (options.references !== undefined) {
          try {
            if (await options.references.isReferenced(reference)) {
              referenced = true;
              break;
            }
          } catch {
            referenced = true;
            break;
          }
        }
      }
      if (referenced) continue;
      // Without a durable authority, an absent reference cannot be proven
      // unreferenced. Keep the content and let an explicitly wired authority
      // decide when it is safe to collect.
      if (options.references === undefined) continue;
      const bytes = verified.manifest.totalBytes;
      await rm(blobPath, { recursive: true, force: true });
      for (const reference of bundleRefs) {
        const token = referenceToken(reference.artifactRef);
        if (token !== undefined) await rm(referencePath(reference.artifactRef), { force: true });
      }
      await removeScopeIndexes(verified.manifest.bundleRevision, bundleRefs);
      removedBundles += 1;
      removedBytes += bytes;
    }
    return Object.freeze({ removedBundles, removedStaging, removedBytes });
  }

  async function readReferencesForBundle(bundleRevision: string): Promise<SkillBundleRefV1[]> {
    const references: SkillBundleRefV1[] = [];
    for (const filename of await safeFiles(referencesDirectory)) {
      if (!filename.endsWith(".json")) continue;
      const artifactRef = `skill:${filename.slice(0, -5)}`;
      const metadata = await readReferenceMetadata(artifactRef);
      if (metadata === undefined) throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      if (metadata?.bundleRevision !== bundleRevision) continue;
      references.push({
        artifactRef: metadata.artifactRef,
        bundleRevision: metadata.bundleRevision,
        manifestFingerprint: metadata.manifestFingerprint,
      });
    }
    return references;
  }

  async function removeScopeIndexes(
    bundleRevision: string,
    references: readonly SkillBundleRefV1[],
  ): Promise<void> {
    const bundleHash = bundleRevision.slice("sha256:".length);
    const wanted = new Set(references.map(({ artifactRef }) => artifactRef));
    for (const scopeHash of await safeDirectories(scopeIndexDirectory)) {
      const indexPath = join(scopeIndexDirectory, scopeHash, `${bundleHash}.json`);
      try {
        const value = JSON.parse(await readFile(indexPath, "utf8")) as { artifactRef?: unknown };
        if (typeof value.artifactRef === "string" && wanted.has(value.artifactRef)) {
          await rm(indexPath, { force: true });
        }
      } catch {
        // Invalid index files do not grant access and are left for inspection.
      }
    }
  }

  async function storedBytesUnsafe(): Promise<number> {
    let bytes = 0;
    for (const bundleName of await safeDirectories(bundleDirectory)) {
      if (!bundleNamePattern.test(bundleName)) continue;
      const verified = await verifyBundle(
        join(bundleDirectory, bundleName),
        `sha256:${bundleName}`,
      );
      if (verified.manifest.totalBytes > quotaBytes - bytes) return quotaBytes + 1;
      bytes += verified.manifest.totalBytes;
    }
    return bytes;
  }

  async function tryVerifyBundle(
    path: string,
    revision: string,
  ): Promise<VerifiedBundle | undefined> {
    try {
      return await verifyBundle(path, revision);
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
  }

  async function verifyBundleSafely(path: string, revision: string): Promise<VerifiedBundle> {
    try {
      return await verifyBundle(path, revision);
    } catch (error) {
      if (error instanceof SkillBundleStoreError) throw error;
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
  }

  async function verifyBundle(path: string, revision: string): Promise<VerifiedBundle> {
    let directoryInfo;
    try {
      directoryInfo = await lstat(path);
    } catch (error) {
      if (isCode(error, "ENOENT")) throw error;
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    const canonicalRoot = await realpath(path);
    const manifestPath = join(canonicalRoot, "bundle.json");
    const manifestInfo = await lstat(manifestPath);
    if (
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      manifestInfo.size > BUNDLE_MANIFEST_MAX_BYTES
    ) {
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    const manifestParsed = bundleManifestSchema.safeParse(manifestValue);
    if (!manifestParsed.success || manifestParsed.data.bundleRevision !== revision) {
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    const manifest = manifestParsed.data;
    const files = new Map<string, Uint8Array>();
    const packageFiles: SkillPackageFile[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const record of manifest.files) {
      let normalizedPath: string;
      try {
        normalizedPath = normalizeSkillRelativePath(record.relativePath);
      } catch {
        throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      }
      const normalizedKey = normalizedPath.toLowerCase();
      if (seen.has(normalizedKey)) throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      seen.add(normalizedKey);
      const maxBytes =
        normalizedPath === "SKILL.md" ? policy.maxManifestBytes : policy.maxResourceBytes;
      if (record.size > maxBytes || record.size > policy.maxPackageBytes - totalBytes) {
        throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      }
      const contentPath = join(canonicalRoot, ...normalizedPath.split("/"));
      const bytes = await readStoredFileStable(contentPath, canonicalRoot, maxBytes);
      if (bytes.byteLength !== record.size || sha256Hex(bytes) !== record.sha256) {
        throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      }
      totalBytes += bytes.byteLength;
      files.set(normalizedPath, bytes);
      packageFiles.push({ relativePath: normalizedPath, bytes });
    }
    if (
      files.size === 0 ||
      !files.has("SKILL.md") ||
      files.size > policy.maxPackageFiles ||
      totalBytes !== manifest.totalBytes ||
      totalBytes > policy.maxPackageBytes ||
      createSkillPackageFingerprint(packageFiles) !== revision ||
      createSkillFileFingerprint(files.get("SKILL.md")!) !== manifest.manifestFingerprint
    ) {
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    await verifyBundleTree(canonicalRoot, files.keys());
    const parsedManifest = parseSkillManifest(
      new TextDecoder("utf-8", { fatal: true }).decode(files.get("SKILL.md")),
    );
    if (!parsedManifest.ok) throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    return { manifest, files };
  }

  async function verifyBundleTree(root: string, packagePaths: Iterable<string>): Promise<void> {
    const expectedFiles = new Set(packagePaths);
    expectedFiles.add("bundle.json");
    const expectedDirectories = new Set<string>();
    for (const filePath of expectedFiles) {
      const parts = filePath.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        expectedDirectories.add(parts.slice(0, index).join("/"));
      }
    }
    const actualFiles = new Set<string>();

    const walk = async (directory: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      }
      for (const entry of entries) {
        const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
        if (entry.isDirectory()) {
          if (!expectedDirectories.has(relativePath)) {
            throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
          }
          await walk(join(directory, entry.name), relativePath);
        } else if (entry.isFile()) {
          if (!expectedFiles.has(relativePath)) {
            throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
          }
          actualFiles.add(relativePath);
        } else {
          throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
        }
      }
    };

    await walk(root, "");
    if (actualFiles.size !== expectedFiles.size) {
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
  }

  async function safeDirectories(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
  }

  async function safeFiles(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      if (
        entries.some((entry) => entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
      ) {
        throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      }
      if (entries.some((entry) => entry.isDirectory())) {
        throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      }
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error instanceof SkillBundleStoreError) throw error;
      if (isCode(error, "ENOENT")) return [];
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
  }

  return store;
}

async function captureSourceFiles(
  source: SkillBundleSource,
  signal: AbortSignal,
  policy: ReturnType<typeof resolveSkillFilesystemPolicy>,
  beforeStabilityCheck?: (relativePath: string) => void | Promise<void>,
): Promise<SkillPackageFile[]> {
  checkCancelled(signal);
  const sourceRoot = await realpath(source.rootDirectory);
  const packageDirectory = await realpath(source.packageDirectory);
  if (!isWithin(sourceRoot, packageDirectory)) throw new SkillBundleStoreError("SYMLINK_ESCAPE");
  const files: SkillPackageFile[] = [];
  const visited = new Set<string>([packageDirectory]);
  let entriesRead = 0;
  let bytesRead = 0;

  const consumeEntry = () => {
    entriesRead += 1;
    if (entriesRead > policy.maxEntriesPerRoot)
      throw new SkillBundleStoreError("SKILL_PACKAGE_ENTRY_LIMIT");
  };
  const addFile = async (filePath: string, relativePath: string): Promise<void> => {
    checkCancelled(signal);
    const normalizedPath = normalizeSkillRelativePath(relativePath);
    if (files.length >= policy.maxPackageFiles)
      throw new SkillBundleStoreError("SKILL_PACKAGE_FILE_LIMIT");
    const isManifest = normalizedPath === "SKILL.md";
    const maxBytes = isManifest ? policy.maxManifestBytes : policy.maxResourceBytes;
    const remaining = policy.maxPackageBytes - bytesRead;
    if (remaining < 0) throw new SkillBundleStoreError("SKILL_PACKAGE_TOO_LARGE");
    const canonicalPath = await realpath(filePath);
    if (!isWithin(packageDirectory, canonicalPath))
      throw new SkillBundleStoreError("SYMLINK_ESCAPE");
    const bytes = await readSourceFileStable(
      filePath,
      canonicalPath,
      packageDirectory,
      Math.min(maxBytes, remaining),
      isManifest ? "SKILL_PACKAGE_TOO_LARGE" : "SKILL_RESOURCE_TOO_LARGE",
      signal,
      beforeStabilityCheck,
      normalizedPath,
    );
    if (!isManifest && bytes.byteLength > policy.maxResourceBytes) {
      throw new SkillBundleStoreError("SKILL_RESOURCE_TOO_LARGE");
    }
    bytesRead += bytes.byteLength;
    files.push({ relativePath: normalizedPath, bytes });
  };

  await addFile(join(packageDirectory, "SKILL.md"), "SKILL.md");
  const rootEntries = await readdir(packageDirectory, { withFileTypes: true });
  rootEntries.sort((left, right) => compareCodePoints(left.name, right.name));
  for (const entry of rootEntries) {
    checkCancelled(signal);
    consumeEntry();
    if (!["references", "scripts", "assets"].includes(entry.name)) continue;
    const resourcePath = join(packageDirectory, entry.name);
    const canonicalResourceRoot = await realpath(resourcePath);
    if (!isWithin(packageDirectory, canonicalResourceRoot))
      throw new SkillBundleStoreError("SYMLINK_ESCAPE");
    const info = await stat(canonicalResourceRoot);
    if (!info.isDirectory()) continue;
    if (visited.has(canonicalResourceRoot)) throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
    visited.add(canonicalResourceRoot);
    await walkResource(resourcePath, entry.name, 0);
  }

  const parsed = parseSkillManifest(
    new TextDecoder("utf-8", { fatal: true }).decode(
      files.find((file) => file.relativePath === "SKILL.md")!.bytes,
    ),
  );
  if (!parsed.ok || parsed.manifest.name !== source.candidate.manifest.name) {
    throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
  }
  if (bytesRead > policy.maxPackageBytes || files.length > policy.maxPackageFiles) {
    throw new SkillBundleStoreError("SKILL_PACKAGE_TOO_LARGE");
  }
  return files;

  async function walkResource(directory: string, prefix: string, depth: number): Promise<void> {
    checkCancelled(signal);
    if (depth > policy.maxDepth) throw new SkillBundleStoreError("SKILL_PACKAGE_DEPTH_LIMIT");
    const contents = await readdir(directory, { withFileTypes: true });
    contents.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of contents) {
      checkCancelled(signal);
      consumeEntry();
      const childPath = join(directory, entry.name);
      const canonicalPath = await realpath(childPath);
      if (!isWithin(packageDirectory, canonicalPath))
        throw new SkillBundleStoreError("SYMLINK_ESCAPE");
      const info = await stat(canonicalPath);
      if (info.isDirectory()) {
        if (depth >= policy.maxDepth) throw new SkillBundleStoreError("SKILL_PACKAGE_DEPTH_LIMIT");
        if (visited.has(canonicalPath)) throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
        visited.add(canonicalPath);
        await walkResource(childPath, `${prefix}/${entry.name}`, depth + 1);
      } else if (info.isFile()) {
        await addFile(childPath, `${prefix}/${entry.name}`);
      }
    }
  }
}

async function readSourceFileStable(
  originalPath: string,
  resolvedPath: string,
  packageRoot: string,
  maxBytes: number,
  tooLargeCode: SkillBundleStoreErrorCode,
  signal: AbortSignal,
  beforeStabilityCheck: ((relativePath: string) => void | Promise<void>) | undefined,
  relativePath: string,
): Promise<Uint8Array> {
  checkCancelled(signal);
  if (!isWithin(packageRoot, resolvedPath)) throw new SkillBundleStoreError("SYMLINK_ESCAPE");
  const file = await open(resolvedPath, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) {
      throw new SkillBundleStoreError(tooLargeCode);
    }
    const chunks: Buffer[] = [];
    let copiedBytes = 0;
    const chunk = Buffer.alloc(Math.min(64 * KiB, maxBytes + 1));
    while (copiedBytes <= maxBytes) {
      checkCancelled(signal);
      const capacity = Math.min(chunk.byteLength, maxBytes + 1 - copiedBytes);
      const { bytesRead } = await file.read(chunk, 0, capacity, copiedBytes);
      if (bytesRead === 0) break;
      copiedBytes += bytesRead;
      if (copiedBytes > maxBytes) throw new SkillBundleStoreError(tooLargeCode);
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    await beforeStabilityCheck?.(relativePath);
    checkCancelled(signal);
    const after = await file.stat({ bigint: true });
    const resolvedAfter = await realpath(originalPath);
    if (
      resolvedAfter !== resolvedPath ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(copiedBytes) !== after.size
    ) {
      throw new SkillBundleStoreError("SKILL_SOURCE_CHANGED");
    }
    return Buffer.concat(chunks, copiedBytes);
  } catch (error) {
    if (error instanceof SkillBundleStoreError) throw error;
    if (signal.aborted || isAbortError(error))
      throw new SkillBundleStoreError("SKILL_CAPTURE_CANCELLED");
    throw new SkillBundleStoreError("SKILL_BUNDLE_INVALID");
  } finally {
    await file.close();
  }
}

async function readStoredFileStable(
  filePath: string,
  allowedRoot: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const resolvedPath = await realpath(filePath);
  if (!isWithin(allowedRoot, resolvedPath))
    throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
  const linkInfo = await lstat(filePath);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
  }
  const file = await open(resolvedPath, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) {
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    const chunks: Buffer[] = [];
    let copiedBytes = 0;
    const chunk = Buffer.alloc(Math.min(64 * KiB, maxBytes + 1));
    while (copiedBytes <= maxBytes) {
      const capacity = Math.min(chunk.byteLength, maxBytes + 1 - copiedBytes);
      const { bytesRead } = await file.read(chunk, 0, capacity, copiedBytes);
      if (bytesRead === 0) break;
      copiedBytes += bytesRead;
      if (copiedBytes > maxBytes) throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(copiedBytes) !== after.size
    ) {
      throw new SkillBundleStoreError("SKILL_ARTIFACT_INVALID");
    }
    return Buffer.concat(chunks, copiedBytes);
  } finally {
    await file.close();
  }
}

function makeBundleManifest(
  bundleRevision: string,
  manifestFingerprint: string,
  files: readonly SkillPackageFile[],
): BundleManifest {
  let totalBytes = 0;
  const records = [...files]
    .sort((left, right) => compareCodePoints(left.relativePath, right.relativePath))
    .map((file) => {
      totalBytes += file.bytes.byteLength;
      return {
        relativePath: file.relativePath,
        size: file.bytes.byteLength,
        sha256: sha256Hex(file.bytes),
      };
    });
  return Object.freeze({
    schemaVersion: 1,
    bundleRevision,
    manifestFingerprint,
    totalBytes,
    files: Object.freeze(records),
  });
}

function toBoundedSkillResource(relativePath: string, bytes: Uint8Array): BoundedSkillResource {
  const fingerprint = createSkillFileFingerprint(bytes);
  const contentType = contentTypeFor(relativePath);
  if (contentType !== "application/octet-stream") {
    try {
      return Object.freeze({
        kind: "TEXT",
        relativePath,
        contentType,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        fingerprint,
        complete: true,
      });
    } catch {
      // Invalid UTF-8 is exposed as bytes with a generic binary media type.
    }
  }
  return Object.freeze({
    kind: "BYTES",
    relativePath,
    contentType: "application/octet-stream",
    bytes: Uint8Array.from(bytes),
    fingerprint,
    complete: true,
  });
}

function contentTypeFor(relativePath: string): string {
  const extension = relativePath.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "md":
      return "text/markdown; charset=utf-8";
    case "txt":
      return "text/plain; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "yaml":
    case "yml":
      return "application/yaml; charset=utf-8";
    case "js":
      return "text/javascript; charset=utf-8";
    case "ts":
      return "text/typescript; charset=utf-8";
    case "py":
      return "text/x-python; charset=utf-8";
    case "sh":
      return "text/x-shellscript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new SkillBundleStoreError("SKILL_CAPTURE_CANCELLED");
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
