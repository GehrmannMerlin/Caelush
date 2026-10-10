import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ProfileManager, AccountProfile } from "../profiles/profile-manager.js";
import { ProfileBackupStore, type ProfileBackupFaultPoint } from "../backup/profile-backup.js";
import { DpapiVault } from "../credentials/vault.js";
import { DesktopProviderCredentialMigrator } from "./provider-credential-migration.js";
import { readLegacyImportReceipt, writeLegacyImportReceipt } from "./legacy-import-receipt.js";
import type {
  LegacyDataImportResult,
  LegacyDataImportPreparedResult,
  LegacyDataImportSummary,
  LegacyDataSourceKind,
  LegacyDataSourceSummary,
  LegacyImportBlockReason,
  LegacyImportProgress,
} from "../../shared/legacy-data-contract.js";

const SUMMARY_TABLES = {
  workspaces: "workspaces",
  sessions: "agent_sessions",
  runs: "agent_runs",
  messages: "agent_messages",
  durableEvents: "agent_events",
  contextCheckpoints: "context_checkpoints",
  toolExecutions: "tool_invocations",
  providerCredentials: "ai_provider_credentials",
  modelSelections: "ai_default_selections",
} as const;
const MANAGED_DIRECTORIES = ["runs", "run", "private-replay-keys"] as const;
const MAX_SOURCE_FILES = 20_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024 * 1024;
const MAX_CANDIDATE_AGE_MS = 15 * 60 * 1000;

export class DesktopLegacyDataImportError extends Error {
  constructor(
    readonly code:
      | "LEGACY_IMPORT_CONFIRMATION_REQUIRED"
      | "LEGACY_IMPORT_CANDIDATE_EXPIRED"
      | "LEGACY_IMPORT_SOURCE_CHANGED"
      | "LEGACY_IMPORT_TARGET_NOT_EMPTY"
      | "LEGACY_IMPORT_UNAVAILABLE"
      | "LEGACY_IMPORT_RECOVERY_REQUIRED",
    message = legacyImportErrorMessage(code),
  ) {
    super(message);
    this.name = "DesktopLegacyDataImportError";
  }
}

function legacyImportErrorMessage(code: DesktopLegacyDataImportError["code"]): string {
  switch (code) {
    case "LEGACY_IMPORT_CONFIRMATION_REQUIRED":
      return "Confirm the local Profile import before continuing.";
    case "LEGACY_IMPORT_CANDIDATE_EXPIRED":
      return "The source scan expired. Scan the local data again before importing.";
    case "LEGACY_IMPORT_SOURCE_CHANGED":
      return "The source changed after it was scanned. Scan it again before importing.";
    case "LEGACY_IMPORT_TARGET_NOT_EMPTY":
      return "The account Profile contains data. Import was stopped to protect it.";
    case "LEGACY_IMPORT_RECOVERY_REQUIRED":
      return "The protected import needs a recovery retry before the local Agent can start.";
    case "LEGACY_IMPORT_UNAVAILABLE":
      return "Legacy Caelush data could not be imported safely.";
  }
}

export interface DesktopLegacyDataImporterOptions {
  readonly profileManager: Pick<ProfileManager, "selectForUser">;
  readonly vault: DpapiVault;
  readonly credentialMigrator: DesktopProviderCredentialMigrator;
  readonly userProfileDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly faultInjector?: (point: ProfileBackupFaultPoint) => void;
  readonly assertAuthorized?: (cloudUserId: string) => void;
  readonly onProgress?: (progress: LegacyImportProgress) => void;
}

interface InspectedSource {
  readonly sourceKind: LegacyDataSourceKind;
  readonly sourceRootDirectory: string;
  readonly summary: Omit<
    LegacyDataSourceSummary,
    "candidateId" | "sourceLabel" | "sourceKind" | "importable" | "reason"
  >;
  readonly fingerprint: string;
  readonly reason?: LegacyImportBlockReason;
}

interface ImportCandidate extends InspectedSource {
  readonly candidateId: string;
  readonly cloudUserId: string;
  readonly profileId: string;
  readonly expiresAtMs: number;
}

/** Main-only bounded discovery and import for the two explicitly trusted legacy locations. */
export class DesktopLegacyDataImporter {
  private readonly now: () => number;
  private readonly candidates = new Map<string, ImportCandidate>();

  constructor(private readonly options: DesktopLegacyDataImporterOptions) {
    this.now = options.now ?? Date.now;
  }

