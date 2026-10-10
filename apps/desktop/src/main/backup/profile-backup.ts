import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, realpath, writeFile } from "node:fs/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { z } from "zod";
import { DpapiVault } from "../credentials/vault.js";
import { profileIdForUser } from "../profiles/profile-manager.js";

const MANIFEST_MAGIC = "CAELUSH-PROFILE-BACKUP";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_FILES = 10_000;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024 * 1024;
const MAX_RELATIVE_PATH_LENGTH = 512;
const MANAGED_DIRECTORIES = ["runs", "run", "private-replay-keys"] as const;
const PROFILE_ID_PATTERN = /^u_[0-9a-f]{64}$/u;
const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const BackupFileSchema = z
  .object({
    path: z.string().min(1).max(MAX_RELATIVE_PATH_LENGTH),
    fileName: z.string().regex(/^[A-Za-z0-9_-]{1,700}\.gcm$/u),
    size: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
    authTag: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  })
  .strict();

const BackupManifestSchema = z
  .object({
    magic: z.literal(MANIFEST_MAGIC),
    schemaVersion: z.literal(1),
    backupId: z.uuid(),
    cloudUserId: z.string().regex(USER_ID_PATTERN),
    profileId: z.string().regex(PROFILE_ID_PATTERN),
    createdAtMs: z.number().int().nonnegative().safe(),
    keyReference: z.string().regex(/^B[0-9a-f]{32}$/u),
    files: z.array(BackupFileSchema).max(MAX_BACKUP_FILES),
    mac: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

type BackupFile = z.infer<typeof BackupFileSchema>;
type BackupManifest = z.infer<typeof BackupManifestSchema>;
type BackupManifestBody = Omit<BackupManifest, "mac">;

export type ProfileBackupFaultPoint =
  | "BEFORE_BACKUP_COMPLETE"
  | "BACKUP_MANIFEST_WRITTEN"
  | "BACKUP_VERIFIED"
  | "RESTORE_DECRYPTED"
  | "RESTORE_BEFORE_PUBLISH"
  | "RESTORE_FILE_PUBLISHED"
  | "RESTORE_PUBLISHED";

export class ProfileBackupError extends Error {
  constructor(
    readonly code:
      | "BACKUP_INVALID"
      | "BACKUP_UNAVAILABLE"
      | "BACKUP_IDENTITY_MISMATCH"
      | "BACKUP_TARGET_NOT_EMPTY"
      | "BACKUP_INTERRUPTED",
    message: string,
  ) {
    super(message);
    this.name = "ProfileBackupError";
  }
}

interface ProfileBackupStoreOptions {
  readonly profileRootDirectory: string;
  readonly backupsDirectory: string;
  readonly cloudUserId: string;
  readonly profileId: string;
  readonly vault: DpapiVault;
  readonly now?: () => number;
  readonly faultInjector?: (point: ProfileBackupFaultPoint) => void;
}

/** AES-256-GCM streamed Profile backup. The random data key exists only in the DPAPI vault. */
export class ProfileBackupStore {
  private readonly profileRootDirectory: string;
  private readonly backupsDirectory: string;
  private readonly now: () => number;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ProfileBackupStoreOptions) {
    this.profileRootDirectory = path.resolve(options.profileRootDirectory);
    this.backupsDirectory = path.resolve(options.backupsDirectory);
    this.now = options.now ?? Date.now;
    assertContained(this.profileRootDirectory, this.backupsDirectory);
    if (
      !USER_ID_PATTERN.test(options.cloudUserId) ||
      !PROFILE_ID_PATTERN.test(options.profileId) ||
      profileIdForUser(options.cloudUserId) !== options.profileId
    ) {
      throw new ProfileBackupError(
        "BACKUP_IDENTITY_MISMATCH",
        "The Profile backup identity is invalid.",
      );
    }
  }

  create(
    sourceRootDirectory = this.profileRootDirectory,
  ): Promise<{ readonly backupId: string; readonly state: "BACKUP_VERIFIED" }> {
    const resolvedSourceRoot = path.resolve(sourceRootDirectory);
    return this.exclusive(() => this.createExclusive(resolvedSourceRoot));
  }

  private async createExclusive(sourceRootDirectory: string): Promise<{
    readonly backupId: string;
    readonly state: "BACKUP_VERIFIED";
  }> {
    const backupId = randomUUID();
    const keyReference = `B${backupId.replaceAll("-", "")}`;
    const stagingDirectory = path.join(this.backupsDirectory, `.staging-${backupId}`);
    const finalDirectory = path.join(this.backupsDirectory, backupId);
    const key = randomBytes(32);
    let keyStored = false;
    let snapshotPath: string | undefined;
    try {
      await ensurePrivateDirectory(this.profileRootDirectory);
      await ensurePrivateDirectory(this.backupsDirectory);
      const sourceMetadata = await lstat(sourceRootDirectory);
      if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory())
        throw backupUnavailable();
      if (path.resolve(await realpath(sourceRootDirectory)) !== sourceRootDirectory)
        throw backupUnavailable();
      await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
      await mkdir(path.join(stagingDirectory, "files"), { mode: 0o700 });
      await this.options.vault.set(keyReference, {
        schemaVersion: 1,
        cloudUserId: this.options.cloudUserId,
        profileId: this.options.profileId,
        backupId,
        dataKey: key.toString("base64url"),
      });
      keyStored = true;

      const sourceFiles: Array<{ readonly relativePath: string; readonly absolutePath: string }> =
        [];
      const databasePath = path.join(sourceRootDirectory, "caelush.db");
      if (await isRegularFile(databasePath)) {
        snapshotPath = path.join(stagingDirectory, "database.snapshot");
        await createConsistentSqliteSnapshot(databasePath, snapshotPath);
        sourceFiles.push({ relativePath: "caelush.db", absolutePath: snapshotPath });
      }
      await this.collectProfileFiles(sourceRootDirectory, sourceFiles);
      if (sourceFiles.length > MAX_BACKUP_FILES) throw backupUnavailable();

      const files: BackupFile[] = [];
      let totalBytes = 0;
      for (const file of sourceFiles) {
        const relativePath = validatePayloadPath(file.relativePath);
        const sourceMetadata = await lstat(file.absolutePath);
        if (
          sourceMetadata.isSymbolicLink() ||
          !sourceMetadata.isFile() ||
          sourceMetadata.nlink !== 1
        ) {
          throw backupUnavailable();
        }
        totalBytes += sourceMetadata.size;
        if (totalBytes > MAX_BACKUP_BYTES) throw backupUnavailable();
        const fileName = `${Buffer.from(relativePath, "utf8").toString("base64url")}.gcm`;
        const encryptedPath = path.join(stagingDirectory, "files", fileName);
        const metadata = await encryptStream({
          sourcePath: file.absolutePath,
          destinationPath: encryptedPath,
          key,
          aad: associatedData(
            this.options.cloudUserId,
            this.options.profileId,
            backupId,
            relativePath,
          ),
        });
        if (metadata.size !== sourceMetadata.size) throw backupUnavailable();
        files.push({ path: relativePath, fileName, ...metadata });
      }
      files.sort((left, right) => left.path.localeCompare(right.path, "en"));
      if (snapshotPath !== undefined) await rm(snapshotPath, { force: true });
      snapshotPath = undefined;
      this.options.faultInjector?.("BEFORE_BACKUP_COMPLETE");

      const body: BackupManifestBody = {
        magic: MANIFEST_MAGIC,
        schemaVersion: 1,
        backupId,
        cloudUserId: this.options.cloudUserId,
        profileId: this.options.profileId,
        createdAtMs: this.now(),
        keyReference,
        files,
      };
      const manifest: BackupManifest = { ...body, mac: manifestMac(key, body) };
      await writeFile(path.join(stagingDirectory, "manifest.json"), JSON.stringify(manifest), {
        flag: "wx",
        mode: 0o600,
      });
      this.options.faultInjector?.("BACKUP_MANIFEST_WRITTEN");
      await this.verifyDirectory(stagingDirectory, backupId);
      this.options.faultInjector?.("BACKUP_VERIFIED");
      await rename(stagingDirectory, finalDirectory);
      return { backupId, state: "BACKUP_VERIFIED" };
    } catch (error) {
      if (snapshotPath !== undefined)
        await rm(snapshotPath, { force: true }).catch(() => undefined);
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (keyStored) await this.options.vault.delete(keyReference).catch(() => undefined);
      if (error instanceof ProfileBackupError) throw error;
      throw new ProfileBackupError(
        "BACKUP_UNAVAILABLE",
        "A protected Profile backup could not be created.",
      );
    } finally {
      key.fill(0);
    }
  }

  async verify(
    backupId: string,
  ): Promise<{ readonly backupId: string; readonly verified: true; readonly fileCount: number }> {
    const directory = this.backupDirectory(backupId);
    const manifest = await this.readAndValidateManifest(directory, backupId);
    const key = await this.readDataKey(manifest);
    try {
      await this.verifyDirectoryWithKey(directory, manifest, key);
      return { backupId, verified: true, fileCount: manifest.files.length };
    } catch (error) {
      if (error instanceof ProfileBackupError) throw error;
      throw new ProfileBackupError(
        "BACKUP_INVALID",
        "The protected backup failed integrity verification.",
      );
    } finally {
      key.fill(0);
    }
  }

  /** Restore is idempotent and only adds verified files to an empty matching Profile. */
  restore(
    backupId: string,
    options: { readonly replaceExistingDatabase?: boolean } = {},
  ): Promise<{ readonly backupId: string; readonly state: "DESTINATION_VERIFIED" }> {
    return this.exclusive(() => this.restoreExclusive(backupId, options));
  }

  private async restoreExclusive(
    backupId: string,
    options: { readonly replaceExistingDatabase?: boolean },
  ): Promise<{ readonly backupId: string; readonly state: "DESTINATION_VERIFIED" }> {
    const directory = this.backupDirectory(backupId);
    const manifest = await this.readAndValidateManifest(directory, backupId);
    const key = await this.readDataKey(manifest);
    const stagingDirectory = path.join(this.backupsDirectory, `.restore-${backupId}`);
    try {
      await this.verifyDirectoryWithKey(directory, manifest, key);
      await rm(stagingDirectory, { recursive: true, force: true });
      await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
      for (const file of manifest.files) {
        const stagedPath = payloadPath(stagingDirectory, file.path);
        await mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
        await decryptStream({
          sourcePath: path.join(directory, "files", file.fileName),
          destinationPath: stagedPath,
          key,
          file,
          aad: associatedData(
            this.options.cloudUserId,
            this.options.profileId,
            backupId,
            file.path,
          ),
        });
      }
      this.options.faultInjector?.("RESTORE_DECRYPTED");
      await verifyRestoredProfile(stagingDirectory, manifest, this.options.profileId);
      await this.assertRestoreTargetIsEmptyOrIdentical(manifest, options);
      if (manifest.files.some((file) => file.path === "caelush.db")) {
        await removeSqliteSidecars(path.join(this.profileRootDirectory, "caelush.db"));
      }
      this.options.faultInjector?.("RESTORE_BEFORE_PUBLISH");
      for (const file of manifest.files) {
        const stagedPath = payloadPath(stagingDirectory, file.path);
        const destinationPath = payloadPath(this.profileRootDirectory, file.path);
        if (await isRegularFile(destinationPath)) {
          if ((await hashFile(destinationPath)) === file.sha256) continue;
          if (file.path !== "caelush.db" || !options.replaceExistingDatabase)
            throw restoreTargetNotEmpty();
        }
        await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
        await rename(stagedPath, destinationPath);
        this.options.faultInjector?.("RESTORE_FILE_PUBLISHED");
      }
      if (manifest.files.some((file) => file.path === "caelush.db")) {
        await verifyProfileDatabase(path.join(this.profileRootDirectory, "caelush.db"));
      }
      this.options.faultInjector?.("RESTORE_PUBLISHED");
      return { backupId, state: "DESTINATION_VERIFIED" };
    } catch (error) {
      if (error instanceof ProfileBackupError) throw error;
      throw new ProfileBackupError(
        "BACKUP_INTERRUPTED",
        "Restore did not finish. The verified backup is intact and restore can be retried.",
      );
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      key.fill(0);
    }
  }

  /** Removes only abandoned plaintext staging files after a crash, never a published backup. */
  cleanupIncompleteRestores(): Promise<void> {
    return this.exclusive(() => this.cleanupIncompleteRestoresExclusive());
  }

  private async cleanupIncompleteRestoresExclusive(): Promise<void> {
    await ensurePrivateDirectory(this.backupsDirectory);
    const entries = await readdir(this.backupsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^\.(?:restore|staging)-[0-9a-f-]{36}$/u.test(entry.name)) continue;
      const target = path.join(this.backupsDirectory, entry.name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw backupUnavailable();
      await rm(target, { recursive: true, force: true });
    }
  }

  private async collectProfileFiles(
    sourceRootDirectory: string,
    files: Array<{ readonly relativePath: string; readonly absolutePath: string }>,
  ): Promise<void> {
    const metadataPath = path.join(this.profileRootDirectory, "profile.json");
    if (await isRegularFile(metadataPath))
      files.push({ relativePath: "profile.json", absolutePath: metadataPath });
    for (const directoryName of MANAGED_DIRECTORIES) {
      const root = path.join(sourceRootDirectory, directoryName);
      if (!(await isDirectory(root))) continue;
      await walkFiles(sourceRootDirectory, root, files);
    }
  }

  private async assertRestoreTargetIsEmptyOrIdentical(
    manifest: BackupManifest,
    options: { readonly replaceExistingDatabase?: boolean },
  ): Promise<void> {
    const expected = new Set(manifest.files.map((file) => file.path));
    for (const relativePath of ["caelush.db", "profile.json"] as const) {
      if (expected.has(relativePath)) continue;
      if (await pathExists(payloadPath(this.profileRootDirectory, relativePath)))
        throw restoreTargetNotEmpty();
    }
    for (const relativePath of expected) {
      const target = payloadPath(this.profileRootDirectory, relativePath);
      if (await pathExists(target)) {
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1)
          throw restoreTargetNotEmpty();
        const item = manifest.files.find((file) => file.path === relativePath);
        if (item === undefined) throw restoreTargetNotEmpty();
        const identical = (await hashFile(target)) === item.sha256;
        if (
          !identical &&
          !(relativePath === "caelush.db" && options.replaceExistingDatabase === true)
        )
          throw restoreTargetNotEmpty();
      }
    }
    for (const directoryName of MANAGED_DIRECTORIES) {
      const root = path.join(this.profileRootDirectory, directoryName);
      if (!(await isDirectory(root))) continue;
      const current: Array<{ readonly relativePath: string; readonly absolutePath: string }> = [];
      await walkFiles(this.profileRootDirectory, root, current);
      if (current.some((file) => !expected.has(file.relativePath))) throw restoreTargetNotEmpty();
    }
  }

  private backupDirectory(backupId: string): string {
    if (!z.uuid().safeParse(backupId).success)
      throw new ProfileBackupError("BACKUP_INVALID", "The backup reference is invalid.");
    const directory = path.join(this.backupsDirectory, backupId);
    assertContained(this.backupsDirectory, directory);
    return directory;
  }

  private async readAndValidateManifest(
    directory: string,
    backupId: string,
  ): Promise<BackupManifest> {
    try {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw backupInvalid();
      const manifestPath = path.join(directory, "manifest.json");
      const manifestMetadata = await lstat(manifestPath);
      if (
        manifestMetadata.isSymbolicLink() ||
        !manifestMetadata.isFile() ||
        manifestMetadata.nlink !== 1 ||
        manifestMetadata.size > MAX_MANIFEST_BYTES
      ) {
        throw backupInvalid();
      }
      const parsed = BackupManifestSchema.safeParse(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
      if (!parsed.success || parsed.data.backupId !== backupId) throw backupInvalid();
      if (
        parsed.data.cloudUserId !== this.options.cloudUserId ||
        parsed.data.profileId !== this.options.profileId
      ) {
        throw new ProfileBackupError(
          "BACKUP_IDENTITY_MISMATCH",
          "The backup belongs to a different account Profile.",
        );
      }
      const paths = new Set<string>();
      for (const file of parsed.data.files) {
        validatePayloadPath(file.path);
        if (
          paths.has(file.path) ||
          file.fileName !== `${Buffer.from(file.path, "utf8").toString("base64url")}.gcm`
        ) {
          throw backupInvalid();
        }
        paths.add(file.path);
      }
      if (!paths.has("profile.json")) throw backupInvalid();
      return parsed.data;
    } catch (error) {
      if (error instanceof ProfileBackupError) throw error;
      throw backupInvalid();
    }
  }

  private async readDataKey(manifest: BackupManifest): Promise<Buffer> {
    try {
      const stored = await this.options.vault.get(manifest.keyReference);
      if (typeof stored !== "object" || stored === null || Array.isArray(stored))
        throw backupInvalid();
      const record = stored as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !==
          "backupId,cloudUserId,dataKey,profileId,schemaVersion" ||
        record.schemaVersion !== 1 ||
        record.backupId !== manifest.backupId ||
        record.cloudUserId !== this.options.cloudUserId ||
        record.profileId !== this.options.profileId ||
        typeof record.dataKey !== "string"
      )
        throw backupInvalid();
      const key = Buffer.from(record.dataKey, "base64url");
      if (key.byteLength !== 32 || key.toString("base64url") !== record.dataKey)
        throw backupInvalid();
      return key;
    } catch {
      throw backupInvalid();
    }
  }

  private async verifyDirectory(directory: string, backupId: string): Promise<void> {
    const manifest = await this.readAndValidateManifest(directory, backupId);
    const key = await this.readDataKey(manifest);
    try {
      await this.verifyDirectoryWithKey(directory, manifest, key);
    } finally {
      key.fill(0);
    }
  }

  private async verifyDirectoryWithKey(
    directory: string,
    manifest: BackupManifest,
    key: Buffer,
  ): Promise<void> {
    const { mac, ...body } = manifest;
    const expectedMac = Buffer.from(manifestMac(key, body), "base64url");
    const actualMac = Buffer.from(mac, "base64url");
    if (!safeEqual(actualMac, expectedMac)) throw backupInvalid();
    const filesDirectory = path.join(directory, "files");
    const fileDirectoryInfo = await lstat(filesDirectory);
    if (fileDirectoryInfo.isSymbolicLink() || !fileDirectoryInfo.isDirectory())
      throw backupInvalid();
    const expectedNames = new Set(manifest.files.map((file) => file.fileName));
    const actualNames = await readdir(filesDirectory);
    if (
      actualNames.length !== expectedNames.size ||
      actualNames.some((name) => !expectedNames.has(name))
    )
      throw backupInvalid();
    const rootNames = await readdir(directory);
    if (
      rootNames.length !== 2 ||
      !rootNames.includes("files") ||
      !rootNames.includes("manifest.json")
    )
      throw backupInvalid();
    let totalBytes = 0;
    for (const file of manifest.files) {
      totalBytes += file.size;
      if (totalBytes > MAX_BACKUP_BYTES) throw backupInvalid();
      const sourcePath = path.join(filesDirectory, file.fileName);
      const metadata = await lstat(sourcePath);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size !== file.size
      )
        throw backupInvalid();
      await verifyEncryptedFile({
        sourcePath,
        file,
        key,
        aad: associatedData(manifest.cloudUserId, manifest.profileId, manifest.backupId, file.path),
      });
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

async function createConsistentSqliteSnapshot(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(sourcePath);
    source.exec("PRAGMA busy_timeout = 5000");
    source.prepare("VACUUM INTO ?").run(destinationPath);
  } catch {
    throw backupUnavailable();
  } finally {
    source?.close();
  }
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    const sidecarPath = `${databasePath}${suffix}`;
    try {
      const metadata = await lstat(sidecarPath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
        throw backupUnavailable();
      }
      await rm(sidecarPath);
    } catch (error) {
      if (isFsError(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
}

async function walkFiles(
  profileRootDirectory: string,
  directory: string,
  files: Array<{ readonly relativePath: string; readonly absolutePath: string }>,
): Promise<void> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw backupUnavailable();
  const canonicalDirectory = await realpath(directory);
  assertContained(profileRootDirectory, canonicalDirectory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw backupUnavailable();
    if (entry.isDirectory()) {
      await walkFiles(profileRootDirectory, absolutePath, files);
    } else if (entry.isFile()) {
      const fileMetadata = await lstat(absolutePath);
      if (fileMetadata.nlink !== 1) throw backupUnavailable();
      const relativePath = path
        .relative(profileRootDirectory, absolutePath)
        .split(path.sep)
        .join("/");
      files.push({ relativePath: validatePayloadPath(relativePath), absolutePath });
      if (files.length > MAX_BACKUP_FILES) throw backupUnavailable();
    } else {
      throw backupUnavailable();
    }
  }
}

async function encryptStream(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly key: Buffer;
  readonly aad: Buffer;
}): Promise<Omit<BackupFile, "path" | "fileName">> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(input.aad);
  const hash = createHash("sha256");
  let size = 0;
  const tracker = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(input.sourcePath),
      tracker,
      cipher,
      createWriteStream(input.destinationPath, { flags: "wx", mode: 0o600 }),
    );
    return {
      size,
      sha256: hash.digest("hex"),
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  } catch {
    await rm(input.destinationPath, { force: true }).catch(() => undefined);
    throw backupUnavailable();
  }
}

