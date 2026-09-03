import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  ClientAgentRun,
  ClientAgentSession,
  DaemonInfo,
  WorkspaceRef,
} from "@caelush/protocol";
import {
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  DaemonInfoSchema,
  createRunId,
  createSessionId,
  createWorkspaceId,
} from "@caelush/protocol";
import type { WebSessionClient } from "../src/application/session-manager.js";
import { WebSessionManager } from "../src/application/session-manager.js";
import { SessionSelectionStore } from "../src/application/session-persistence.js";

describe("WebSessionManager durable recovery", () => {
  it("classifies a single active Run and admits RUNNING only after the stream opens", async () => {
    const run = makeRun({ status: "RUNNING" });
    const client = makeClient(run);
    let open!: () => void;
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      open = () => options?.onOpen?.();
      await new Promise<void>(() => undefined);
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    await manager.loadSessions();
    await expect(manager.selectSession(run.sessionId)).resolves.toBe(true);
    expect(client.recoverRun).not.toHaveBeenCalled();
    await waitFor(() => typeof open === "function");
    open();
    await waitFor(() => client.recoverRun.mock.calls.length === 1);
    expect(client.recoverRun).toHaveBeenCalledWith(run.id);
    manager.dispose();
  });

  it("does not auto-start PENDING or auto-recover a WAITING_APPROVAL Run with a real request", async () => {
    const pending = makeRun({ status: "PENDING" });
    const pendingClient = makeClient(pending);
    const pendingManager = new WebSessionManager({
      client: pendingClient,
      workspace,
      info: makeInfo(),
    });
    await pendingManager.loadSessions();
    await pendingManager.selectSession(pending.sessionId);
    expect(pendingManager.getSnapshot().controlMode).toBe("PENDING_RUN_CONFIRMATION");
    expect(pendingClient.startRun).not.toHaveBeenCalled();
    await expect(pendingManager.confirmPendingRun(pending.id)).resolves.toBe(true);
    expect(pendingClient.startRun).toHaveBeenCalledWith(pending.id);
    pendingManager.dispose();

    const waiting = makeRun({ status: "WAITING_APPROVAL" });
    const waitingClient = makeClient(waiting);
    waitingClient.listPendingApprovals.mockResolvedValue({
      items: [
        {
          id: "apr_00000000-0000-7000-8000-000000000001",
          runId: waiting.id,
          toolInvocationId: "inv_00000000-0000-7000-8000-000000000001",
          riskLevel: "HIGH",
          title: "Approve",
          reason: "Needed",
          action: { toolName: "tool", summary: "do" },
          status: "PENDING",
          scope: "ONCE",
          createdAt: 1,
        } as never,
      ],
    });
    const waitingManager = new WebSessionManager({
      client: waitingClient,
      workspace,
      info: makeInfo(),
    });
    await waitingManager.loadSessions();
    await waitingManager.selectSession(waiting.sessionId);
    expect(waitingManager.getSnapshot().controlMode).toBe("APPROVAL");
    expect(waitingClient.recoverRun).not.toHaveBeenCalled();
    expect(waitingClient.watchRunEvents).toHaveBeenCalledWith(waiting.id, expect.any(Object));
    waitingManager.dispose();
  });

  it("reloads the selected Session and rebuilds Timeline from the durable stream", async () => {
    const run = makeRun({ status: "RUNNING" });
    const store = new SessionSelectionStore(new Map());
    const event = durableReasoning(run, "durable after reload");
    const first = makeClient(run);
    const second = makeClient(run);
    for (const client of [first, second]) {
      client.watchRunEvents.mockImplementation(async function* (_runId, options) {
        options?.onOpen?.();
        yield event;
        await new Promise<void>(() => undefined);
      });
    }
    const managerA = new WebSessionManager({
      client: first,
      workspace,
      info: makeInfo(),
      selectionStore: store,
    });
    await managerA.loadSessions();
    await managerA.selectSession(run.sessionId);
    await waitFor(() => managerA.getSnapshot().timeline.settled.length === 1);
    managerA.dispose();
    const managerB = new WebSessionManager({
      client: second,
      workspace,
      info: makeInfo(),
      selectionStore: store,
    });
    await managerB.loadSessions();
    await waitFor(() => managerB.getSnapshot().timeline.settled.length === 1);
    expect(managerB.getSnapshot().selectedSessionId).toBe(run.sessionId);
    expect(managerB.getSnapshot().timeline.settled).toEqual([
      expect.objectContaining({ kind: "REASONING", text: "durable after reload" }),
    ]);
    managerB.dispose();
  });
});

const workspace: WorkspaceRef = { id: createWorkspaceId(), path: "D:/workspace" };

function makeClient(
  run: ClientAgentRun,
): WebSessionClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listSessions: vi.fn(async () => ({ items: [makeSession(run.sessionId)] })),
    listRuns: vi.fn(async () => ({ items: [run] })),
    getSession: vi.fn(async (session) => session),
    createSession: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(async () => run),
    listPendingApprovals: vi.fn(async () => ({ items: [] })),
    resolveApproval: vi.fn(),
    startRun: vi.fn(async () => ({ disposition: "SCHEDULED", run })),
    recoverRun: vi.fn(async () => ({ disposition: "SCHEDULED", run })),
    cancelRun: vi.fn(),
    watchRunEvents: vi.fn(),
  } as unknown as WebSessionClient & Record<string, ReturnType<typeof vi.fn>>;
}

function makeSession(id: ClientAgentRun["sessionId"]): ClientAgentSession {
  return ClientAgentSessionSchema.parse({
    id,
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
    defaultWorkspace: workspace,
  });
}

function makeRun(overrides: Partial<ClientAgentRun> = {}): ClientAgentRun {
  return ClientAgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "recover",
    status: "PENDING",
    workspace,
    model: { provider: "fixture", model: "fixture" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 1000 },
    createdAt: 1,
    ...overrides,
  });
}

function durableReasoning(run: ClientAgentRun, summary: string): AgentEvent {
  return {
    type: "reasoning.summary",
    eventId: "evt_00000000-0000-7000-8000-000000000001",
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    timestamp: 1,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", sequence: 1 },
    payload: { summary },
  } as AgentEvent;
}

function makeInfo(): DaemonInfo {
  return DaemonInfoSchema.parse({
    apiVersion: "v1",
    protocolVersion: 1,
    daemonVersion: "test",
    capabilities: {
      runExecution: true,
      runRecovery: true,
      cancellation: true,
      approvals: true,
      sseReplay: true,
    },
    runtimeKinds: ["local"],
    configuredProviders: ["fixture"],
    defaultModel: { provider: "fixture", model: "fixture" },
    defaultRunConfiguration: {
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 1000 },
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}
