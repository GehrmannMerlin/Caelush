import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountController,
  type AccountAvatarCachePort,
  type CloudAccountPort,
} from "../../src/main/account/controller.js";
import type { AuthResult } from "../../src/main/cloud/schemas.js";
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

describe("account profile operations", () => {
  it("loads the authenticated profile and private avatar without changing AccountView", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-profile-test-"));
    roots.push(root);
    const vault = new DpapiVault(path.join(root, "vault.bin"), storage);
    const avatarBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const profile = {
      displayName: "Private Profile",
      avatarRevision: "revision-1",
      updatedAt: "2026-10-15T12:00:00Z",
    };
    const cloud = {
      register: vi.fn(),
      verifyEmail: vi.fn(),
      resendVerification: vi.fn(),
      login: vi.fn(async (): Promise<AuthResult> => ({
        requestId: "8cdb5a7b-c72a-48f8-af16-8ec4e5fdc604",
        sessionId: "36f7a94b-82ae-4e8d-bc11-cfa4652ae55a",
        account: {
          userId: "11111111-1111-4111-8111-111111111111",
          email: "person@example.test",
          emailVerified: true,
          entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
          createdAt: "2026-01-01T12:00:00Z",
        },
        device: {
          deviceId: "22222222-2222-4222-8222-222222222222",
          label: "Caelush Desktop",
          createdAt: "2026-01-01T12:00:00Z",
          lastSeenAt: "2026-01-01T12:00:00Z",
          revokedAt: null,
          current: true,
        },
        tokens: {
          tokenType: "Bearer",
          accessToken: "a".repeat(32),
          accessExpiresAt: "2030-01-01T12:00:00Z",
          refreshToken: "r".repeat(32),
          refreshExpiresAt: "2030-01-31T12:00:00Z",
          refreshAbsoluteExpiresAt: "2030-04-01T12:00:00Z",
        },
        offlineGrant: null,
      })),
      refresh: vi.fn(),
      logout: vi.fn(),
      forgotPassword: vi.fn(),
      resetPassword: vi.fn(),
      changePassword: vi.fn(),
      listDevices: vi.fn(),
      revokeDevice: vi.fn(),
      getAccountProfile: vi.fn(async () => profile),
      updateAccountProfile: vi.fn(async () => ({
        displayName: "Updated Name",
        avatarRevision: null,
        updatedAt: "2026-10-15T13:00:00Z",
      })),
      getAccountAvatar: vi.fn(async () => avatarBytes),
    } satisfies CloudAccountPort;
    const cacheEntries = new Map<string, Uint8Array>();
    const cache: AccountAvatarCachePort = {
      read: vi.fn(async (userId, revision) => cacheEntries.get(`${userId}:${revision}`) ?? null),
      write: vi.fn(async (userId, revision, bytes) => {
        cacheEntries.set(`${userId}:${revision}`, bytes);
      }),
      clear: vi.fn(async (userId) => {
        for (const key of cacheEntries.keys())
          if (key.startsWith(`${userId}:`)) cacheEntries.delete(key);
      }),
    };
    const controller = new AccountController({
      vault,
      cloud,
      trustedOfflinePublicKeys: {},
      avatarCache: cache,
    });
    await controller.initialize();
    await controller.login(
      { email: "person@example.test", password: "fixture-password" },
      new AbortController().signal,
    );

    const viewed = await controller.getProfile(new AbortController().signal);
    expect(viewed).toMatchObject({
      email: "person@example.test",
      displayName: "Private Profile",
      avatarRevision: "revision-1",
      avatarBytes,
      canEdit: true,
    });
    expect(cloud.getAccountAvatar).toHaveBeenCalledWith(
      "a".repeat(32),
      expect.any(AbortSignal),
      "revision-1",
    );
    expect(controller.getState().account).toMatchObject({ email: "person@example.test" });
    expect(controller.getState().account).not.toHaveProperty("displayName");

    const updated = await controller.updateProfile(
      { displayName: "  New Name  ", removeAvatar: true },
      new AbortController().signal,
    );
    expect(cloud.updateAccountProfile).toHaveBeenCalledWith(
      { displayName: "New Name", removeAvatar: true },
      "a".repeat(32),
      expect.any(AbortSignal),
    );
    expect(updated).toMatchObject({
      displayName: "Updated Name",
      avatarRevision: null,
      canEdit: true,
    });
    expect(cache.clear).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });
});
