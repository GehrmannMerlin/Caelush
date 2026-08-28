import { describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";

function makeApp() {
  return buildDaemonApp({
    sessions: {} as never,
    runs: {} as never,
    eventBus: {} as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
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
});
