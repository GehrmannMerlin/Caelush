import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DpapiVault, type SafeStoragePort } from "../../src/main/credentials/vault.js";
import { profileIdForUser } from "../../src/main/profiles/profile-manager.js";
import {
  ProfileBackupStore,
  type ProfileBackupFaultPoint,
} from "../../src/main/backup/profile-backup.js";

const roots: string[] = [];
const userId = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
const otherUserId = "3657e5a0-275c-4ae6-950f-511646d3f647";
const profileId = profileIdForUser(userId);

const testStorage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptStringAsync: async (value) =>
    Buffer.from(`test-enc:${Buffer.from(value).toString("base64")}`),
  decryptStringAsync: async (value) => {
    const encoded = Buffer.from(value).toString("utf8").slice("test-enc:".length);
    return Buffer.from(encoded, "base64").toString("utf8");
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProfileBackupStore", () => {
  it("cleans up an incomplete encrypted backup without changing the plaintext source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-profile-backup-interrupted-"));
    roots.push(root);
    const profileRootDirectory = path.join(root, profileId);
    const backupsDirectory = path.join(profileRootDirectory, "backups");
    await mkdir(backupsDirectory, { recursive: true });
    await writeFile(
      path.join(profileRootDirectory, "profile.json"),
      JSON.stringify({ schemaVersion: 1, profileId, createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    const databasePath = path.join(profileRootDirectory, "caelush.db");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE history_fixture(value TEXT NOT NULL)");
    database.prepare("INSERT INTO history_fixture VALUES (?)").run("recoverable-history");
    database.close();
    const original = await readFile(databasePath);
    const vault = new DpapiVault(path.join(root, "credentials.dpapi"), testStorage, "win32");
    await vault.initialize();
    const interrupted = new ProfileBackupStore({
      profileRootDirectory,
      backupsDirectory,
      cloudUserId: userId,
      profileId,
      vault,
      faultInjector: (point: ProfileBackupFaultPoint) => {
        if (point === "BEFORE_BACKUP_COMPLETE") throw new Error("simulated power loss");
      },
    });
    await expect(interrupted.create()).rejects.toMatchObject({ code: "BACKUP_UNAVAILABLE" });
    expect(await readFile(databasePath)).toEqual(original);
    expect(await readdir(backupsDirectory)).toEqual([]);
    const stillReadable = new DatabaseSync(databasePath, { readOnly: true });
    expect(stillReadable.prepare("SELECT value FROM history_fixture").get()).toEqual({
      value: "recoverable-history",
    });
    stillReadable.close();
  });

  it("streams a protected Profile backup, verifies it, and restores it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-profile-backup-test-"));
    roots.push(root);
    const profileRootDirectory = path.join(root, profileId);
    const backupsDirectory = path.join(profileRootDirectory, "backups");
    await Promise.all([
      mkdir(path.join(profileRootDirectory, "runs", "run-fixture"), { recursive: true }),
      mkdir(path.join(profileRootDirectory, "run"), { recursive: true }),
      mkdir(path.join(profileRootDirectory, "private-replay-keys"), { recursive: true }),
      mkdir(backupsDirectory, { recursive: true }),
    ]);
    const databasePath = path.join(profileRootDirectory, "caelush.db");
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE ai_provider_credentials(provider_id TEXT PRIMARY KEY, secret_value TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);",
    );
    database
      .prepare("INSERT INTO ai_provider_credentials VALUES (?, ?, ?, ?)")
      .run("deepseek", "legacy-provider-key-fixture", 1, 1);
    database.exec("CREATE TABLE history_fixture(value TEXT NOT NULL);");
    database.prepare("INSERT INTO history_fixture VALUES (?)").run("durable-run-fixture");
    database.close();
    await writeFile(
      path.join(profileRootDirectory, "profile.json"),
      JSON.stringify({ schemaVersion: 1, profileId, createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    await writeFile(
      path.join(profileRootDirectory, "runs", "run-fixture", "artifact.bin"),
      "run-artifact-fixture",
    );
    await writeFile(
      path.join(profileRootDirectory, "private-replay-keys", "master.v1.json"),
      "encrypted-replay-key-fixture",
    );

    const vault = new DpapiVault(path.join(root, "credentials.dpapi"), testStorage, "win32");
    await vault.initialize();
    const backups = new ProfileBackupStore({
      profileRootDirectory,
      backupsDirectory,
      cloudUserId: userId,
      profileId,
      vault,
    });
    const backup = await backups.create();

    await expect(backups.verify(backup.backupId)).resolves.toMatchObject({
      backupId: backup.backupId,
      verified: true,
      fileCount: 4,
    });
    const backupFiles = await readdir(path.join(backupsDirectory, backup.backupId, "files"));
    const backupContents = Buffer.concat(
      await Promise.all(
        backupFiles.map((name) =>
          readFile(path.join(backupsDirectory, backup.backupId, "files", name)),
        ),
      ),
    );
    expect(backupContents.includes(Buffer.from("legacy-provider-key-fixture"))).toBe(false);

    await rm(databasePath);
    await rm(path.join(profileRootDirectory, "runs"), { recursive: true, force: true });
    await rm(path.join(profileRootDirectory, "private-replay-keys"), {
      recursive: true,
      force: true,
    });
    let interruptOnce = true;
    const interruptedRestore = new ProfileBackupStore({
      profileRootDirectory,
      backupsDirectory,
      cloudUserId: userId,
      profileId,
      vault,
      faultInjector: (point: ProfileBackupFaultPoint) => {
        if (point === "RESTORE_FILE_PUBLISHED" && interruptOnce) {
          interruptOnce = false;
          throw new Error("simulated process exit");
        }
      },
    });
    await expect(interruptedRestore.restore(backup.backupId)).rejects.toMatchObject({
      code: "BACKUP_INTERRUPTED",
    });
    await backups.restore(backup.backupId);

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(restored.prepare("SELECT value FROM history_fixture").get()).toEqual({
      value: "durable-run-fixture",
    });
    expect(
      restored
        .prepare("SELECT secret_value FROM ai_provider_credentials WHERE provider_id = ?")
        .get("deepseek"),
    ).toEqual({ secret_value: "legacy-provider-key-fixture" });
    restored.close();
    await expect(
      readFile(path.join(profileRootDirectory, "runs", "run-fixture", "artifact.bin"), "utf8"),
    ).resolves.toBe("run-artifact-fixture");
    await expect(
      readFile(path.join(profileRootDirectory, "private-replay-keys", "master.v1.json"), "utf8"),
    ).resolves.toBe("encrypted-replay-key-fixture");
  });

  it("fails closed when the authenticated manifest is damaged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-profile-backup-tamper-"));
    roots.push(root);
    const profileRootDirectory = path.join(root, profileId);
    const backupsDirectory = path.join(profileRootDirectory, "backups");
    await mkdir(backupsDirectory, { recursive: true });
    await writeFile(
      path.join(profileRootDirectory, "profile.json"),
      JSON.stringify({ schemaVersion: 1, profileId, createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    const vault = new DpapiVault(path.join(root, "credentials.dpapi"), testStorage, "win32");
    await vault.initialize();
    const backups = new ProfileBackupStore({
      profileRootDirectory,
      backupsDirectory,
      cloudUserId: userId,
      profileId,
      vault,
    });
    const backup = await backups.create();
    const otherAccount = new ProfileBackupStore({
      profileRootDirectory,
      backupsDirectory,
      cloudUserId: otherUserId,
      profileId: profileIdForUser(otherUserId),
      vault,
    });
    await expect(otherAccount.verify(backup.backupId)).rejects.toMatchObject({
      code: "BACKUP_IDENTITY_MISMATCH",
    });

    await writeFile(path.join(backupsDirectory, backup.backupId, "manifest.json"), "{}");
    await expect(backups.verify(backup.backupId)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });
  });

  it("restores an interrupted import database without retaining stale SQLite sidecars", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-profile-backup-sidecars-"));
    roots.push(root);
    const profileRootDirectory = path.join(root, profileId);
    const backupsDirectory = path.join(profileRootDirectory, "backups");
    await mkdir(backupsDirectory, { recursive: true });
    await writeFile(
      path.join(profileRootDirectory, "profile.json"),
      JSON.stringify({ schemaVersion: 1, profileId, createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    const databasePath = path.join(profileRootDirectory, "caelush.db");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE history_fixture(value TEXT NOT NULL)");
    database.prepare("INSERT INTO history_fixture VALUES (?)").run("legacy-history");
    database.close();

    const vault = new DpapiVault(path.join(root, "credentials.dpapi"), testStorage, "win32");
    await vault.initialize();
    const backups = new ProfileBackupStore({
      profileRootDirectory,
      backupsDirectory,
      cloudUserId: userId,
      profileId,
      vault,
    });
    const backup = await backups.create();

    const changed = new DatabaseSync(databasePath);
    changed.exec("CREATE TABLE interrupted_import(value TEXT NOT NULL)");
    changed.close();
    await Promise.all(
      ["-wal", "-shm", "-journal"].map((suffix) =>
        writeFile(`${databasePath}${suffix}`, "stale imported SQLite page"),
      ),
    );

    await backups.restore(backup.backupId, { replaceExistingDatabase: true });

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    expect(restored.prepare("SELECT value FROM history_fixture").get()).toEqual({
      value: "legacy-history",
    });
    expect(
      restored
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("interrupted_import"),
    ).toBeUndefined();
    restored.close();
    await Promise.all(
      ["-wal", "-shm", "-journal"].map((suffix) =>
        expect(readFile(`${databasePath}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" }),
      ),
    );
  });
});