  async inspect(cloudUserId: string): Promise<LegacyDataImportSummary> {
    const profile = await this.profileForUser(cloudUserId);
    let receipt: Awaited<ReturnType<typeof readLegacyImportReceipt>>;
    let receiptDamaged = false;
    try {
      receipt = await readLegacyImportReceipt(
        profile.backupsDirectory,
        cloudUserId,
        profile.profileId,
      );
    } catch {
      receipt = undefined;
      receiptDamaged = true;
    }
    const pendingRecovery =
      receiptDamaged || (receipt !== undefined && receipt.state !== "COMMITTED");
    const targetEmpty = await isProfileEmpty(profile);
    const sources: LegacyDataSourceSummary[] = [];
    this.candidates.clear();
    for (const source of await this.trustedSources(profile)) {
      const inspected = await inspectSource(source.sourceKind, source.sourceRootDirectory);
      const candidateId = randomUUID();
      const importable = inspected.reason === undefined && !pendingRecovery && targetEmpty;
      const reason = pendingRecovery
        ? undefined
        : (inspected.reason ?? (targetEmpty ? undefined : "TARGET_NOT_EMPTY"));
      const candidate: ImportCandidate = {
        ...inspected,
        candidateId,
        cloudUserId,
        profileId: profile.profileId,
        expiresAtMs: this.now() + MAX_CANDIDATE_AGE_MS,
      };
      this.candidates.set(candidateId, candidate);
      sources.push({
        candidateId,
        sourceKind: source.sourceKind,
        sourceLabel:
          source.sourceKind === "DEFAULT_HOME" ? "Default Caelush data" : "Custom CAELUSH_HOME",
        importable,
        ...(reason === undefined ? {} : { reason }),
        ...inspected.summary,
      });
    }
    return {
      sources,
      pendingRecovery,
      ...(pendingRecovery
        ? {
            recoveryState:
              receipt?.state === "IMPORT_STAGED" ||
              receipt?.state === "RECOVERY_BLOCKED" ||
              receipt?.state === "DESTINATION_VERIFIED"
                ? receipt.state
                : "RECOVERY_BLOCKED",
          }
        : {}),
    };
  }

  async import(
    cloudUserId: string,
    candidateId: string,
    confirmed: boolean,
  ): Promise<LegacyDataImportResult> {
    const prepared = await this.stageImport(cloudUserId, candidateId, confirmed);
    return this.commitImport(cloudUserId, prepared);
  }

  async stageImport(
    cloudUserId: string,
    candidateId: string,
    confirmed: boolean,
  ): Promise<LegacyDataImportPreparedResult> {
    if (!confirmed) {
      throw new DesktopLegacyDataImportError(
        "LEGACY_IMPORT_CONFIRMATION_REQUIRED",
        "Confirm the local Profile import before continuing.",
      );
    }
    this.options.assertAuthorized?.(cloudUserId);
    const activeReceipt = await this.readReceiptOrFailClosed(cloudUserId);
    if (activeReceipt !== undefined && activeReceipt.state !== "COMMITTED") {
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_RECOVERY_REQUIRED");
    }
    const candidate = this.candidates.get(candidateId);
    if (
      candidate === undefined ||
      candidate.cloudUserId !== cloudUserId ||
      candidate.expiresAtMs < this.now()
    ) {
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_CANDIDATE_EXPIRED");
    }
    const profile = await this.profileForUser(cloudUserId);
    if (profile.profileId !== candidate.profileId || !(await isProfileEmpty(profile))) {
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_TARGET_NOT_EMPTY");
    }
    const current = await inspectSource(candidate.sourceKind, candidate.sourceRootDirectory);
    if (current.fingerprint !== candidate.fingerprint || current.reason !== undefined) {
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_SOURCE_CHANGED");
    }

    const backups = this.backupsFor(profile, cloudUserId);
    await backups.cleanupIncompleteRestores();
    try {
      this.options.assertAuthorized?.(cloudUserId);
      const backup = await backups.create(candidate.sourceRootDirectory);
      await backups.verify(backup.backupId);
      this.options.onProgress?.("BACKUP_VERIFIED");
      this.options.assertAuthorized?.(cloudUserId);
      await writeLegacyImportReceipt(profile.backupsDirectory, {
        cloudUserId,
        profileId: profile.profileId,
        state: "IMPORT_STAGED",
        backupId: backup.backupId,
        sourceKind: candidate.sourceKind,
        summary: candidate.summary,
        updatedAtMs: this.now(),
      });
      this.options.onProgress?.("IMPORT_STAGED");
      await backups.restore(backup.backupId);
      this.options.onProgress?.("DESTINATION_VERIFIED");
      this.options.assertAuthorized?.(cloudUserId);
      const migration = await this.options.credentialMigrator.run(profile, cloudUserId, {
        allowPendingLegacyImport: true,
      });
      this.options.onProgress?.("CREDENTIALS_SECURED");
      await writeLegacyImportReceipt(profile.backupsDirectory, {
        cloudUserId,
        profileId: profile.profileId,
        state: "DESTINATION_VERIFIED",
        backupId: backup.backupId,
        sourceKind: candidate.sourceKind,
        summary: candidate.summary,
        updatedAtMs: this.now(),
      });
      this.candidates.delete(candidateId);
      return {
        state: "DESTINATION_VERIFIED",
        profileId: profile.profileId,
        backupId: backup.backupId,
        credentialCount: migration.credentialCount,
        imported: candidate.summary,
      };
    } catch (error) {
      const receipt = await readLegacyImportReceipt(
        profile.backupsDirectory,
        cloudUserId,
        profile.profileId,
      ).catch(() => undefined);
      if (
        receipt !== undefined &&
        receipt.state !== "COMMITTED" &&
        receipt.state !== "DESTINATION_VERIFIED"
      ) {
        await writeLegacyImportReceipt(profile.backupsDirectory, {
          cloudUserId,
          profileId: profile.profileId,
          state: "RECOVERY_BLOCKED",
          backupId: receipt.backupId,
          sourceKind: receipt.sourceKind,
          summary: receipt.summary,
          updatedAtMs: this.now(),
        }).catch(() => undefined);
      }
      this.options.onProgress?.("RECOVERY_REQUIRED");
      if (error instanceof DesktopLegacyDataImportError) throw error;
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_UNAVAILABLE");
    }
  }

