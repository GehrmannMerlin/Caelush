import { describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";

describe("health route", () => {
  it("reports the ready daemon contract without sensitive runtime details", async () => {
    const app = buildDaemonApp({
      sessions: {} as never,
      runs: {} as never,
      eventBus: {} as never,
      config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "127.0.0.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "caelush-daemon",
      status: "ready",
      apiVersion: "v1",
      protocolVersion: 1,
    });
    expect(response.body).not.toContain("databasePath");
    await app.close();
  });
});
