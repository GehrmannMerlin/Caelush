import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, relative, sep } from "node:path";
import {
  SkillBundleRefV1Schema,
  SkillDescriptionSchema,
  SkillIdSchema,
  SkillNameSchema,
  WorkflowCatalogSnapshotRefV1Schema,
  type RunId,
  type SkillBundleRefV1,
  type WorkflowCatalogSnapshotRefV1,
} from "@caelush/protocol";
import { parseExplicitSkillSearchTerms, type SkillCandidate } from "@caelush/skills";
import { z } from "zod";
import type { SkillCatalogService, SkillRunCatalogSourceSnapshot } from "./catalog-service.js";
import type { FilesystemSkillBundleStore } from "./bundle-store.js";
import { SkillServiceError } from "./feature-policy.js";

const DEFAULT_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_STORE_BYTES = 1024 * 1024 * 1024;
const PREPARING_REFERENCE_TTL_MS = 5 * 60 * 1000;
const MAX_SKILL_COUNT = 100_000;

const runCatalogSkillSchema = z
  .object({
    skillId: SkillIdSchema,
    name: SkillNameSchema,
    description: SkillDescriptionSchema,
    displayName: z.string().min(1).max(256).optional(),
    enabled: z.boolean(),
    userInvocable: z.boolean(),
    modelInvocable: z.boolean(),
    searchTerms: z.array(z.string().min(1).max(512)).max(64).optional(),
    bundle: SkillBundleRefV1Schema,
  })
  .strict();

const runCatalogSnapshotPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1).max(128),
    catalogRevision: z.string().min(1).max(256),
    complete: z.literal(true),
    skills: z.array(runCatalogSkillSchema).max(MAX_SKILL_COUNT).readonly(),
  })
  .strict();

