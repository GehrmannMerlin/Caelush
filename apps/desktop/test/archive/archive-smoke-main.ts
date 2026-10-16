import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, protocol, safeStorage } from "electron";
import { CaelushClient } from "@caelush/client";
import { DpapiVault } from "../../src/main/credentials/vault.js";
import {
  accountVaultKey,
  generateDeviceIdentity,
  writeActiveAccount,
  type StoredAccountRecord,
} from "../../src/main/credentials/device-identity.js";
import { ProviderCredentialVault } from "../../src/main/credentials/provider-credential-vault.js";
import { DesktopProviderCredentialMigrator } from "../../src/main/migration/provider-credential-migration.js";
import { DesktopDaemonSupervisor } from "../../src/main/daemon/supervisor.js";
import {
  resolveDesktopDaemonResources,
  resolveDesktopWebRoot,
} from "../../src/main/daemon/resources.js";
import { DesktopLocalProxy } from "../../src/main/protocol/local-proxy.js";
import { ownedDaemonHeaders } from "../../src/main/protocol/daemon-authorization.js";
import { registerAppProtocol } from "../../src/main/protocol/app-protocol.js";
import { AccountController, type CloudAccountPort } from "../../src/main/account/controller.js";
import { canonicalizeJcs } from "../../src/main/offline/grant.js";
import {
  ProfileManager,
  WindowsProfilePermissions,
} from "../../src/main/profiles/profile-manager.js";
import { registerDesktopIpc } from "../../src/main/ipc/handlers.js";
import { DesktopArchiveController } from "../../src/main/archive/controller.js";
import { createSecureWebPreferences } from "../../src/main/windows/security-policy.js";
import {
  model,
  startModelFixture,
  seedArchiveFixture,
  databaseEvidence,
  verifyWorkspaceReRegistration,
} from "../../../../scripts/archive-smoke-fixture.mjs";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "caelush-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: "caelush-login",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
const root = required("CAELUSH_ARCHIVE_TEST_ROOT");
const desktopRoot = required("CAELUSH_ARCHIVE_APP_ROOT");
const phase = required("CAELUSH_ARCHIVE_PHASE");
app.setPath("userData", path.join(root, "electron-user-data"));
let supervisor: DesktopDaemonSupervisor | undefined;
let window: BrowserWindow | undefined;
let disposeIpc: (() => void) | undefined;
let provider: Awaited<ReturnType<typeof startModelFixture>> | undefined;

