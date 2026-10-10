import { DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AccountProfile } from "../profiles/profile-manager.js";
import { profileIdForUser } from "../profiles/profile-manager.js";
import { ProfileBackupStore, type ProfileBackupFaultPoint } from "../backup/profile-backup.js";
import { ProviderCredentialVault } from "../credentials/provider-credential-vault.js";
import { DpapiVault } from "../credentials/vault.js";
import { readLegacyImportReceipt } from "./legacy-import-receipt.js";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_CREDENTIAL_LENGTH = 16_384;
const ReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    cloudUserId: z.uuid(),
    profileId: z.string().regex(/^u_[0-9a-f]{64}$/u),
    state: z.enum([
      "BACKUP_CREATED",
      "IMPORT_STAGED",
      "CREDENTIALS_SECURED",
      "DESTINATION_VERIFIED",
      "COMMITTED",
      "ROLLBACK_REQUIRED",
      "ROLLBACK_COMPLETED",
      "RECOVERY_BLOCKED",
    ]),
    resumeState: z
      .enum(["BACKUP_CREATED", "IMPORT_STAGED", "CREDENTIALS_SECURED", "DESTINATION_VERIFIED"])
      .optional(),
    backupId: z.uuid().optional(),
    credentialCount: z.number().int().nonnegative().safe(),
    updatedAtMs: z.number().int().nonnegative().safe(),
  })
  .strict();

type MigrationState = z.infer<typeof ReceiptSchema>["state"];
type ResumeState =
  "BACKUP_CREATED" | "IMPORT_STAGED" | "CREDENTIALS_SECURED" | "DESTINATION_VERIFIED";
interface CredentialRow {
  readonly provider_id: string;
  readonly secret_value: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export type ProviderCredentialMigrationFaultPoint =
  | "BACKUP_CREATED"
  | "IMPORT_STAGED"
  | "DPAPI_WRITE"
  | "CREDENTIALS_SECURED"
  | "DATABASE_STAGED"
  | "CREDENTIAL_CLEANED"
  | "DESTINATION_VERIFIED"
  | "COMMITTED";

export class ProviderCredentialMigrationError extends Error {
  constructor(
    readonly code: "CREDENTIAL_MIGRATION_REQUIRED",
    message = "Legacy Provider credentials need secure recovery before the local Agent can start.",
  ) {
    super(message);
    this.name = "ProviderCredentialMigrationError";
  }
}

export interface ProviderCredentialMigrationResult {
  readonly state: "NO_CREDENTIALS" | "COMMITTED";
  readonly credentialCount: number;
  readonly backupId?: string;
}

export interface DesktopProviderCredentialMigratorOptions {
  readonly vault: DpapiVault;
  readonly credentials: ProviderCredentialVault;
  readonly now?: () => number;
  readonly faultInjector?: (
    point: ProviderCredentialMigrationFaultPoint | ProfileBackupFaultPoint,
  ) => void;
}

/** Main-only migration gate. It runs after ProfileManager validates ownership and before Daemon spawn. */
export class DesktopProviderCredentialMigrator {
  private readonly now: () => number;

  constructor(private readonly options: DesktopProviderCredentialMigratorOptions) {
    this.now = options.now ?? Date.now;
  }

  backupsFor(profile: AccountProfile, cloudUserId: string): ProfileBackupStore {
    if (profile.profileId !== profileIdForUser(cloudUserId)) throw migrationRequired();
    return new ProfileBackupStore({
      profileRootDirectory: profile.rootDirectory,
      backupsDirectory: profile.backupsDirectory,
      cloudUserId,
      profileId: profile.profileId,
      vault: this.options.vault,
      ...(this.options.faultInjector === undefined
        ? {}
        : { faultInjector: (point) => this.options.faultInjector?.(point) }),
    });
  }

