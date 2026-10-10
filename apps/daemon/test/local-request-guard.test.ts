import { describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";

function makeApp(desktopHostToken?: string) {
  return buildDaemonApp({
    sessions: {} as never,
    runs: {} as never,
    eventHub: { watch: async function* () {} } as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
    ...(desktopHostToken === undefined
      ? {}
      : {
          desktopHost: {
            profileId: `u_${"a".repeat(64)}`,
            generationId: "generation-a",
            hostToken: desktopHostToken,
          },
        }),
  });
}

describe("local request guards", () => {
  it.each(["127.0.0.1:43120", "localhost:43120", "[::1]:43120"])(
    "accepts loopback Host %s",
    async (host) => {
      const app = makeApp();
      const response = await app.inject({ method: "GET", url: "/unknown", headers: { host } });
      expect(response.statusCode).toBe(404);
      await app.close();
    },
  );

  it("rejects a non-loopback Host with 403", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/unknown",
      headers: { host: "attacker.example.com" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("allows no Origin and loopback Origins but rejects a public Origin", async () => {
    const allowed = [
      undefined,
      "http://127.0.0.1:43120",
      "http://localhost:43120",
      "http://[::1]:43120",
    ];
    for (const origin of allowed) {
      const app = makeApp();
      const response = await app.inject({
        method: "GET",
        url: "/unknown",
        headers: origin === undefined ? { host: "127.0.0.1" } : { host: "127.0.0.1", origin },
      });
      expect(response.statusCode, origin).toBe(404);
      await app.close();
    }

    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/unknown",
      headers: { host: "127.0.0.1", origin: "https://attacker.example.com" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("requires the generation Host Token on every Desktop API request", async () => {
    const currentToken = "A".repeat(43);
    const app = makeApp(currentToken);
    for (const token of [undefined, "B".repeat(43)]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/health",
        headers: {
          host: "127.0.0.1:43120",
          ...(token === undefined ? {} : { "x-caelush-host-token": token }),
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(currentToken);
    }

    const accepted = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: {
        host: "127.0.0.1:43120",
        origin: "http://127.0.0.1:43120",
        "x-caelush-host-token": currentToken,
      },
    });
    expect(accepted.statusCode).toBe(200);

    const invalidHost = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "attacker.example", "x-caelush-host-token": currentToken },
    });
    expect(invalidHost.statusCode).toBe(403);

    const invalidOrigin = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: {
        host: "127.0.0.1:43120",
        origin: "https://attacker.example",
        "x-caelush-host-token": currentToken,
      },
    });
    expect(invalidOrigin.statusCode).toBe(403);
    await app.close();
  });

  it("keeps ordinary Daemon compatibility without a Desktop Host Token", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "127.0.0.1:43120" },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it.each(["/%61pi/v1/health", "/%2561pi/v1/health", "/%25252561pi/v1/health"])(
    "does not allow encoded API path %s to bypass Desktop Host Token validation",
    async (url) => {
      const app = makeApp("A".repeat(43));
      const response = await app.inject({
        method: "GET",
        url,
        headers: { host: "127.0.0.1:43120" },
      });
      expect(response.statusCode).toBe(403);
      await app.close();
    },
  );
});