  async resumeImport(cloudUserId: string): Promise<LegacyDataImportResult> {
    const prepared = await this.stageResumeImport(cloudUserId);
    return this.commitImport(cloudUserId, prepared);
  }

  async stageResumeImport(cloudUserId: string): Promise<LegacyDataImportPreparedResult> {
    this.options.assertAuthorized?.(cloudUserId);
    const profile = await this.profileForUser(cloudUserId);
    const receipt = await readLegacyImportReceipt(
      profile.backupsDirectory,
      cloudUserId,
      profile.profileId,
    ).catch(() => undefined);
    if (receipt === undefined || receipt.state === "COMMITTED") {
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_RECOVERY_REQUIRED");
    }
    const backups = this.backupsFor(profile, cloudUserId);
    try {
      if (receipt.state !== "DESTINATION_VERIFIED") {
        await backups.restore(receipt.backupId, { replaceExistingDatabase: true });
        this.options.onProgress?.("DESTINATION_VERIFIED");
      }
      this.options.assertAuthorized?.(cloudUserId);
      const migration = await this.options.credentialMigrator.run(profile, cloudUserId, {
        allowPendingLegacyImport: true,
      });
      this.options.onProgress?.("CREDENTIALS_SECURED");
      await writeLegacyImportReceipt(profile.backupsDirectory, {
        cloudUserId,
        profileId: profile.profileId,
        state: "DESTINATION_VERIFIED",
        backupId: receipt.backupId,
        sourceKind: receipt.sourceKind,
        summary: receipt.summary,
        updatedAtMs: this.now(),
      });
      this.options.onProgress?.("DESTINATION_VERIFIED");
      return {
        state: "DESTINATION_VERIFIED",
        profileId: profile.profileId,
        backupId: receipt.backupId,
        credentialCount: migration.credentialCount,
        imported: receipt.summary,
      };
    } catch {
      if (receipt.state !== "DESTINATION_VERIFIED") {
        await writeLegacyImportReceipt(profile.backupsDirectory, {
          cloudUserId,
          profileId: profile.profileId,
          state: "RECOVERY_BLOCKED",
          backupId: receipt.backupId,
          sourceKind: receipt.sourceKind,
          summary: receipt.summary,
          updatedAtMs: this.now(),
        }).catch(() => undefined);
      }
      this.options.onProgress?.("RECOVERY_REQUIRED");
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_RECOVERY_REQUIRED");
    }
  }