  async run(
    profile: AccountProfile,
    cloudUserId: string,
    options: { readonly allowPendingLegacyImport?: boolean } = {},
  ): Promise<ProviderCredentialMigrationResult> {
    if (profile.profileId !== profileIdForUser(cloudUserId)) throw migrationRequired();
    const metadata = await this.readProfileMetadata(profile);
    if (metadata.profileId !== profile.profileId) throw migrationRequired();
    let importReceipt;
    try {
      importReceipt = await readLegacyImportReceipt(
        profile.backupsDirectory,
        cloudUserId,
        profile.profileId,
      );
    } catch {
      throw migrationRequired();
    }
    if (
      importReceipt !== undefined &&
      importReceipt.state !== "COMMITTED" &&
      importReceipt.state !== "DESTINATION_VERIFIED" &&
      (!options.allowPendingLegacyImport ||
        (importReceipt.state !== "IMPORT_STAGED" && importReceipt.state !== "RECOVERY_BLOCKED"))
    ) {
      throw migrationRequired();
    }
    const backups = this.backupsFor(profile, cloudUserId);
    await backups.cleanupIncompleteRestores();
    const rows = await readLegacyCredentialRows(profile.databasePath);
    const receiptPath = path.join(profile.backupsDirectory, "provider-credential-migration.json");
    let receipt = await readReceipt(receiptPath, cloudUserId, profile.profileId);
    let resumeState: ResumeState | undefined = receiptResumeState(receipt);
    let backupId = receipt?.backupId;
    if (receipt?.state === "COMMITTED" && rows.length > 0) {
      resumeState = undefined;
      backupId = undefined;
    }
    const pendingRecovery = resumeState !== undefined;
    const credentialCount = pendingRecovery
      ? Math.max(rows.length, receipt?.credentialCount ?? 0)
      : rows.length;

    if (rows.length === 0 && !pendingRecovery) {
      if (receipt?.state === "COMMITTED") {
        return {
          state: "COMMITTED",
          credentialCount: 0,
          ...(receipt.backupId === undefined ? {} : { backupId: receipt.backupId }),
        };
      }
      return { state: "NO_CREDENTIALS", credentialCount: 0 };
    }

    try {
      if (backupId !== undefined) {
        await backups.verify(backupId);
      } else {
        const backup = await backups.create();
        backupId = backup.backupId;
        resumeState = "BACKUP_CREATED";
        receipt = await this.writeReceipt(receiptPath, cloudUserId, profile.profileId, {
          state: "BACKUP_CREATED",
          backupId,
          credentialCount,
        });
        this.options.faultInjector?.("BACKUP_CREATED");
      }

      if (resumeState === undefined || resumeState === "BACKUP_CREATED") {
        resumeState = "IMPORT_STAGED";
        receipt = await this.writeReceipt(receiptPath, cloudUserId, profile.profileId, {
          state: "IMPORT_STAGED",
          backupId,
          credentialCount,
        });
        this.options.faultInjector?.("IMPORT_STAGED");
      }

      if (resumeState === "IMPORT_STAGED") {
        await this.secureCredentials(rows, cloudUserId, profile.profileId);
        resumeState = "CREDENTIALS_SECURED";
        receipt = await this.writeReceipt(receiptPath, cloudUserId, profile.profileId, {
          state: "CREDENTIALS_SECURED",
          backupId,
          credentialCount,
        });
        this.options.faultInjector?.("CREDENTIALS_SECURED");
      }

      if (resumeState === "CREDENTIALS_SECURED" || resumeState === "DESTINATION_VERIFIED") {
        this.options.faultInjector?.("DATABASE_STAGED");
        if (resumeState === "CREDENTIALS_SECURED") {
          await cleanCredentialRows(profile.databasePath, rows);
          this.options.faultInjector?.("CREDENTIAL_CLEANED");
        }
        const remaining = await readLegacyCredentialRows(profile.databasePath);
        if (remaining.length !== 0) throw migrationRequired();
        await verifyDatabaseIntegrity(profile.databasePath);
        resumeState = "DESTINATION_VERIFIED";
        receipt = await this.writeReceipt(receiptPath, cloudUserId, profile.profileId, {
          state: "DESTINATION_VERIFIED",
          backupId,
          credentialCount,
        });
        this.options.faultInjector?.("DESTINATION_VERIFIED");
      }

      receipt = await this.writeReceipt(receiptPath, cloudUserId, profile.profileId, {
        state: "COMMITTED",
        backupId,
        credentialCount,
      });
      this.options.faultInjector?.("COMMITTED");
      return {
        state: "COMMITTED",
        credentialCount,
        ...(receipt.backupId === undefined ? {} : { backupId: receipt.backupId }),
      };
    } catch {
      if (backupId !== undefined) {
        const recoveryState = resumeState ?? "BACKUP_CREATED";
        await this.writeReceipt(receiptPath, cloudUserId, profile.profileId, {
          state: "RECOVERY_BLOCKED",
          resumeState: recoveryState,
          backupId,
          credentialCount,
        }).catch(() => undefined);
      }
      throw migrationRequired();
    }
  }

