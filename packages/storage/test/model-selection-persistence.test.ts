import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRunSchema,
  AgentSessionSchema,
  createRunId,
  createSessionId,
  createWorkspaceId,
  type AgentRun,
  type AgentSession,
} from "@caelush/protocol";
import { openCaelushStorage } from "../src/index.js";
import { makeSecurityPolicy } from "./support/fixtures.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((storage) => storage.close()));
});

describe("durable model and reasoning selection", () => {
  it("persists Session defaults and Run snapshots while accepting old optional fields", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const sessionId = createSessionId();
    const now = Date.now();
    const session: AgentSession = AgentSessionSchema.parse({
      id: sessionId,
      defaultModel: { provider: "deepseek", model: "deepseek-reasoner" },
      defaultReasoningLevel: "HIGH",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    });
    await storage.sessions.insert(session);
    await expect(storage.sessions.get(sessionId)).resolves.toMatchObject({
      defaultModel: { provider: "deepseek", model: "deepseek-reasoner" },
      defaultReasoningLevel: "HIGH",
    });

    const run: AgentRun = AgentRunSchema.parse({
      id: createRunId(),
      sessionId,
      goal: "selection persistence",
      status: "PENDING",
      workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
      model: { provider: "deepseek", model: "deepseek-reasoner" },
      reasoningLevel: "XHIGH",
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      securityPolicy: makeSecurityPolicy("PROJECT_ACCESS", "ON_BOUNDARY"),
      limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 5_000 },
      createdAt: now,
    });
    await storage.runs.insert(run);
    await expect(storage.runs.get(run.id)).resolves.toMatchObject({
      model: { provider: "deepseek", model: "deepseek-reasoner" },
      reasoningLevel: "XHIGH",
    });

    const oldSession: AgentSession = AgentSessionSchema.parse({
      id: createSessionId(),
      createdAt: now,
      updatedAt: now,
      metadata: {},
    });
    await storage.sessions.insert(oldSession);
    await expect(storage.sessions.get(oldSession.id)).resolves.not.toHaveProperty(
      "defaultReasoningLevel",
    );

    const oldRun: AgentRun = AgentRunSchema.parse({
      id: createRunId(),
      sessionId: oldSession.id,
      goal: "old record",
      status: "PENDING",
      workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
      model: { provider: "deepseek", model: "deepseek-chat" },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      securityPolicy: makeSecurityPolicy("PROJECT_ACCESS", "ON_BOUNDARY"),
      limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 5_000 },
      createdAt: now,
    });
    await storage.runs.insert(oldRun);
    await expect(storage.runs.get(oldRun.id)).resolves.not.toHaveProperty("reasoningLevel");
  });
});
