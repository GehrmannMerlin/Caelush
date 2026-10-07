import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStandardAgentMessageCodecRegistry, projectionVersionTable } from "@caelush/agent";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";

import { buildDaemonApp } from "../src/index.js";
import { SessionPresentationService } from "../src/services/session-presentation-service.js";

let storage: CaelushStorage | undefined;
let directory: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Session presentation route", () => {
  it("exposes the safe presentation capability and a typed empty feed", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-presentation-route-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const app = buildDaemonApp({
      sessions: storage.sessions,
      runs: storage.runs,
      eventHub: { watch: async function* () {} } as never,
      config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
      info: {
        apiVersion: "v1",
        protocolVersion: 1,
        daemonVersion: "test",
        capabilities: {
          runExecution: true,
          runRecovery: true,
          cancellation: true,
          approvals: true,
          sseReplay: true,
          sessionTurnPresentation: true,
        },
        runtimeKinds: ["local"],
        configuredProviders: [],
        defaultRunConfiguration: {
          runtime: { id: "local", kind: "local" },
          permissionProfile: "READ_ONLY",
          approvalPolicy: "ALWAYS_ASK",
          limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 1_000 },
        },
      },
      presentation: new SessionPresentationService({
        sessions: storage.sessions,
        runs: storage.runs,
        messageRecords: storage.messageRecords,
        codecs: createStandardAgentMessageCodecRegistry(
          projectionVersionTable({ USER: 1, ASSISTANT: 1, TOOL_RESULT: 1 }),
        ),
        toolInvocations: storage.toolInvocations,
        observations: storage.observations,
        eventReader: storage.eventReader,
        toolPresentation: {
          presentInvocation: () => ({ title: "使用工具", summary: "请求使用工具" }),
          presentResult: () => ({ title: "使用工具", summary: "工具结果可用" }),
          presentShellCommand: () => "执行命令",
        },
      }),
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {},
    });
    const sessionId = created.json().id as string;
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/presentation?limit=10`,
      headers: { host: "127.0.0.1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ capabilityVersion: 2, items: [], highWatermark: 0 });

    const info = await app.inject({
      method: "GET",
      url: "/api/v1/info",
      headers: { host: "127.0.0.1" },
    });
    expect(info.statusCode).toBe(200);
    expect(info.json().capabilities.sessionTurnPresentation).toBe(true);
    await app.close();
  });
});
