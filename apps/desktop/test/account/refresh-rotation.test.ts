import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountController, type CloudAccountPort } from "../../src/main/account/controller.js";
import { CloudClientError } from "../../src/main/cloud/client.js";
import {
  ACTIVE_ACCOUNT_INDEX_KEY,
  getOrCreateDeviceIdentity,
  writeActiveAccount,
  type StoredAccountRecord,
} from "../../src/main/credentials/device-identity.js";
import { DpapiVault, type SafeStoragePort } from "../../src/main/credentials/vault.js";

const roots: string[] = [];
const storage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`),
  decryptStringAsync: async (value) =>
    Buffer.from(value).toString("utf8").slice("encrypted:".length),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("refresh rotation recovery", () => {
  it("forgets an uncertain old token before requesting refresh and never replays it after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-refresh-test-"));
    roots.push(root);
    const vault = new DpapiVault(path.join(root, "vault.bin"), storage);
    await vault.initialize();
    const { accountKey, record } = await getOrCreateDeviceIdentity(vault, "person@example.test");
    const stored: StoredAccountRecord = {
      ...record,
      userId: "11111111-1111-4111-8111-111111111111",
      emailVerified: true,
      createdAt: "2026-01-01T12:00:00Z",
      deviceId: "22222222-2222-4222-8222-222222222222",
      deviceCreatedAt: "2026-01-01T12:00:00Z",
      deviceLastSeenAt: "2026-01-01T12:00:00Z",
      sessionId: "33333333-3333-4333-8333-333333333333",
      refreshToken: "old-refresh-token-which-must-not-be-replayed",
      offlineGrant: null,
      entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
    };
    await vault.set(accountKey, stored);
    await writeActiveAccount(vault, accountKey);
    const refresh = vi.fn(async () => {
      throw new CloudClientError(
        "NETWORK_TIMEOUT",
        "Cloud did not respond before the request timed out.",
        true,
      );
    });
    const cloud = {
      register: vi.fn(),
      verifyEmail: vi.fn(),
      resendVerification: vi.fn(),
      login: vi.fn(),
      refresh,
      logout: vi.fn(),
      forgotPassword: vi.fn(),
      resetPassword: vi.fn(),
      changePassword: vi.fn(),
      listDevices: vi.fn(),
      revokeDevice: vi.fn(),
    } satisfies CloudAccountPort;
    const controller = new AccountController({ vault, cloud, trustedOfflinePublicKeys: {} });
    await controller.initialize();

    const afterTimeout = (await vault.get(accountKey)) as StoredAccountRecord;
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(afterTimeout.refreshToken).toBeNull();
    expect(afterTimeout.rotationUncertain).toBe(true);
    expect(controller.getState().status).toBe("SESSION_EXPIRED");
    expect(JSON.stringify(controller.getState())).not.toContain("old-refresh-token");
    expect(JSON.stringify(controller.getState())).not.toContain("devicePrivateKeyPkcs8Base64");

    const relaunched = new AccountController({ vault, cloud, trustedOfflinePublicKeys: {} });
    await relaunched.initialize();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(relaunched.getState().status).toBe("SESSION_EXPIRED");
    expect(await vault.get(ACTIVE_ACCOUNT_INDEX_KEY)).toEqual({ accountKey });
  });
});