  async commitImport(
    cloudUserId: string,
    prepared: LegacyDataImportPreparedResult,
  ): Promise<LegacyDataImportResult> {
    this.options.assertAuthorized?.(cloudUserId);
    const profile = await this.profileForUser(cloudUserId);
    const receipt = await readLegacyImportReceipt(
      profile.backupsDirectory,
      cloudUserId,
      profile.profileId,
    ).catch(() => undefined);
    if (
      receipt === undefined ||
      receipt.state !== "DESTINATION_VERIFIED" ||
      receipt.backupId !== prepared.backupId ||
      receipt.profileId !== prepared.profileId
    ) {
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_RECOVERY_REQUIRED");
    }
    await writeLegacyImportReceipt(profile.backupsDirectory, {
      cloudUserId,
      profileId: profile.profileId,
      state: "COMMITTED",
      backupId: receipt.backupId,
      sourceKind: receipt.sourceKind,
      summary: receipt.summary,
      updatedAtMs: this.now(),
    });
    this.options.onProgress?.("COMMITTED");
    return { ...prepared, state: "COMMITTED" };
  }

  private async profileForUser(cloudUserId: string): Promise<AccountProfile> {
    try {
      return await this.options.profileManager.selectForUser(cloudUserId);
    } catch {
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_UNAVAILABLE");
    }
  }

  private async readReceiptOrFailClosed(cloudUserId: string) {
    const profile = await this.profileForUser(cloudUserId);
    try {
      return await readLegacyImportReceipt(
        profile.backupsDirectory,
        cloudUserId,
        profile.profileId,
      );
    } catch {
      throw new DesktopLegacyDataImportError("LEGACY_IMPORT_RECOVERY_REQUIRED");
    }
  }

  private async trustedSources(
    profile: AccountProfile,
  ): Promise<
    readonly { readonly sourceKind: LegacyDataSourceKind; readonly sourceRootDirectory: string }[]
  > {
    const environment = this.options.environment ?? process.env;
    const home = this.options.userProfileDirectory ?? environment.USERPROFILE ?? homedir();
    const candidates = [
      { sourceKind: "DEFAULT_HOME" as const, sourceRootDirectory: path.join(home, ".caelush") },
      ...(environment.CAELUSH_HOME === undefined || environment.CAELUSH_HOME.trim().length === 0
        ? []
        : [
            {
              sourceKind: "CUSTOM_HOME" as const,
              sourceRootDirectory: environment.CAELUSH_HOME,
            },
          ]),
    ];
    const seen = new Set<string>();
    const profileRoot = path.resolve(profile.rootDirectory).toLowerCase();
    const result = [];
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate.sourceRootDirectory);
      if (resolved.toLowerCase() === profileRoot) continue;
      const canonical = await realDirectory(resolved);
      if (canonical === undefined || seen.has(canonical.toLowerCase())) continue;
      seen.add(canonical.toLowerCase());
      result.push({ ...candidate, sourceRootDirectory: canonical });
    }
    return result;
  }

  private backupsFor(profile: AccountProfile, cloudUserId: string): ProfileBackupStore {
    return new ProfileBackupStore({
      profileRootDirectory: profile.rootDirectory,
      backupsDirectory: profile.backupsDirectory,
      cloudUserId,
      profileId: profile.profileId,
      vault: this.options.vault,
      ...(this.options.faultInjector === undefined
        ? {}
        : { faultInjector: this.options.faultInjector }),
    });
  }
}