export const RunSkillCatalogSnapshotSchema = runCatalogSnapshotPayloadSchema
  .extend({
    artifactRef: z.string().min(1).max(512),
    manifestFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();
export type RunSkillCatalogSnapshot = z.infer<typeof RunSkillCatalogSnapshotSchema>;

export interface RunSkillCatalogSnapshotService {
  captureRunSkillCatalog(input: {
    readonly runId: RunId;
    readonly workspaceId: string;
    readonly signal: AbortSignal;
  }): Promise<RunSkillCatalogSnapshot>;
  readRunSkillCatalogSnapshot(
    reference: WorkflowCatalogSnapshotRefV1 | RunSkillCatalogSnapshot,
  ): Promise<RunSkillCatalogSnapshot>;
  collectGarbage(): Promise<void>;
  isBundleArtifactReferenced(artifactRef: string): Promise<boolean>;
}

export interface RunSkillCatalogSnapshotServiceOptions {
  readonly rootDirectory: string;
  readonly catalog?: Pick<SkillCatalogService, "getRunCatalogSourceSnapshot">;
  readonly bundleStore?: Pick<FilesystemSkillBundleStore, "captureCandidate">;
  readonly maxSnapshotBytes?: number;
  readonly maxSnapshotStoreBytes?: number;
  readonly referenceAuthority?: {
    isReferenced(artifactRef: string): Promise<boolean>;
  };
}

export function createRunSkillCatalogSnapshotService(
  options: RunSkillCatalogSnapshotServiceOptions,
): RunSkillCatalogSnapshotService {
  const rootDirectory = resolve(options.rootDirectory);
  const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const maxSnapshotStoreBytes = options.maxSnapshotStoreBytes ?? DEFAULT_MAX_SNAPSHOT_STORE_BYTES;
  if (
    !Number.isSafeInteger(maxSnapshotBytes) ||
    maxSnapshotBytes < 1024 ||
    maxSnapshotBytes > 64 * 1024 * 1024
  ) {
    throw new RangeError("The Run catalog snapshot byte limit is outside the supported range.");
  }
  if (
    !Number.isSafeInteger(maxSnapshotStoreBytes) ||
    maxSnapshotStoreBytes < maxSnapshotBytes ||
    maxSnapshotStoreBytes > 4 * 1024 * 1024 * 1024
  ) {
    throw new RangeError("The Run catalog snapshot store limit is outside the supported range.");
  }
  const preparingReferences = new Map<string, number>();
  let writeQueue: Promise<void> = Promise.resolve();

  function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return Object.freeze({
    async captureRunSkillCatalog(input: {
      readonly runId: RunId;
      readonly workspaceId: string;
      readonly signal: AbortSignal;
    }) {
      if (options.catalog === undefined || options.bundleStore === undefined) {
        throw new SkillServiceError("SKILLS_UNAVAILABLE");
      }
      void input.runId;
      if (input.signal.aborted) throw new SkillServiceError("SKILL_LOAD_FAILED");
      const source = await readCatalogSource(options.catalog, input);
      if (!source.complete) throw new SkillServiceError("SKILL_LOAD_FAILED");

      const skills = [];
      for (const entry of source.entries) {
        if (input.signal.aborted || entry.candidate.bundleRevision === undefined) {
          throw new SkillServiceError("SKILL_LOAD_FAILED");
        }
        const bundle = await captureCandidate(options.bundleStore, {
          candidate: entry.candidate,
          workspaceId: input.workspaceId,
          signal: input.signal,
        });
        if (bundle.bundleRevision !== entry.candidate.bundleRevision) {
          throw new SkillServiceError("SKILL_SELECTION_STALE");
        }
        skills.push(toSnapshotSkill(entry, bundle));
      }

      const payload = runCatalogSnapshotPayloadSchema.parse({
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        catalogRevision: source.catalogRevision,
        complete: true,
        skills,
      });
      const encoded = JSON.stringify(payload);
      const bytes = Buffer.byteLength(encoded, "utf8");
      if (bytes > maxSnapshotBytes) throw new SkillServiceError("SKILL_LOAD_FAILED");
      const fingerprint = snapshotFingerprint(encoded);
      const reference = WorkflowCatalogSnapshotRefV1Schema.parse({
        catalogRevision: payload.catalogRevision,
        artifactRef: `skillcatalog:${fingerprint}`,
        manifestFingerprint: `sha256:${fingerprint}`,
      });
      await withWriteLock(() =>
        persistSnapshot({
          rootDirectory,
          fingerprint,
          encoded,
          maxSnapshotBytes,
          maxSnapshotStoreBytes,
          preparingReferences,
          ...(options.referenceAuthority === undefined
            ? {}
            : { referenceAuthority: options.referenceAuthority }),
        }),
      );
      return freezeSnapshot({ ...payload, ...reference });
    },

    async readRunSkillCatalogSnapshot(
      reference: WorkflowCatalogSnapshotRefV1 | RunSkillCatalogSnapshot,
    ) {
      const parsedRef = WorkflowCatalogSnapshotRefV1Schema.safeParse({
        catalogRevision: reference.catalogRevision,
        artifactRef: reference.artifactRef,
        manifestFingerprint: reference.manifestFingerprint,
      });
      if (!parsedRef.success) throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
      const fingerprint = parsedRef.data.manifestFingerprint.slice("sha256:".length);
      if (parsedRef.data.artifactRef !== `skillcatalog:${fingerprint}`) {
        throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
      }
      const encoded = await readSnapshot(rootDirectory, fingerprint, maxSnapshotBytes);
      let decoded: unknown;
      try {
        decoded = JSON.parse(encoded);
      } catch {
        throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
      }
      const payload = runCatalogSnapshotPayloadSchema.safeParse(decoded);
      if (
        !payload.success ||
        payload.data.catalogRevision !== parsedRef.data.catalogRevision ||
        snapshotFingerprint(encoded) !== fingerprint
      ) {
        throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
      }
      return freezeSnapshot({ ...payload.data, ...parsedRef.data });
    },
    async collectGarbage() {
      await withWriteLock(() =>
        collectGarbageUnsafe({
          rootDirectory,
          maxSnapshotBytes,
          preparingReferences,
          ...(options.referenceAuthority === undefined
            ? {}
            : { referenceAuthority: options.referenceAuthority }),
        }),
      );
    },
    async isBundleArtifactReferenced(artifactRef: string) {
      await withWriteLock(() =>
        collectGarbageUnsafe({
          rootDirectory,
          maxSnapshotBytes,
          preparingReferences,
          ...(options.referenceAuthority === undefined
            ? {}
            : { referenceAuthority: options.referenceAuthority }),
        }),
      );
      let entries;
      try {
        entries = await readdir(rootDirectory, { withFileTypes: true });
      } catch (error) {
        if (isCode(error, "ENOENT")) return false;
        throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const fingerprint = entry.name.slice(0, -".json".length);
        if (!/^[a-f0-9]{64}$/u.test(fingerprint)) continue;
        try {
          const encoded = await readSnapshot(rootDirectory, fingerprint, maxSnapshotBytes);
          const parsed = runCatalogSnapshotPayloadSchema.safeParse(JSON.parse(encoded));
          if (!parsed.success || snapshotFingerprint(encoded) !== fingerprint) {
            return true;
          }
          if (parsed.data.skills.some((skill) => skill.bundle.artifactRef === artifactRef)) {
            return true;
          }
        } catch {
          // A corrupt retained snapshot may still be needed by a Run; keep bundles conservatively.
          return true;
        }
      }
      return false;
    },
  });
}

async function readCatalogSource(
  catalog: Pick<SkillCatalogService, "getRunCatalogSourceSnapshot">,
  input: { readonly workspaceId: string; readonly signal: AbortSignal },
): Promise<SkillRunCatalogSourceSnapshot> {
  try {
    return await catalog.getRunCatalogSourceSnapshot(input);
  } catch (error) {
    if (error instanceof SkillServiceError) throw error;
    throw new SkillServiceError("SKILL_LOAD_FAILED");
  }
}

async function captureCandidate(
  bundleStore: Pick<FilesystemSkillBundleStore, "captureCandidate">,
  input: {
    readonly candidate: SkillCandidate;
    readonly workspaceId: string;
    readonly signal: AbortSignal;
  },
): Promise<SkillBundleRefV1> {
  try {
    return SkillBundleRefV1Schema.parse(await bundleStore.captureCandidate(input));
  } catch (error) {
    if (error instanceof SkillServiceError) throw error;
    throw new SkillServiceError("SKILL_LOAD_FAILED");
  }
}

function toSnapshotSkill(
  entry: SkillRunCatalogSourceSnapshot["entries"][number],
  bundle: SkillBundleRefV1,
) {
  return runCatalogSkillSchema.parse({
    skillId: entry.candidate.skillId,
    name: entry.candidate.manifest.name,
    description: entry.candidate.manifest.description,
    ...(entry.candidate.manifest.metadata?.["displayName"] === undefined
      ? {}
      : { displayName: entry.candidate.manifest.metadata["displayName"] }),
    enabled: entry.enabled,
    userInvocable: entry.candidate.manifest.userInvocable,
    modelInvocable: entry.modelInvocable,
    searchTerms: parseExplicitSkillSearchTerms(entry.candidate.manifest.metadata),
    bundle,
  });
}

function freezeSnapshot(snapshot: RunSkillCatalogSnapshot): RunSkillCatalogSnapshot {
  return Object.freeze({
    ...snapshot,
    skills: Object.freeze(snapshot.skills.map((skill) => Object.freeze({ ...skill }))),
  });
}

async function persistSnapshot(input: {
  readonly rootDirectory: string;
  readonly fingerprint: string;
  readonly encoded: string;
  readonly maxSnapshotBytes: number;
  readonly maxSnapshotStoreBytes: number;
  readonly preparingReferences: Map<string, number>;
  readonly referenceAuthority?: { isReferenced(artifactRef: string): Promise<boolean> };
}): Promise<void> {
  const {
    rootDirectory,
    fingerprint,
    encoded,
    maxSnapshotBytes,
    maxSnapshotStoreBytes,
    preparingReferences,
    referenceAuthority,
  } = input;
  const artifactRef = `skillcatalog:${fingerprint}`;
  const filePath = snapshotPath(rootDirectory, fingerprint);
  try {
    await ensureSnapshotDirectory(rootDirectory);
    const existing = await readSnapshot(rootDirectory, fingerprint, maxSnapshotBytes).catch(
      () => undefined,
    );
    if (existing !== undefined) {
      if (existing !== encoded) throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
      leasePreparingReference(preparingReferences, artifactRef);
      return;
    }
    await collectGarbageUnsafe({
      rootDirectory,
      maxSnapshotBytes,
      preparingReferences,
      ...(referenceAuthority === undefined ? {} : { referenceAuthority }),
    });
    const storedBytes = await storedSnapshotBytes(rootDirectory);
    const incomingBytes = Buffer.byteLength(encoded, "utf8");
    if (storedBytes > maxSnapshotStoreBytes - incomingBytes) {
      throw new SkillServiceError("SKILL_LOAD_FAILED");
    }
    const temporaryPath = join(rootDirectory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, encoded, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (isCode(error, "EEXIST") || isCode(error, "ENOTEMPTY")) {
        const existing = await readSnapshot(rootDirectory, fingerprint, maxSnapshotBytes);
        if (existing === encoded) {
          leasePreparingReference(preparingReferences, artifactRef);
          return;
        }
      }
      throw error;
    }
    leasePreparingReference(preparingReferences, artifactRef);
  } catch (error) {
    if (error instanceof SkillServiceError) throw error;
    throw new SkillServiceError("SKILL_LOAD_FAILED");
  }
}

async function collectGarbageUnsafe(input: {
  readonly rootDirectory: string;
  readonly maxSnapshotBytes: number;
  readonly preparingReferences: Map<string, number>;
  readonly referenceAuthority?: { isReferenced(artifactRef: string): Promise<boolean> };
}): Promise<void> {
  await ensureSnapshotDirectory(input.rootDirectory);
  const timestamp = Date.now();
  for (const [artifactRef, expiresAt] of input.preparingReferences) {
    if (expiresAt <= timestamp) input.preparingReferences.delete(artifactRef);
  }
  const entries = await readdir(input.rootDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fingerprint = entry.name.slice(0, -".json".length);
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) continue;
    const artifactRef = `skillcatalog:${fingerprint}`;
    if (input.preparingReferences.has(artifactRef) || input.referenceAuthority === undefined) {
      continue;
    }
    let encoded: string;
    try {
      encoded = await readSnapshot(input.rootDirectory, fingerprint, input.maxSnapshotBytes);
      const parsed = runCatalogSnapshotPayloadSchema.safeParse(JSON.parse(encoded));
      if (!parsed.success || snapshotFingerprint(encoded) !== fingerprint) continue;
    } catch {
      continue;
    }
    const reference = `skillcatalog:${snapshotFingerprint(encoded)}`;
    if (reference !== artifactRef) continue;
    try {
      if (await input.referenceAuthority.isReferenced(artifactRef)) continue;
    } catch {
      continue;
    }
    await rm(snapshotPath(input.rootDirectory, fingerprint), { force: true });
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
    const temporaryPath = join(input.rootDirectory, entry.name);
    const info = await lstat(temporaryPath).catch(() => undefined);
    if (info?.isFile() && !info.isSymbolicLink()) await rm(temporaryPath, { force: true });
  }
}

function leasePreparingReference(
  preparingReferences: Map<string, number>,
  artifactRef: string,
): void {
  preparingReferences.set(artifactRef, Date.now() + PREPARING_REFERENCE_TTL_MS);
}

async function storedSnapshotBytes(rootDirectory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(rootDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const info = await lstat(join(rootDirectory, entry.name));
    if (!info.isFile() || info.isSymbolicLink()) continue;
    bytes += info.size;
    if (!Number.isSafeInteger(bytes)) return Number.MAX_SAFE_INTEGER;
  }
  return bytes;
}

async function readSnapshot(
  rootDirectory: string,
  fingerprint: string,
  maxBytes: number,
): Promise<string> {
  try {
    await ensureSnapshotDirectory(rootDirectory);
    const filePath = snapshotPath(rootDirectory, fingerprint);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
      throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
    }
    const canonicalRoot = await realpath(rootDirectory);
    const canonicalFile = await realpath(filePath);
    const pathFromRoot = relative(canonicalRoot, canonicalFile);
    if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
      throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
    }
    return await readFile(canonicalFile, "utf8");
  } catch (error) {
    if (error instanceof SkillServiceError) throw error;
    throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
  }
}

async function ensureSnapshotDirectory(rootDirectory: string): Promise<void> {
  await mkdir(rootDirectory, { recursive: true });
  const info = await lstat(rootDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
  }
}

function snapshotPath(rootDirectory: string, fingerprint: string): string {
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new SkillServiceError("SKILL_ARTIFACT_INVALID");
  }
  return join(rootDirectory, `${fingerprint}.json`);
}

function snapshotFingerprint(encoded: string): string {
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
