import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DpapiVault, type SafeStoragePort } from "../../src/main/credentials/vault.js";
import { ProviderCredentialVault } from "../../src/main/credentials/provider-credential-vault.js";
import { profileIdForUser } from "../../src/main/profiles/profile-manager.js";
import {
  DesktopProviderCredentialMigrator,
  type ProviderCredentialMigrationFaultPoint,
} from "../../src/main/migration/provider-credential-migration.js";

const roots: string[] = [];
const userId = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
const profileId = profileIdForUser(userId);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createProfile(options: { readonly failEncryption?: () => boolean } = {}) {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), "caelush-provider-migration-test-"));
  roots.push(rootDirectory);
  const profileRootDirectory = path.join(rootDirectory, profileId);
  const backupsDirectory = path.join(profileRootDirectory, "backups");
  await Promise.all(
    ["runs", "run", "private-replay-keys", "logs", "browser", "downloads", "backups"].map((name) =>
      mkdir(path.join(profileRootDirectory, name), { recursive: true }),
    ),
  );
  const metadataPath = path.join(profileRootDirectory, "profile.json");
  await writeFile(
    metadataPath,
    JSON.stringify({ schemaVersion: 1, profileId, createdAt: "2026-01-01T00:00:00.000Z" }),
  );
  const databasePath = path.join(profileRootDirectory, "caelush.db");
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE ai_provider_credentials(provider_id TEXT PRIMARY KEY, secret_value TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);",
  );
  database
    .prepare("INSERT INTO ai_provider_credentials VALUES (?, ?, ?, ?)")
    .run("deepseek", "legacy-provider-key-fixture", 1, 1);
  database.exec("CREATE TABLE durable_fixture(value TEXT NOT NULL);");
  database.prepare("INSERT INTO durable_fixture VALUES (?)").run("preserve-history");
  database.close();
  let allowEncryption = true;
  const storage: SafeStoragePort = {
    isEncryptionAvailable: () => true,
    encryptStringAsync: async (value) => {
      if (options.failEncryption?.() && !allowEncryption) throw new Error("fixture failure");
      allowEncryption = false;
      return Buffer.from(`test-enc:${Buffer.from(value).toString("base64")}`);
    },
    decryptStringAsync: async (value) => {
      const encoded = Buffer.from(value).toString("utf8").slice("test-enc:".length);
      return Buffer.from(encoded, "base64").toString("utf8");
    },
  };
  const vault = new DpapiVault(path.join(rootDirectory, "credentials.dpapi"), storage, "win32");
  await vault.initialize();
  const profile = {
    profileId,
    rootDirectory: profileRootDirectory,
    databasePath,
    runsDirectory: path.join(profileRootDirectory, "runs"),
    logsDirectory: path.join(profileRootDirectory, "logs"),
    backupsDirectory,
    browserDirectory: path.join(profileRootDirectory, "browser"),
    downloadsDirectory: path.join(profileRootDirectory, "downloads"),
    metadataPath,
  };
  return { rootDirectory, profile, vault, credentials: new ProviderCredentialVault(vault) };
}