  private async secureCredentials(
    rows: readonly CredentialRow[],
    cloudUserId: string,
    profileId: string,
  ): Promise<void> {
    const currentValues = new Map<string, string | undefined>();
    for (const row of rows) {
      const current = await this.options.credentials.resolve(
        cloudUserId,
        profileId,
        row.provider_id,
      );
      if (current !== undefined && current !== row.secret_value) throw migrationRequired();
      currentValues.set(row.provider_id, current);
    }
    for (const row of rows) {
      if (currentValues.get(row.provider_id) === undefined) {
        await this.options.credentials.set(
          cloudUserId,
          profileId,
          row.provider_id,
          row.secret_value,
        );
        this.options.faultInjector?.("DPAPI_WRITE");
      }
    }
    for (const row of rows) {
      const confirmed = await this.options.credentials.resolve(
        cloudUserId,
        profileId,
        row.provider_id,
      );
      if (confirmed !== row.secret_value) throw migrationRequired();
    }
  }

  private async readProfileMetadata(profile: AccountProfile): Promise<{
    readonly profileId: string;
    readonly createdAt: string;
    readonly schemaVersion: 1;
  }> {
    try {
      const metadata = await lstat(profile.metadataPath);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size > 4096
      ) {
        throw migrationRequired();
      }
      const parsed = z
        .object({
          schemaVersion: z.literal(1),
          profileId: z.string().regex(/^u_[0-9a-f]{64}$/u),
          createdAt: z.string().datetime({ offset: true }),
        })
        .strict()
        .parse(JSON.parse(await readFile(profile.metadataPath, "utf8")));
      return parsed;
    } catch {
      throw migrationRequired();
    }
  }