async function inspectSource(
  sourceKind: LegacyDataSourceKind,
  sourceRootDirectory: string,
): Promise<InspectedSource> {
  const emptyCounts = {
    workspaces: 0,
    sessions: 0,
    runs: 0,
    messages: 0,
    durableEvents: 0,
    contextCheckpoints: 0,
    toolExecutions: 0,
    providerCredentials: 0,
    modelSelections: 0,
    privateReplayFiles: 0,
    estimatedBytes: 0,
  };
  const root = await realDirectory(sourceRootDirectory);
  if (root === undefined) {
    return {
      sourceKind,
      sourceRootDirectory,
      summary: emptyCounts,
      fingerprint: "missing",
      reason: "SOURCE_UNREADABLE",
    };
  }
  try {
    const databasePath = path.join(root, "caelush.db");
    const databaseMetadata = await lstat(databasePath);
    if (
      databaseMetadata.isSymbolicLink() ||
      !databaseMetadata.isFile() ||
      databaseMetadata.nlink !== 1
    ) {
      throw new Error("database");
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    let counts = { ...emptyCounts };
    let recognizedCount = 0;
    let integrity: unknown;
    try {
      const known = new Set(Object.values(SUMMARY_TABLES));
      const availableTables = new Set(
        (
          database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            readonly name: string;
          }>
        ).map((row) => row.name),
      );
      for (const tableName of known) if (availableTables.has(tableName)) recognizedCount += 1;
      for (const [key, tableName] of Object.entries(SUMMARY_TABLES) as Array<
        [keyof typeof SUMMARY_TABLES, string]
      >) {
        if (!availableTables.has(tableName)) continue;
        const row = database.prepare(`SELECT count(*) AS count FROM "${tableName}"`).get() as {
          readonly count?: unknown;
        };
        const count = Number(row.count);
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("count");
        counts = { ...counts, [key]: count };
      }
      integrity = (
        database.prepare("PRAGMA integrity_check").get() as {
          readonly integrity_check?: unknown;
        }
      ).integrity_check;
    } finally {
      database.close();
    }
    if (integrity !== "ok") throw new Error("integrity");
    if (recognizedCount === 0) throw new Error("schema");
    const assets = await collectSourceFiles(root);
    const privateReplayFiles = assets.filter((file) =>
      file.relativePath.startsWith("private-replay-keys/"),
    ).length;
    const estimatedBytes =
      databaseMetadata.size + assets.reduce((total, file) => total + file.size, 0);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          databaseSize: databaseMetadata.size,
          databaseMtime: databaseMetadata.mtimeMs,
          counts,
          assets: assets.map(({ relativePath, size, mtimeMs }) => [relativePath, size, mtimeMs]),
        }),
      )
      .digest("hex");
    return {
      sourceKind,
      sourceRootDirectory: root,
      summary: { ...counts, privateReplayFiles, estimatedBytes },
      fingerprint,
      ...(Object.values(counts).every((count) => count === 0) && assets.length === 0
        ? { reason: "NO_IMPORTABLE_DATA" as const }
        : {}),
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.message === "schema"
        ? "UNSUPPORTED_SCHEMA"
        : "SOURCE_UNREADABLE";
    return {
      sourceKind,
      sourceRootDirectory: root,
      summary: emptyCounts,
      fingerprint: "blocked",
      reason,
    };
  }
}

async function collectSourceFiles(
  root: string,
): Promise<
  readonly { readonly relativePath: string; readonly size: number; readonly mtimeMs: number }[]
> {
  const files: Array<{ relativePath: string; size: number; mtimeMs: number }> = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("source");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("source");
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const fileMetadata = await lstat(absolutePath);
        if (fileMetadata.nlink !== 1) throw new Error("source");
        const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
        files.push({ relativePath, size: fileMetadata.size, mtimeMs: fileMetadata.mtimeMs });
        totalBytes += fileMetadata.size;
        if (files.length > MAX_SOURCE_FILES || totalBytes > MAX_SOURCE_BYTES)
          throw new Error("source");
      } else {
        throw new Error("source");
      }
    }
  };
  for (const name of MANAGED_DIRECTORIES) {
    const directory = path.join(root, name);
    try {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("source");
      await visit(directory);
    } catch (error) {
      if (!isFsError(error) || error.code !== "ENOENT") throw error;
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

async function isProfileEmpty(profile: AccountProfile): Promise<boolean> {
  let database: DatabaseSync | undefined;
  try {
    const metadata = await lstat(profile.databasePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) return false;
    database = new DatabaseSync(profile.databasePath, { readOnly: true });
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{
      readonly name: string;
    }>;
    for (const { name } of tables) {
      if (name === "sqlite_sequence" || name === "__drizzle_migrations") continue;
      const row = database
        .prepare(`SELECT count(*) AS count FROM "${name.replaceAll('"', '""')}"`)
        .get() as {
        readonly count?: unknown;
      };
      if (Number(row.count) !== 0) {
        return false;
      }
    }
  } catch (error) {
    if (!isFsError(error) || error.code !== "ENOENT") return false;
  } finally {
    database?.close();
  }
  for (const name of MANAGED_DIRECTORIES) {
    const directory = path.join(profile.rootDirectory, name);
    try {
      if ((await readdir(directory)).length > 0) return false;
    } catch (error) {
      if (!isFsError(error) || error.code !== "ENOENT") return false;
    }
  }
  return true;
}

async function realDirectory(directory: string): Promise<string | undefined> {
  try {
    const resolved = path.resolve(directory);
    const metadata = await lstat(resolved);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return undefined;
    const canonical = await realpath(resolved);
    if (path.resolve(canonical) !== resolved) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

function isFsError(value: unknown): value is NodeJS.ErrnoException {
  return value !== null && typeof value === "object" && "code" in value;
}
