import { describe, expect, it, vi } from "vitest";
import { buildDaemonApp } from "../src/app.js";

describe("provider usage summary route", () => {
  it("returns bounded aggregates from the read-only usage store", async () => {
    const getSummary = vi.fn(async (since: number) => ({
      allTime: { successfulRequests: 12, totalTokens: 900 },
      since: { successfulRequests: since === 1_000 ? 3 : 0, totalTokens: 150 },
    }));
    const app = buildDaemonApp({
      sessions: {} as never,
      runs: {} as never,
      eventHub: { watch: async function* () {} } as never,
      providerUsage: { getSummary },
      config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/usage/summary?sinceMs=1000",
      headers: { host: "127.0.0.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      allTime: { successfulRequests: 12, totalTokens: 900 },
      since: { successfulRequests: 3, totalTokens: 150 },
    });
    expect(getSummary).toHaveBeenCalledWith(1_000);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/usage/summary?sinceMs=-1",
      headers: { host: "127.0.0.1" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(getSummary).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