  private async writeReceipt(
    receiptPath: string,
    cloudUserId: string,
    profileId: string,
    input: {
      readonly state: MigrationState;
      readonly resumeState?: ResumeState;
      readonly backupId?: string;
      readonly credentialCount: number;
    },
  ): Promise<z.infer<typeof ReceiptSchema>> {
    const record = ReceiptSchema.parse({
      schemaVersion: 1,
      cloudUserId,
      profileId,
      ...input,
      updatedAtMs: this.now(),
    });
    const temp = `${receiptPath}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      await rename(temp, receiptPath);
      return record;
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
      throw migrationRequired();
    }
  }
}

async function readLegacyCredentialRows(databasePath: string): Promise<readonly CredentialRow[]> {
  let database: DatabaseSync | undefined;
  try {
    const metadata = await lstat(databasePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1)
      throw migrationRequired();
    database = new DatabaseSync(databasePath, { readOnly: true });
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_provider_credentials'",
      )
      .get() as { readonly name: string } | undefined;
    if (table === undefined) return [];
    const columns = database.prepare("PRAGMA table_info(ai_provider_credentials)").all() as Array<{
      readonly name: string;
    }>;
    const expected = ["provider_id", "secret_value", "created_at_ms", "updated_at_ms"];
    if (expected.some((name) => !columns.some((column) => column.name === name)))
      throw migrationRequired();
    const rows = database
      .prepare(
        "SELECT provider_id, secret_value, created_at_ms, updated_at_ms FROM ai_provider_credentials ORDER BY provider_id",
      )
      .all() as unknown as CredentialRow[];
    const providers = new Set<string>();
    for (const row of rows) {
      if (
        !PROVIDER_ID_PATTERN.test(row.provider_id) ||
        providers.has(row.provider_id) ||
        typeof row.secret_value !== "string" ||
        row.secret_value.trim().length === 0 ||
        row.secret_value.length > MAX_CREDENTIAL_LENGTH ||
        !Number.isSafeInteger(row.created_at_ms) ||
        !Number.isSafeInteger(row.updated_at_ms)
      )
        throw migrationRequired();
      providers.add(row.provider_id);
    }
    return rows;
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") return [];
    throw migrationRequired();
  } finally {
    database?.close();
  }
}

async function cleanCredentialRows(
  databasePath: string,
  expectedRows: readonly CredentialRow[],
): Promise<void> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA secure_delete = ON");
    database.exec("BEGIN IMMEDIATE");
    const rows = database
      .prepare(
        "SELECT provider_id, secret_value, created_at_ms, updated_at_ms FROM ai_provider_credentials ORDER BY provider_id",
      )
      .all() as unknown as CredentialRow[];
    if (rows.length > 0 && JSON.stringify(rows) !== JSON.stringify(expectedRows))
      throw migrationRequired();
    if (rows.length > 0) database.prepare("DELETE FROM ai_provider_credentials").run();
    database.exec("COMMIT");
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      { readonly busy?: number } | undefined;
    if (checkpoint?.busy !== undefined && checkpoint.busy !== 0) throw migrationRequired();
    const journalMode = database.prepare("PRAGMA journal_mode = DELETE").get() as
      { readonly journal_mode?: string } | undefined;
    if (journalMode?.journal_mode?.toLowerCase() !== "delete") throw migrationRequired();
    database.exec("VACUUM");
    database.close();
    database = undefined;
    await verifyDatabaseIntegrity(databasePath);
    for (const row of expectedRows) {
      if (await fileContains(databasePath, Buffer.from(row.secret_value, "utf8")))
        throw migrationRequired();
    }
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      try {
        const sidecar = await lstat(`${databasePath}${suffix}`);
        if (sidecar.isSymbolicLink() || !sidecar.isFile() || sidecar.size !== 0)
          throw migrationRequired();
      } catch (error) {
        if (!isFsError(error) || error.code !== "ENOENT") throw error;
      }
    }
  } catch {
    try {
      if (database?.isTransaction) database.exec("ROLLBACK");
    } catch {
      // Startup remains blocked and the encrypted backup plus receipt allow a safe retry.
    }
    throw migrationRequired();
  } finally {
    database?.close();
  }
}

async function verifyDatabaseIntegrity(databasePath: string): Promise<void> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const result = database.prepare("PRAGMA integrity_check").get() as
      { readonly integrity_check?: unknown } | undefined;
    if (result?.integrity_check !== "ok") throw migrationRequired();
  } catch {
    throw migrationRequired();
  } finally {
    database?.close();
  }
}

async function readReceipt(
  receiptPath: string,
  cloudUserId: string,
  profileId: string,
): Promise<z.infer<typeof ReceiptSchema> | undefined> {
  try {
    const metadata = await lstat(receiptPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size > 4096
    )
      throw migrationRequired();
    const parsed = ReceiptSchema.safeParse(JSON.parse(await readFile(receiptPath, "utf8")));
    if (
      !parsed.success ||
      parsed.data.cloudUserId !== cloudUserId ||
      parsed.data.profileId !== profileId
    )
      throw migrationRequired();
    return parsed.data;
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") return undefined;
    throw migrationRequired();
  }
}

function migrationRequired(): ProviderCredentialMigrationError {
  return new ProviderCredentialMigrationError("CREDENTIAL_MIGRATION_REQUIRED");
}

function receiptResumeState(
  receipt: z.infer<typeof ReceiptSchema> | undefined,
): ResumeState | undefined {
  if (receipt === undefined) return undefined;
  if (receipt.state === "RECOVERY_BLOCKED") return receipt.resumeState;
  switch (receipt.state) {
    case "BACKUP_CREATED":
    case "IMPORT_STAGED":
    case "CREDENTIALS_SECURED":
    case "DESTINATION_VERIFIED":
      return receipt.state;
    default:
      return undefined;
  }
}

async function fileContains(filePath: string, needle: Buffer): Promise<boolean> {
  if (needle.byteLength === 0) return true;
  let carry = Buffer.alloc(0);
  for await (const rawChunk of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    if (combined.includes(needle)) return true;
    const overlap = Math.min(needle.byteLength - 1, combined.byteLength);
    carry = combined.subarray(combined.byteLength - overlap);
  }
  return false;
}

function isFsError(value: unknown): value is NodeJS.ErrnoException {
  return value !== null && typeof value === "object" && "code" in value;
}