app.whenReady().then(async () => {
  try {
    await mkdir(required("LOCALAPPDATA"), { recursive: true });
    provider = await startModelFixture();
    Object.assign(process.env, {
      CAELUSH_PROVIDER_ID: model.provider,
      CAELUSH_PROVIDER_BASE_URL: provider.url,
      CAELUSH_DEFAULT_PROVIDER: model.provider,
      CAELUSH_DEFAULT_MODEL: model.model,
    });
    await mkdir(app.getPath("userData"), { recursive: true });
    const vault = new DpapiVault(path.join(app.getPath("userData"), "credentials.dpapi"), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptStringAsync: (value) => safeStorage.encryptStringAsync(value),
      decryptStringAsync: async (value) =>
        (await safeStorage.decryptStringAsync(Buffer.from(value))).result,
    });
    await vault.initialize();
    const identityFile = path.join(root, "fixture-identity.json");
    if (phase === "first") {
      const keys = generateKeyPairSync("ed25519");
      await writeFile(
        identityFile,
        JSON.stringify({
          userId: randomUUID(),
          deviceId: randomUUID(),
          privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        }),
      );
    }
    const identity = JSON.parse(await readFile(identityFile, "utf8")) as {
      userId: string;
      deviceId: string;
      privateKey: string;
    };
    const signingKey = createPrivateKey(identity.privateKey);
    const trustedRawKey = Buffer.from(
      createPublicKey(signingKey).export({ format: "der", type: "spki" }),
    ).subarray(-32);
    if (phase === "first") {
      const now = new Date().toISOString();
      const device = generateDeviceIdentity();
      const payload = {
        schemaVersion: 1,
        grantId: randomUUID(),
        userId: identity.userId,
        deviceId: identity.deviceId,
        issuedAt: now,
        expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
        keyId: "archive_fixture",
      } as const;
      const record: StoredAccountRecord = {
        schemaVersion: 2,
        normalizedEmail: "archive@example.invalid",
        userId: identity.userId,
        emailVerified: true,
        createdAt: now,
        deviceId: identity.deviceId,
        deviceCreatedAt: now,
        deviceLastSeenAt: now,
        deviceLabel: "Archive isolated fixture",
        devicePrivateKeyPkcs8Base64: device.privateKeyPkcs8Base64,
        devicePublicKeyBase64Url: device.publicKeyBase64Url,
        sessionId: null,
        refreshToken: null,
        rotationUncertain: false,
        offlineGrant: {
          envelopeVersion: 1,
          payload,
          signature: sign(null, Buffer.from(canonicalizeJcs(payload)), signingKey).toString(
            "base64url",
          ),
        },
        lastTrustedServerTime: now,
        lastAcceptedTime: now,
        entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
        accountEmail: "archive@example.invalid",
        displayName: "归档验收",
        avatarRevision: null,
        profileUpdatedAt: now,
      };
      const key = accountVaultKey(record.normalizedEmail);
      await vault.set(key, record);
      await writeActiveAccount(vault, key);
    }
    const account = new AccountController({
      vault,
      cloud: {} as CloudAccountPort,
      trustedOfflinePublicKeys: { archive_fixture: trustedRawKey },
    });
    await account.initialize();
    assert.equal(account.getState().status, "AUTHORIZED_OFFLINE");
    const credentialVault = new ProviderCredentialVault(vault);
    supervisor = new DesktopDaemonSupervisor({
      profileManager: new ProfileManager({
        localAppDataDirectory: required("LOCALAPPDATA"),
        platform: "win32",
        permissions: new WindowsProfilePermissions("win32", process.env),
      }),
      credentialVault,
      credentialMigrator: new DesktopProviderCredentialMigrator({ vault: credentialVault }),
      resolveResources: () =>
        resolveDesktopDaemonResources({
          packaged: false,
          appPath: desktopRoot,
          resourcesPath: process.resourcesPath,
        }),
      productVersion: "0.1.0",
      processEnvironment: process.env,
    });
    await supervisor.synchronizeAccountState(account.getState());
    const profile = supervisor.getActiveProfileIdentity();
    assert.ok(profile, "Production supervisor must own a daemon profile");
    const lease = supervisor.acquireProxyLease(new AbortController().signal);
    assert.ok(lease);
    const headers = ownedDaemonHeaders(lease);
    assert.ok(headers);
    const client = new CaelushClient({ baseUrl: lease.baseUrl, headers });
    const manifestFile = path.join(root, "archive-fixture.json");
    let fixture: Awaited<ReturnType<typeof seedArchiveFixture>>;
    try {
      if (phase === "first") {
        await client.connectAIProvider(model.provider, { apiKey: "archive-loopback-fixture-key" });
        const projects = JSON.parse(
          await readFile(path.join(root, "projects.json"), "utf8"),
        ) as string[];
        fixture = await seedArchiveFixture(client, projects);
        await writeFile(
          manifestFile,
          JSON.stringify({
            fixture,
            databasePath: profile.profile.databasePath,
            beforeDatabase: databaseEvidence(profile.profile.databasePath, fixture),
          }),
        );
      } else {
        const stored = JSON.parse(await readFile(manifestFile, "utf8"));
        fixture = stored.fixture;
        await assert.rejects(
          client.getSession(fixture.alpha.sessionId),
          (error: { code?: string }) => error.code === "NOT_FOUND",
        );
        assert.equal((await client.listArchivedSessions({ query: "%_" })).matchedCount, 0);
        const state = await client.getArchiveState({
          type: "SESSION",
          sessionId: fixture.independentId,
        });
        assert.equal(state.archived, true);
        const beforeRestart = JSON.parse(
          await readFile(path.join(root, "before-restart.json"), "utf8"),
        );
        assert.deepEqual(state, beforeRestart);
      }
    } finally {
      lease.release();
    }

    const proxy = new DesktopLocalProxy({
      acquireLease: (signal) => supervisor!.acquireProxyLease(signal),
    });
    registerAppProtocol({
      rendererRoot: path.join(desktopRoot, "dist/renderer"),
      agentRoot: resolveDesktopWebRoot({
        packaged: false,
        appPath: desktopRoot,
        resourcesPath: process.resourcesPath,
      }),
      localProxy: proxy,
      isAgentAvailable: () => supervisor!.getAgentEntry(account.getState()).available,
    });
    window = new BrowserWindow({
      show: false,
      width: 1600,
      height: 1000,
      minWidth: 780,
      minHeight: 640,
      webPreferences: {
        ...createSecureWebPreferences(path.join(desktopRoot, "dist/preload/index.cjs"), false),
        backgroundThrottling: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    disposeIpc = registerDesktopIpc({
      window,
      controller: account,
      rendererTrust: { developmentOrigin: null, allowLoginIpc: true },
      platform: process.platform,
      arch: process.arch,
      version: "0.1.0",
      projectAccountState: (state) => ({ ...state, agentEntry: supervisor!.getAgentEntry(state) }),
      archiveController: new DesktopArchiveController({
        supervisor,
        getAuthorizedUserId: () => account.getState().account?.userId ?? null,
      }),
    });
    const control = {
      ready: true,
      phase,
      fixture,
      evidence: () => databaseEvidence(profile.profile.databasePath, fixture),
      async verifyWorkspaceReRegistration() {
        const lease = supervisor!.acquireProxyLease(new AbortController().signal);
        assert.ok(lease);
        const headers = ownedDaemonHeaders(lease);
        assert.ok(headers);
        try {
          await verifyWorkspaceReRegistration(
            new CaelushClient({ baseUrl: lease.baseUrl, headers }),
            fixture,
          );
        } finally {
          lease.release();
        }
      },
      async saveRestartState() {
        const state = await new DesktopArchiveController({ supervisor: supervisor! }).getState(
          { type: "SESSION", sessionId: fixture.independentId },
          new AbortController().signal,
        );
        await writeFile(path.join(root, "before-restart.json"), JSON.stringify(state));
      },
      async shutdown() {
        const exitCode = await supervisor!.closeForApplicationQuit();
        assert.ok(exitCode === 0 || exitCode === null, "Real child daemon must close gracefully");
        disposeIpc?.();
        await provider?.close();
        return { closed: true };
      },
    };
    Object.assign(globalThis, { archiveSmoke: control });
    await window.loadURL(
      `caelush-login://app/?view=account${phase === "restart" ? "&section=archives" : ""}`,
    );
  } catch (error) {
    process.stderr.write(
      `ARCHIVE_MAIN_FAIL ${error instanceof Error ? error.stack : "Unknown fixture failure"}\n`,
    );
    await supervisor?.closeForApplicationQuit().catch(() => undefined);
    await provider?.close();
    app.exit(1);
  }
});

function required(key: string): string {
  const value = process.env[key];
  if (!value || (!path.isAbsolute(value) && key !== "CAELUSH_ARCHIVE_PHASE"))
    throw new Error(`Missing fixture setting ${key}`);
  return value;
}
