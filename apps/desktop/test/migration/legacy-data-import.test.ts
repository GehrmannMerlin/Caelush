import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProfileManager,
  type ProfilePermissions,
} from "../../src/main/profiles/profile-manager.js";
import { DpapiVault, type SafeStoragePort } from "../../src/main/credentials/vault.js";
import { ProviderCredentialVault } from "../../src/main/credentials/provider-credential-vault.js";
import { DesktopProviderCredentialMigrator } from "../../src/main/migration/provider-credential-migration.js";
import { DesktopLegacyDataImporter } from "../../src/main/migration/legacy-data-import.js";

const roots: string[] = [];
const userId = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
const otherUserId = "3657e5a0-275c-4ae6-950f-511646d3f647";

const permissions: ProfilePermissions = {
  secureDirectory: async () => undefined,
  verifyDirectory: async () => undefined,
  secureFile: async () => undefined,
  verifyFile: async () => undefined,
};
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

describe("DesktopLegacyDataImporter", () => {
  it("scans a trusted legacy source, asks confirmation, imports to the account Profile, and preserves the source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-legacy-import-test-"));
    roots.push(root);
    const userProfileDirectory = path.join(root, "user");
    const sourceRoot = path.join(userProfileDirectory, ".caelush");
    const localAppDataDirectory = path.join(root, "local-app-data");
    await mkdir(localAppDataDirectory, { recursive: true });
    const vault = new DpapiVault(path.join(root, "credentials.dpapi"), testStorage, "win32");
    await vault.initialize();
    const credentials = new ProviderCredentialVault(vault);
    const profiles = new ProfileManager({
      localAppDataDirectory,
      platform: "win32",
      permissions,
    });
    const migrator = new DesktopProviderCredentialMigrator({ vault, credentials });
    const importer = new DesktopLegacyDataImporter({
      profileManager: profiles,
      vault,
      credentialMigrator: migrator,
      userProfileDirectory,
      environment: {},
    });
    await Promise.all(
      ["runs", "run", "private-replay-keys"].map((name) =>
        mkdir(path.join(sourceRoot, name), { recursive: true }),
      ),
    );
    const databasePath = path.join(sourceRoot, "caelush.db");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE workspaces(id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO workspaces VALUES (?)").run("workspace-fixture");
    database.exec("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO agent_sessions VALUES (?)").run("session-fixture");
    database.exec("CREATE TABLE agent_runs(id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO agent_runs VALUES (?)").run("run-fixture");
    database.exec("CREATE TABLE agent_messages(id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO agent_messages VALUES (?)").run("message-fixture");
    database.exec("CREATE TABLE agent_events(id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO agent_events VALUES (?)").run("event-fixture");
    database.exec(
      "CREATE TABLE ai_provider_credentials(provider_id TEXT PRIMARY KEY, secret_value TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);",
    );
    database
      .prepare("INSERT INTO ai_provider_credentials VALUES (?, ?, ?, ?)")
      .run("deepseek", "legacy-provider-key-fixture", 1, 1);
    database.close();
    await writeFile(path.join(sourceRoot, "runs", "artifact.fixture"), "legacy-run-file");
    await writeFile(
      path.join(sourceRoot, "private-replay-keys", "master.v1.json"),
      "encrypted-replay-key-fixture",
    );
    const originalHash = await hash(databasePath);

    const scan = await importer.inspect(userId);
    expect(scan.sources).toHaveLength(1);
    const candidate = scan.sources[0];
    if (candidate === undefined) throw new Error("missing scanned source");
    expect(candidate).toMatchObject({
      sourceLabel: "Default Caelush data",
      importable: true,
      workspaces: 1,
      sessions: 1,
      runs: 1,
      messages: 1,
      durableEvents: 1,
      providerCredentials: 1,
      privateReplayFiles: 1,
    });
    expect(JSON.stringify(scan)).not.toContain(sourceRoot);
    expect(JSON.stringify(scan)).not.toContain("legacy-provider-key-fixture");

    await expect(importer.import(otherUserId, candidate.candidateId, true)).rejects.toMatchObject({
      code: "LEGACY_IMPORT_CANDIDATE_EXPIRED",
    });

    await expect(importer.import(userId, candidate.candidateId, false)).rejects.toMatchObject({
      code: "LEGACY_IMPORT_CONFIRMATION_REQUIRED",
    });
    const result = await importer.import(userId, candidate.candidateId, true);
    expect(result).toMatchObject({ state: "COMMITTED", credentialCount: 1 });
    expect(await credentials.resolve(userId, result.profileId, "deepseek")).toBe(
      "legacy-provider-key-fixture",
    );
    const destination = await profiles.selectForUser(userId);
    const imported = new DatabaseSync(destination.databasePath, { readOnly: true });
    expect(imported.prepare("SELECT id FROM agent_sessions").get()).toEqual({
      id: "session-fixture",
    });
    expect(imported.prepare("SELECT id FROM agent_runs").get()).toEqual({ id: "run-fixture" });
    expect(imported.prepare("SELECT id FROM agent_events").get()).toEqual({ id: "event-fixture" });
    expect(imported.prepare("SELECT count(*) AS count FROM ai_provider_credentials").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(imported.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    imported.close();
    expect(await hash(databasePath)).toBe(originalHash);
    await expect(
      readFile(path.join(destination.runsDirectory, "artifact.fixture"), "utf8"),
    ).resolves.toBe("legacy-run-file");
    await expect(
      readFile(
        path.join(destination.rootDirectory, "private-replay-keys", "master.v1.json"),
        "utf8",
      ),
    ).resolves.toBe("encrypted-replay-key-fixture");

    const afterImport = await importer.inspect(userId);
    expect(afterImport.sources[0]).toMatchObject({ importable: false, reason: "TARGET_NOT_EMPTY" });
  });

  it("records an interrupted restore, blocks startup, and resumes idempotently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-legacy-recovery-test-"));
    roots.push(root);
    const userProfileDirectory = path.join(root, "user");
    const sourceRoot = path.join(userProfileDirectory, ".caelush");
    const localAppDataDirectory = path.join(root, "local-app-data");
    await mkdir(localAppDataDirectory, { recursive: true });
    await mkdir(path.join(sourceRoot, "private-replay-keys"), { recursive: true });
    const sourceDatabase = new DatabaseSync(path.join(sourceRoot, "caelush.db"));
    sourceDatabase.exec("CREATE TABLE workspaces(id TEXT PRIMARY KEY);");
    sourceDatabase.prepare("INSERT INTO workspaces VALUES (?)").run("recovery-workspace");
    sourceDatabase.exec("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY);");
    sourceDatabase.prepare("INSERT INTO agent_sessions VALUES (?)").run("recovery-session");
    sourceDatabase.exec(
      "CREATE TABLE ai_provider_credentials(provider_id TEXT PRIMARY KEY, secret_value TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);",
    );
    sourceDatabase
      .prepare("INSERT INTO ai_provider_credentials VALUES (?, ?, ?, ?)")
      .run("deepseek", "recovery-provider-key-fixture", 1, 1);
    sourceDatabase.close();
    await writeFile(
      path.join(sourceRoot, "private-replay-keys", "master.v1.json"),
      "replay-key-fixture",
    );

    const vault = new DpapiVault(path.join(root, "credentials.dpapi"), testStorage, "win32");
    await vault.initialize();
    const credentials = new ProviderCredentialVault(vault);
    const profiles = new ProfileManager({
      localAppDataDirectory,
      platform: "win32",
      permissions,
    });
    const migrator = new DesktopProviderCredentialMigrator({ vault, credentials });
    let interruptOnce = true;
    const importer = new DesktopLegacyDataImporter({
      profileManager: profiles,
      vault,
      credentialMigrator: migrator,
      userProfileDirectory,
      environment: {},
      faultInjector: (point) => {
        if (point === "RESTORE_FILE_PUBLISHED" && interruptOnce) {
          interruptOnce = false;
          throw new Error("simulated process exit");
        }
      },
    });
    const scan = await importer.inspect(userId);
    const candidate = scan.sources[0];
    if (candidate === undefined) throw new Error("missing recovery source");
    await expect(importer.import(userId, candidate.candidateId, true)).rejects.toMatchObject({
      code: "LEGACY_IMPORT_UNAVAILABLE",
    });

    const pending = await importer.inspect(userId);
    expect(pending).toMatchObject({ pendingRecovery: true, recoveryState: "RECOVERY_BLOCKED" });
    const target = await profiles.selectForUser(userId);
    const partial = new DatabaseSync(target.databasePath);
    partial
      .prepare("UPDATE workspaces SET id = ? WHERE id = ?")
      .run("partial-write", "recovery-workspace");
    partial.close();
    await expect(migrator.run(target, userId)).rejects.toMatchObject({
      code: "CREDENTIAL_MIGRATION_REQUIRED",
    });

    const recovered = await importer.resumeImport(userId);
    expect(recovered).toMatchObject({ state: "COMMITTED", credentialCount: 1 });
    expect(await credentials.resolve(userId, target.profileId, "deepseek")).toBe(
      "recovery-provider-key-fixture",
    );
    const restored = new DatabaseSync(target.databasePath, { readOnly: true });
    expect(restored.prepare("SELECT id FROM agent_sessions").get()).toEqual({
      id: "recovery-session",
    });
    expect(restored.prepare("SELECT count(*) AS count FROM ai_provider_credentials").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    restored.close();
    await expect(
      readFile(path.join(target.rootDirectory, "private-replay-keys", "master.v1.json"), "utf8"),
    ).resolves.toBe("replay-key-fixture");
    expect((await importer.inspect(userId)).pendingRecovery).toBe(false);
  });
});

async function hash(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}