async function verifyEncryptedFile(input: {
  readonly sourcePath: string;
  readonly file: BackupFile;
  readonly key: Buffer;
  readonly aad: Buffer;
}): Promise<void> {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    input.key,
    Buffer.from(input.file.iv, "base64url"),
  );
  decipher.setAAD(input.aad);
  decipher.setAuthTag(Buffer.from(input.file.authTag, "base64url"));
  const hash = createHash("sha256");
  let size = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      hash.update(chunk);
      callback();
    },
  });
  try {
    await pipeline(createReadStream(input.sourcePath), decipher, sink);
  } catch {
    throw backupInvalid();
  }
  if (size !== input.file.size || hash.digest("hex") !== input.file.sha256) throw backupInvalid();
}

async function decryptStream(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly key: Buffer;
  readonly file: BackupFile;
  readonly aad: Buffer;
}): Promise<void> {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    input.key,
    Buffer.from(input.file.iv, "base64url"),
  );
  decipher.setAAD(input.aad);
  decipher.setAuthTag(Buffer.from(input.file.authTag, "base64url"));
  const hash = createHash("sha256");
  let size = 0;
  const tracker = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      createReadStream(input.sourcePath),
      decipher,
      tracker,
      createWriteStream(input.destinationPath, { flags: "wx", mode: 0o600 }),
    );
  } catch {
    await rm(input.destinationPath, { force: true }).catch(() => undefined);
    throw backupInvalid();
  }
  if (size !== input.file.size || hash.digest("hex") !== input.file.sha256) {
    await rm(input.destinationPath, { force: true }).catch(() => undefined);
    throw backupInvalid();
  }
}

