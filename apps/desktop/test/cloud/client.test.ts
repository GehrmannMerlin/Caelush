import { describe, expect, it, vi } from "vitest";
import { CloudAccountClient, CloudClientError } from "../../src/main/cloud/client.js";

const authResult = {
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
    accessExpiresAt: "2026-01-01T12:15:00Z",
    refreshToken: "r".repeat(32),
    refreshExpiresAt: "2026-01-31T12:00:00Z",
    refreshAbsoluteExpiresAt: "2026-04-01T12:00:00Z",
  },
  offlineGrant: null,
};

describe("Cloud Account Client", () => {
  it("uses the frozen login endpoint and validates the complete Cloud response", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(authResult), { status: 200 }));
    const cloud = new CloudAccountClient("http://127.0.0.1:8000", { fetcher });
    const result = await cloud.login(
      {
        email: "dev@example.test",
        password: "password",
        device: { label: "Caelush Desktop", publicKey: "A".repeat(43) },
      },
      new AbortController().signal,
    );

    expect(result.account.userId).toBe(authResult.account.userId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:8000/v1/auth/login");
    expect((init as RequestInit).redirect).toBe("error");
    expect(new Headers((init as RequestInit).headers).get("content-type")).toBe("application/json");
    expect(String((init as RequestInit).body)).not.toContain("devicePrivateKey");
  });

  it("never retries a refresh token after an ambiguous response loss", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("socket reset with sensitive transport detail");
    });
    const cloud = new CloudAccountClient("http://127.0.0.1:8000", { fetcher });

    await expect(cloud.refresh("r".repeat(32), new AbortController().signal)).rejects.toMatchObject(
      {
        code: "NETWORK_UNAVAILABLE",
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("sensitive transport detail");
  });

  it("uses and validates the remaining frozen account, password, session, and device endpoints", async () => {
    const id = "8cdb5a7b-c72a-48f8-af16-8ec4e5fdc604";
    const accepted = { requestId: id, status: "ACCEPTED" };
    const succeeded = { requestId: id, status: "SUCCEEDED" };
    const devices = { requestId: id, devices: [authResult.device], nextCursor: null };
    const revocation = { requestId: id, deviceId: authResult.device.deviceId, revoked: true };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const body =
        url.pathname.endsWith("/register") ||
        url.pathname.endsWith("/resend-verification") ||
        url.pathname.endsWith("/forgot-password")
          ? accepted
          : url.pathname.endsWith("/logout") ||
              url.pathname.endsWith("/verify-email") ||
              url.pathname.endsWith("/reset-password") ||
              url.pathname.endsWith("/change-password")
            ? succeeded
            : url.pathname.endsWith("/account/me")
              ? { requestId: id, account: authResult.account }
              : url.pathname.endsWith("/account/devices")
                ? devices
                : url.pathname.endsWith(`/account/devices/${authResult.device.deviceId}`)
                  ? revocation
                  : authResult;
      const status =
        url.pathname.endsWith("/register") ||
        url.pathname.endsWith("/resend-verification") ||
        url.pathname.endsWith("/forgot-password")
          ? 202
          : 200;
      return new Response(JSON.stringify(body), { status });
    });
    const cloud = new CloudAccountClient("https://cloud.example.test", { fetcher });
    const signal = new AbortController().signal;

    await cloud.register({ email: "dev@example.test", password: "password" }, signal);
    await cloud.verifyEmail({ verificationToken: "v".repeat(24) }, signal);
    await cloud.resendVerification({ email: "dev@example.test" }, signal);
    await cloud.refresh("r".repeat(32), signal);
    await cloud.logout("a".repeat(32), signal);
    await cloud.forgotPassword({ email: "dev@example.test" }, signal);
    await cloud.resetPassword({ resetToken: "t".repeat(24), newPassword: "new-password" }, signal);
    await cloud.changePassword(
      { currentPassword: "old-password", newPassword: "new-password" },
      "a".repeat(32),
      signal,
    );
    expect(await cloud.getCurrentAccount("a".repeat(32), signal)).toEqual(authResult.account);
    expect(await cloud.listDevices("a".repeat(32), signal)).toEqual(devices);
    expect(await cloud.revokeDevice(authResult.device.deviceId, "a".repeat(32), signal)).toEqual(
      revocation,
    );

    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/v1/auth/register",
      "/v1/auth/verify-email",
      "/v1/auth/resend-verification",
      "/v1/auth/refresh",
      "/v1/auth/logout",
      "/v1/auth/forgot-password",
      "/v1/auth/reset-password",
      "/v1/auth/change-password",
      "/v1/account/me",
      "/v1/account/devices",
      `/v1/account/devices/${authResult.device.deviceId}`,
    ]);
  });

  it("rejects malformed Cloud responses and non-loopback HTTP origins", async () => {
    const malformed = new CloudAccountClient("http://127.0.0.1:8000", {
      fetcher: vi.fn(
        async () => new Response('{"tokens":{"accessToken":"leaked"}}', { status: 200 }),
      ),
    });
    await expect(
      malformed.login(
        {
          email: "dev@example.test",
          password: "password",
          device: { label: "Caelush Desktop", publicKey: "A".repeat(43) },
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(CloudClientError);
    expect(() => new CloudAccountClient("http://192.0.2.1:8000")).toThrow(CloudClientError);
  });
});
