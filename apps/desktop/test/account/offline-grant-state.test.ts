import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountController, type CloudAccountPort } from "../../src/main/account/controller.js";
import { AccountStateSchema, type AccountState } from "../../src/main/account/state.js";
import { CloudClientError } from "../../src/main/cloud/client.js";
import type { AuthResult } from "../../src/main/cloud/schemas.js";
import {
  getOrCreateDeviceIdentity,
  type StoredAccountRecord,
} from "../../src/main/credentials/device-identity.js";
import { DpapiVault, type SafeStoragePort } from "../../src/main/credentials/vault.js";
import { IPC_CHANNELS, registerDesktopIpc } from "../../src/main/ipc/handlers.js";
import { canonicalizeJcs } from "../../src/main/offline/grant.js";

const HOUR_MS = 60 * 60 * 1000;
const issuedAt = Date.parse("2026-10-27T08:00:00.000Z");
const roots: string[] = [];
const storage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`),
  decryptStringAsync: async (value) =>
    Buffer.from(value).toString("utf8").slice("encrypted:".length),
};

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(skewMs = 300, lifetimeMs = 360 * HOUR_MS) {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-grant-state-"));
  roots.push(root);
  const vaultPath = path.join(root, "vault.bin");
  const vault = new DpapiVault(vaultPath, storage);
  const signer = generateKeyPairSync("ed25519");
  const trustedOfflinePublicKeys = {
    fixture: signer.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  };
  let serverTime = issuedAt;
  let localTime = issuedAt - skewMs;
  const auth = (): AuthResult => {
    const payload = {
      schemaVersion: 1 as const,
      grantId: "44444444-4444-4444-8444-444444444444",
      userId: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
      issuedAt: new Date(serverTime).toISOString(),
      expiresAt: new Date(serverTime + lifetimeMs).toISOString(),
      entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
      keyId: "fixture",
    };
    return {
      requestId: "88888888-8888-4888-8888-888888888888",
      sessionId: "33333333-3333-4333-8333-333333333333",
      account: {
        userId: payload.userId,
        email: "person@example.test",
        emailVerified: true,
        entitlements: payload.entitlements,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      device: {
        deviceId: payload.deviceId,
        label: "Caelush Desktop",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: payload.issuedAt,
        revokedAt: null,
        current: true,
      },
      tokens: {
        tokenType: "Bearer",
        accessToken: "a".repeat(32),
        accessExpiresAt: new Date(serverTime + 15 * 60_000).toISOString(),
        refreshToken: "r".repeat(32),
        refreshExpiresAt: new Date(serverTime + 30 * 24 * HOUR_MS).toISOString(),
        refreshAbsoluteExpiresAt: new Date(serverTime + 90 * 24 * HOUR_MS).toISOString(),
      },
      offlineGrant: {
        envelopeVersion: 1,
        payload,
        signature: sign(null, Buffer.from(canonicalizeJcs(payload)), signer.privateKey).toString(
          "base64url",
        ),
      },
    };
  };
  const cloud = {
    login: vi.fn(async () => auth()),
    refresh: vi.fn(async () => auth()),
  } as Pick<CloudAccountPort, "login" | "refresh"> as CloudAccountPort;
  const options = { cloud, trustedOfflinePublicKeys, now: () => new Date(localTime) };
  const controller = new AccountController({ ...options, vault });
  await controller.initialize();
  const { accountKey, record } = await getOrCreateDeviceIdentity(vault, "person@example.test");
  await vault.set(accountKey, {
    ...record,
    lastTrustedServerTime: new Date(issuedAt - HOUR_MS).toISOString(),
    lastAcceptedTime: new Date(issuedAt - HOUR_MS).toISOString(),
  } satisfies StoredAccountRecord);
  return {
    controller,
    vault,
    accountKey,
    cloud,
    login: () =>
      controller.login(
        { email: "person@example.test", password: "fixture-password" },
        new AbortController().signal,
      ),
    advance(ms: number) {
      serverTime += ms;
      localTime += ms;
    },
    recover: () => new AccountController({ ...options, vault: new DpapiVault(vaultPath, storage) }),
  };
}

describe("offline grant account-state projection", () => {
  it.each([1, 300, 5 * 60_000])(
    "keeps login state valid when the local clock is %i ms behind signed issue time",
    async (skewMs) => {
      const test = await fixture(skewMs);
      await test.login();
      const state = test.controller.getState();
      expect(state.status).toBe("AUTHENTICATED_ONLINE");
      expect(state.offlineGrant?.remainingHours).toBe(360);
      expect(AccountStateSchema.safeParse(state).success).toBe(true);
      const stored = (await test.vault.get(test.accountKey)) as StoredAccountRecord;
      expect(stored.offlineGrant).toEqual(
        (await vi.mocked(test.cloud.login).mock.results[0]?.value)?.offlineGrant,
      );
      expect(stored.lastAcceptedTime).toBe(new Date(issuedAt - skewMs).toISOString());
    },
  );

  it("bounds the display by a shorter signed lifetime", async () => {
    const test = await fixture(300, 6 * HOUR_MS);
    await test.login();
    expect(test.controller.getState().offlineGrant?.remainingHours).toBe(6);
  });

  it("keeps a refreshed grant valid for immediate IPC reads", async () => {
    const test = await fixture();
    await test.login();
    test.advance(14 * 60_000);
    await test.controller.refreshNow(new AbortController().signal);
    expect(test.controller.getState().offlineGrant?.remainingHours).toBe(360);
    expect(AccountStateSchema.safeParse(test.controller.getState()).success).toBe(true);
  });

  it("keeps offline recovery state valid within the permitted issue-time skew", async () => {
    const test = await fixture();
    await test.login();
    vi.mocked(test.cloud.refresh).mockRejectedValue(
      new CloudClientError("NETWORK_UNAVAILABLE", "Cloud is currently unreachable.", true),
    );
    const recovered = test.recover();
    await recovered.initialize();
    expect(recovered.getState().status).toBe("AUTHORIZED_OFFLINE");
    expect(recovered.getState().offlineGrant?.remainingHours).toBe(360);
    expect(AccountStateSchema.safeParse(recovered.getState()).success).toBe(true);
  });

  it("still discards a grant beyond the allowed future-issue tolerance", async () => {
    const test = await fixture(5 * 60_000 + 1);
    await test.login();
    expect(test.controller.getState().status).toBe("AUTHENTICATED_ONLINE");
    expect(test.controller.getState().offlineGrant).toBeNull();
    expect(test.controller.getState().notice).toContain("could not be verified");
  });

  it("still refuses expired authorization during offline recovery", async () => {
    const test = await fixture();
    await test.login();
    test.advance(360 * HOUR_MS + 301);
    vi.mocked(test.cloud.refresh).mockRejectedValue(
      new CloudClientError("NETWORK_UNAVAILABLE", "Cloud is currently unreachable.", true),
    );
    const recovered = test.recover();
    await recovered.initialize();
    expect(recovered.getState().status).toBe("OFFLINE_GRANT_EXPIRED");
    expect(recovered.getState().offlineGrant).toBeNull();
  });

  it("delivers authenticated state and a successful read immediately after IPC login", async () => {
    const test = await fixture();
    const handlers = new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>();
    const frame = { url: "caelush-login://app/" };
    const sender = {
      mainFrame: frame,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const dispose = registerDesktopIpc({
      ipcMain: {
        handle: (channel: string, handler: (event: unknown, input?: unknown) => Promise<unknown>) =>
          handlers.set(channel, handler),
        removeHandler: (channel: string) => handlers.delete(channel),
      } as never,
      window: { webContents: sender, isDestroyed: () => false } as never,
      controller: test.controller,
      rendererTrust: { developmentOrigin: null, allowLoginIpc: false },
      platform: "win32",
      arch: "x64",
      version: "0.1.0",
    });
    try {
      const event = { sender, senderFrame: frame };
      expect(
        await handlers.get(IPC_CHANNELS.account.login)!(event, {
          email: "person@example.test",
          password: "fixture-password",
        }),
      ).toMatchObject({ ok: true });
      expect(await handlers.get(IPC_CHANNELS.account.getState)!(event)).toMatchObject({
        ok: true,
        value: { status: "AUTHENTICATED_ONLINE", offlineGrant: { remainingHours: 360 } },
      });
      const published = sender.send.mock.calls.map((call) => call[1] as AccountState);
      expect(published.some((state) => state.status === "AUTHENTICATED_ONLINE")).toBe(true);
    } finally {
      dispose();
    }
  });
});