async function verifyRestoredProfile(
  stagingDirectory: string,
  manifest: BackupManifest,
  profileId: string,
): Promise<void> {
  const metadataPath = path.join(stagingDirectory, "profile.json");
  const parsedMetadata = z
    .object({
      schemaVersion: z.literal(1),
      profileId: z.string().regex(PROFILE_ID_PATTERN),
      createdAt: z.string().datetime({ offset: true }),
    })
    .strict()
    .safeParse(JSON.parse(await readFile(metadataPath, "utf8")));
  if (
    !parsedMetadata.success ||
    parsedMetadata.data.profileId !== profileId ||
    manifest.profileId !== profileId
  ) {
    throw backupInvalid();
  }
  const databasePath = path.join(stagingDirectory, "caelush.db");
  if (await isRegularFile(databasePath)) await verifyProfileDatabase(databasePath);
}

async function verifyProfileDatabase(databasePath: string): Promise<void> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const result = database.prepare("PRAGMA integrity_check").get() as
      { integrity_check?: unknown } | undefined;
    if (result?.integrity_check !== "ok") throw backupInvalid();
  } catch {
    throw backupInvalid();
  } finally {
    database?.close();
  }
}

function validatePayloadPath(value: string): string {
  if (
    value.length > MAX_RELATIVE_PATH_LENGTH ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"),
      )
  )
    throw backupInvalid();
  if (
    value !== "caelush.db" &&
    value !== "profile.json" &&
    !MANAGED_DIRECTORIES.some((directory) => value.startsWith(`${directory}/`))
  ) {
    throw backupInvalid();
  }
  return value;
}

