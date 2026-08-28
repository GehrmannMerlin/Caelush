import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";

describe("daemon app factory", () => {
  it("builds an unlistened app from injected dependencies", async () => {
    const app = buildDaemonApp({
      sessions: {} as never,
      runs: {} as never,
      eventBus: {} as never,
      config: {
        host: "127.0.0.1",
        port: 43120,
        sseHeartbeatIntervalMs: 15_000,
      },
    });

    expect(app.server.listening).toBe(false);
    await app.close();
  });

  it("uses the approved exact transport dependency versions", async () => {
    const manifest = JSON.parse(await readFile("apps/daemon/package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies).toMatchObject({
      fastify: "5.12.1",
      "@fastify/sse": "0.6.0",
      "fastify-type-provider-zod": "7.0.0",
    });
    expect(manifest.dependencies).not.toHaveProperty("@fastify/cors");
    expect(manifest.dependencies).not.toHaveProperty("ai");
    expect(manifest.dependencies).not.toHaveProperty("eventsource");
  });
});
