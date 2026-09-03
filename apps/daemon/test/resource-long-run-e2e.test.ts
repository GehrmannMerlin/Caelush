import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@caelush/events";
import { createWorkspaceId } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/app.js";
import { composeDaemon, DEFAULT_ADAPTIVE_RESOURCE_POLICY } from "../src/daemon-composition.js";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let composition: ReturnType<typeof composeDaemon> | undefined;
let app: ReturnType<typeof buildDaemonApp> | undefined;

afterEach(async () => {
  await app?.close().catch(() => undefined);
  await composition?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  app = undefined;
  composition = undefined;
  storage = undefined;
  directory = undefined;
});

describe("daemon adaptive long-run boundary", () => {
  it("creates a Run with the canonical Adaptive policy and no implicit 10-second deadline", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-resource-e2e-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const eventBus = new EventBus(storage.events);
    composition = composeDaemon({
      storage,
      eventBus,
      providers: [
        {
          provider: "openai-compatible",
          baseUrl: "https://provider.example/v1",
          allowedModels: ["fixture-model"],
        },
      ],
    });
    app = buildDaemonApp({
      sessions: storage.sessions,
      runs: storage.runs,
      eventBus,
      config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 0 },
      execution: {
        runs: storage.runs,
        supervisor: composition.supervisor,
        approvals: storage.approvals,
      },
      info: composition.info,
      modelCanonicalizer: composition.modelCanonicalizer,
    });

    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: { metadata: {} },
    });
    expect(session.statusCode).toBe(201);
    const sessionId = session.json().id as string;
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {
        goal: "inspect a large workspace",
        workspace: { id: createWorkspaceId(), path: process.cwd() },
        model: { provider: "openai-compatible", model: "fixture-model" },
        runtime: { id: "local", kind: "local" },
        permissionProfile: "PROJECT_ACCESS",
        approvalPolicy: "DANGEROUS_ONLY",
        resourcePolicy: DEFAULT_ADAPTIVE_RESOURCE_POLICY,
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().resourcePolicy).toEqual(DEFAULT_ADAPTIVE_RESOURCE_POLICY);
    expect(created.json().limits.timeoutMs).toBe(Number.MAX_SAFE_INTEGER);
  });
});
