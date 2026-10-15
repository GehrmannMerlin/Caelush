import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountController, type CloudAccountPort } from "../../src/main/account/controller.js";
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
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("online account refresh", () => {
  it("rotates the token before expiry without withdrawing the active Agent authorization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
    const root = await mkdtemp(path.join(tmpdir(), "caelush-online-refresh-"));
    roots.push(root);
    const vault = new DpapiVault(path.join(root, "vault.bin"), storage);
    const auth = (accessExpiresAt: string, refreshToken: string): AuthResult => ({
      requestId: "8cdb5a7b-c72a-48f8-af16-8ec4e5fdc604",
      sessionId: "36f7a94b-82ae-4e8d-bc11-cfa4652ae55a",
      account: {
        userId: "11111111-1111-4111-8111-111111111111",
        email: "dev@example.test",
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
        accessExpiresAt,
        refreshToken,
        refreshExpiresAt: "2026-11-13T12:00:00Z",
        refreshAbsoluteExpiresAt: "2027-01-12T12:00:00Z",
      },
      offlineGrant: null,
    });
    const refresh = vi.fn<CloudAccountPort["refresh"]>(async () =>
      auth("2026-10-14T12:29:00.000Z", "n".repeat(32)),
    );
    const cloud = {
      register: vi.fn(),
      verifyEmail: vi.fn(),
      resendVerification: vi.fn(),
      login: vi.fn(async () => auth("2026-10-14T12:15:00.000Z", "o".repeat(32))),
      refresh,
      logout: vi.fn(),
      forgotPassword: vi.fn(),
      resetPassword: vi.fn(),
      changePassword: vi.fn(),
      listDevices: vi.fn(),
      revokeDevice: vi.fn(),
      getAccountProfile: vi.fn(),
      updateAccountProfile: vi.fn(),
      getAccountAvatar: vi.fn(),
    } satisfies CloudAccountPort;
    const controller = new AccountController({ vault, cloud, trustedOfflinePublicKeys: {} });
    await controller.initialize();
    const statuses: string[] = [];
    controller.subscribe((state) => statuses.push(state.status));
    await controller.login(
      { email: "dev@example.test", password: "fixture-password" },
      new AbortController().signal,
    );
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await vi.waitFor(() =>
      expect(controller.getOnlineSessionExpiresAt()?.toISOString()).toBe(
        "2026-10-14T12:29:00.000Z",
      ),
    );

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0]?.[0]).toBe("o".repeat(32));
    expect(controller.getState().status).toBe("AUTHENTICATED_ONLINE");
    expect(controller.getOnlineSessionExpiresAt()?.toISOString()).toBe("2026-10-14T12:29:00.000Z");
    expect(statuses.slice(1)).not.toContain("REFRESHING");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledOnce();
    await controller.logout(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