describe("DesktopProviderCredentialMigrator", () => {
  it.each([
    "BACKUP_CREATED",
    "IMPORT_STAGED",
    "DPAPI_WRITE",
    "CREDENTIALS_SECURED",
    "DATABASE_STAGED",
    "CREDENTIAL_CLEANED",
    "DESTINATION_VERIFIED",
    "COMMITTED",
  ] as const)("recovers idempotently after a %s interruption", async (faultPoint) => {
    const { profile, vault, credentials } = await createProfile();
    let interruptOnce = true;
    const interrupted = new DesktopProviderCredentialMigrator({
      vault,
      credentials,
      faultInjector: (point: ProviderCredentialMigrationFaultPoint) => {
        if (point === faultPoint && interruptOnce) {
          interruptOnce = false;
          throw new Error("simulated process exit");
        }
      },
    });

    await expect(interrupted.run(profile, userId)).rejects.toMatchObject({
      code: "CREDENTIAL_MIGRATION_REQUIRED",
    });
    await expect(
      new DesktopProviderCredentialMigrator({ vault, credentials }).run(profile, userId),
    ).resolves.toMatchObject({ state: "COMMITTED", credentialCount: 1 });
    expect(await credentials.resolve(userId, profileId, "deepseek")).toBe(
      "legacy-provider-key-fixture",
    );
    const recovered = new DatabaseSync(profile.databasePath, { readOnly: true });
    expect(
      recovered.prepare("SELECT count(*) AS count FROM ai_provider_credentials").get(),
    ).toEqual({ count: 0 });
    expect(recovered.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    recovered.close();
    expect(
      (await readFile(profile.databasePath)).includes(Buffer.from("legacy-provider-key-fixture")),
    ).toBe(false);
  });

  it("keeps the legacy row recoverable when backup creation is interrupted", async () => {
    const { profile, vault, credentials } = await createProfile();
    const interrupted = new DesktopProviderCredentialMigrator({
      vault,
      credentials,
      faultInjector: (point) => {
        if (point === "BEFORE_BACKUP_COMPLETE") throw new Error("simulated power loss");
      },
    });
    await expect(interrupted.run(profile, userId)).rejects.toMatchObject({
      code: "CREDENTIAL_MIGRATION_REQUIRED",
    });
    const original = new DatabaseSync(profile.databasePath, { readOnly: true });
    expect(
      original
        .prepare("SELECT secret_value FROM ai_provider_credentials WHERE provider_id = ?")
        .get("deepseek"),
    ).toEqual({ secret_value: "legacy-provider-key-fixture" });
    original.close();
    expect(await (await import("node:fs/promises")).readdir(profile.backupsDirectory)).toEqual([]);

    await expect(
      new DesktopProviderCredentialMigrator({ vault, credentials }).run(profile, userId),
    ).resolves.toMatchObject({ state: "COMMITTED", credentialCount: 1 });
    expect(await credentials.resolve(userId, profileId, "deepseek")).toBe(
      "legacy-provider-key-fixture",
    );
  });

  it("backs up, secures, verifies, and scrubs legacy SQLite Provider keys", async () => {
    const { profile, vault, credentials } = await createProfile();
    const migrator = new DesktopProviderCredentialMigrator({ vault, credentials });

    const result = await migrator.run(profile, userId);

    expect(result).toMatchObject({ state: "COMMITTED", credentialCount: 1 });
    expect(await credentials.resolve(userId, profileId, "deepseek")).toBe(
      "legacy-provider-key-fixture",
    );
    const database = new DatabaseSync(profile.databasePath, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count FROM ai_provider_credentials").get()).toEqual(
      { count: 0 },
    );
    expect(database.prepare("SELECT value FROM durable_fixture").get()).toEqual({
      value: "preserve-history",
    });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();
    const databaseBytes = await readFile(profile.databasePath);
    expect(databaseBytes.includes(Buffer.from("legacy-provider-key-fixture"))).toBe(false);
    const backupId = result.backupId;
    if (backupId === undefined) throw new Error("missing protected backup");
    const backup = await migrator.backupsFor(profile, userId).verify(backupId);
    expect(backup.verified).toBe(true);
    expect(await migrator.run(profile, userId)).toMatchObject({
      state: "COMMITTED",
      credentialCount: 0,
    });
  });

  it("keeps the plaintext row and refuses startup if the DPAPI write fails", async () => {
    let fail = false;
    const { profile, credentials, vault } = await createProfile({ failEncryption: () => fail });
    fail = true;
    const migrator = new DesktopProviderCredentialMigrator({ vault, credentials });

    await expect(migrator.run(profile, userId)).rejects.toMatchObject({
      code: "CREDENTIAL_MIGRATION_REQUIRED",
    });
    const database = new DatabaseSync(profile.databasePath, { readOnly: true });
    expect(
      database
        .prepare("SELECT secret_value FROM ai_provider_credentials WHERE provider_id = ?")
        .get("deepseek"),
    ).toEqual({ secret_value: "legacy-provider-key-fixture" });
    database.close();
  });

  it("resumes after interruption once the Vault write is verified", async () => {
    const { profile, vault, credentials } = await createProfile();
    const interrupted = new DesktopProviderCredentialMigrator({
      vault,
      credentials,
      faultInjector: (point: ProviderCredentialMigrationFaultPoint) => {
        if (point === "CREDENTIALS_SECURED") throw new Error("simulated shutdown");
      },
    });

    await expect(interrupted.run(profile, userId)).rejects.toMatchObject({
      code: "CREDENTIAL_MIGRATION_REQUIRED",
    });
    const beforeRecovery = new DatabaseSync(profile.databasePath, { readOnly: true });
    expect(
      beforeRecovery.prepare("SELECT count(*) AS count FROM ai_provider_credentials").get(),
    ).toEqual({
      count: 1,
    });
    beforeRecovery.close();

    const recovered = await new DesktopProviderCredentialMigrator({ vault, credentials }).run(
      profile,
      userId,
    );
    expect(recovered).toMatchObject({ state: "COMMITTED", credentialCount: 1 });
    expect(await credentials.resolve(userId, profileId, "deepseek")).toBe(
      "legacy-provider-key-fixture",
    );
  });

  it("allows a new empty Profile with no database to start without creating a backup", async () => {
    const { profile, vault, credentials } = await createProfile();
    await rm(profile.databasePath);
    const result = await new DesktopProviderCredentialMigrator({ vault, credentials }).run(
      profile,
      userId,
    );
    expect(result).toEqual({ state: "NO_CREDENTIALS", credentialCount: 0 });
    await expect(
      readFile(path.join(profile.backupsDirectory, "provider-credential-migration.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