function payloadPath(root: string, relativePath: string): string {
  const validated = validatePayloadPath(relativePath);
  const target = path.resolve(root, ...validated.split("/"));
  assertContained(root, target);
  return target;
}

function associatedData(
  userId: string,
  profileId: string,
  backupId: string,
  relativePath: string,
): Buffer {
  return Buffer.from(
    `caelush-profile-backup-v1\0${userId}\0${profileId}\0${backupId}\0${relativePath}`,
    "utf8",
  );
}

function manifestMac(key: Buffer, body: BackupManifestBody): string {
  return createHmac("sha256", key).update(JSON.stringify(body), "utf8").digest("base64url");
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1)
      throw backupUnavailable();
    return true;
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw backupUnavailable();
    return true;
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw backupUnavailable();
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    if (root !== target) throw backupUnavailable();
  }
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function backupInvalid(): ProfileBackupError {
  return new ProfileBackupError("BACKUP_INVALID", "The protected backup is damaged or invalid.");
}

function backupUnavailable(): ProfileBackupError {
  return new ProfileBackupError(
    "BACKUP_UNAVAILABLE",
    "A protected Profile backup operation could not be completed.",
  );
}

function restoreTargetNotEmpty(): ProfileBackupError {
  return new ProfileBackupError(
    "BACKUP_TARGET_NOT_EMPTY",
    "Restore requires an empty Profile destination with the same account identity.",
  );
}

function isFsError(value: unknown): value is NodeJS.ErrnoException {
  return value !== null && typeof value === "object" && "code" in value;
}
