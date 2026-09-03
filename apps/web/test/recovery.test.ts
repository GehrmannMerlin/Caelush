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
import type { Timer, TimerHandle } from "@caelush/client";
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

  it("fails closed when a WAITING_APPROVAL approval query fails", async () => {
    const waiting = makeRun({ status: "WAITING_APPROVAL" });
    const waitingClient = makeClient(waiting);
    waitingClient.listPendingApprovals.mockRejectedValueOnce(new Error("offline"));
    let open!: () => void;
    waitingClient.watchRunEvents.mockImplementation(async function* (_runId, options) {
      open = () => options?.onOpen?.();
      await new Promise<void>(() => undefined);
    });
    const waitingManager = new WebSessionManager({
      client: waitingClient,
      workspace,
      info: makeInfo(),
    });

    await waitingManager.loadSessions();
    await waitingManager.selectSession(waiting.sessionId);
    expect(waitingManager.getSnapshot()).toMatchObject({
      error: { code: "RUN_REFRESH_FAILED" },
    });
    await waitFor(() => typeof open === "function");
    open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waitingClient.recoverRun).not.toHaveBeenCalled();
    waitingManager.dispose();
  });

  it("revokes delayed recovery and its reconnect generations when a pending approval appears", async () => {
    const waiting = makeRun({ status: "WAITING_APPROVAL" });
    const timer = new FakeTimer();
    const waitingClient = makeClient(waiting);
    const opens: (() => void)[] = [];
    waitingClient.listPendingApprovals.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({
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
    waitingClient.watchRunEvents.mockImplementation(async function* (_runId, options) {
      opens.push(() => options?.onOpen?.());
      if (opens.length === 1) throw new Error("offline");
      await new Promise<void>(() => undefined);
    });
    const waitingManager = new WebSessionManager({
      client: waitingClient,
      workspace,
      info: makeInfo(),
      timer,
    });

    await waitingManager.loadSessions();
    await waitingManager.selectSession(waiting.sessionId);
    await waitFor(() => opens.length === 1);
    await waitFor(() => timer.delays.length === 1);

    await expect(waitingManager.prepareRecoveryRun(waiting)).resolves.toBe(true);
    expect(waitingManager.getSnapshot().controlMode).toBe("APPROVAL");

    opens[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waitingClient.recoverRun).not.toHaveBeenCalled();

    timer.fireNext();
    await waitFor(() => opens.length === 2);
    opens[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waitingClient.recoverRun).not.toHaveBeenCalled();
    expect(waitingManager.getSnapshot().controlMode).toBe("APPROVAL");
    waitingManager.dispose();
  });

  it("revokes an earlier empty-approval recovery admission when a later query fails", async () => {
    const waiting = makeRun({ status: "WAITING_APPROVAL" });
    const waitingClient = makeClient(waiting);
    let open!: () => void;
    waitingClient.watchRunEvents.mockImplementation(async function* (_runId, options) {
      open = () => options?.onOpen?.();
      await new Promise<void>(() => undefined);
    });
    const waitingManager = new WebSessionManager({
      client: waitingClient,
      workspace,
      info: makeInfo(),
    });

    await waitingManager.loadSessions();
    await waitingManager.selectSession(waiting.sessionId);
    await waitFor(() => typeof open === "function");

    waitingClient.listPendingApprovals.mockRejectedValueOnce(new Error("offline"));
    await expect(waitingManager.prepareRecoveryRun(waiting)).resolves.toBe(true);

    open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waitingClient.recoverRun).not.toHaveBeenCalled();
    waitingManager.dispose();
  });

  it("rebinds a non-recovery stream when a later empty approval query succeeds", async () => {
    const waiting = makeRun({ status: "WAITING_APPROVAL" });
    const waitingClient = makeClient(waiting);
    const opens: (() => void)[] = [];
    waitingClient.listPendingApprovals
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ items: [] });
    waitingClient.watchRunEvents.mockImplementation(async function* (_runId, options) {
      opens.push(() => options?.onOpen?.());
      await new Promise<void>(() => undefined);
    });
    const waitingManager = new WebSessionManager({
      client: waitingClient,
      workspace,
      info: makeInfo(),
    });

    await waitingManager.loadSessions();
    await waitingManager.selectSession(waiting.sessionId);
    await waitFor(() => opens.length === 1);
    opens[0]?.();
    await waitingManager.prepareRecoveryRun(waiting);

    expect(waitingClient.recoverRun).not.toHaveBeenCalled();
    expect(waitingClient.watchRunEvents).toHaveBeenCalledTimes(2);
    await waitFor(() => opens.length === 2);
    opens[1]?.();
    await waitFor(() => waitingClient.recoverRun.mock.calls.length === 1);
    expect(waitingClient.recoverRun).toHaveBeenCalledWith(waiting.id);
    waitingManager.dispose();
  });

  it("rebinds after a revoked reconnect generation opens and a later query succeeds", async () => {
    const waiting = makeRun({ status: "WAITING_APPROVAL" });
    const timer = new FakeTimer();
    const waitingClient = makeClient(waiting);
    const opens: (() => void)[] = [];
    waitingClient.listPendingApprovals
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ items: [] });
    waitingClient.watchRunEvents.mockImplementation(async function* (_runId, options) {
      opens.push(() => options?.onOpen?.());
      if (opens.length === 1) throw new Error("offline");
      await new Promise<void>(() => undefined);
    });
    const waitingManager = new WebSessionManager({
      client: waitingClient,
      workspace,
      info: makeInfo(),
      timer,
    });

    await waitingManager.loadSessions();
    await waitingManager.selectSession(waiting.sessionId);
    await waitFor(() => opens.length === 1);
    await waitFor(() => timer.delays.length === 1);
    timer.fireNext();
    await waitFor(() => opens.length === 2);
    opens[1]?.();
    await waitingManager.prepareRecoveryRun(waiting);

    expect(waitingClient.recoverRun).toHaveBeenCalledTimes(0);
    expect(waitingClient.watchRunEvents).toHaveBeenCalledTimes(3);
    await waitFor(() => opens.length === 3);
    opens[2]?.();
    await waitFor(() => waitingClient.recoverRun.mock.calls.length === 1);
    expect(waitingClient.recoverRun).toHaveBeenCalledWith(waiting.id);
    waitingManager.dispose();
  });

  it("persists selection by WorkspaceId across path changes and isolates same-path workspaces", async () => {
    const sessionId = createSessionId();
    const workspaceA: WorkspaceRef = { id: createWorkspaceId(), path: "D:/workspace" };
    const workspaceB: WorkspaceRef = { id: createWorkspaceId(), path: "D:/workspace" };
    const changedPath: WorkspaceRef = { id: workspaceA.id, path: "D:/workspace-alias" };
    const store = new SessionSelectionStore(new Map());
    const sessionA = makeSession(sessionId, workspaceA);
    const sessionChangedPath = makeSession(sessionId, changedPath);

    const clientA = makeClient(makeRun({ sessionId, workspace: workspaceA }), sessionA);
    const managerA = new WebSessionManager({
      client: clientA,
      workspace: workspaceA,
      info: makeInfo(),
      selectionStore: store,
    });
    await managerA.loadSessions();
    await managerA.selectSession(sessionId);
    managerA.dispose();

    const clientB = makeClient(makeRun({ sessionId, workspace: workspaceB }), sessionA);
    const managerB = new WebSessionManager({
      client: clientB,
      workspace: workspaceB,
      info: makeInfo(),
      selectionStore: store,
    });
    await managerB.loadSessions();
    expect(managerB.getSnapshot().selectedSessionId).toBeUndefined();
    managerB.dispose();

    const clientChangedPath = makeClient(
      makeRun({ sessionId, workspace: changedPath }),
      sessionChangedPath,
    );
    const managerChangedPath = new WebSessionManager({
      client: clientChangedPath,
      workspace: changedPath,
      info: makeInfo(),
      selectionStore: store,
    });
    await managerChangedPath.loadSessions();
    expect(managerChangedPath.getSnapshot().selectedSessionId).toBe(sessionId);
    managerChangedPath.dispose();
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
  session = makeSession(run.sessionId),
): WebSessionClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listSessions: vi.fn(async () => ({ items: [session] })),
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

function makeSession(
  id: ClientAgentRun["sessionId"],
  defaultWorkspace: WorkspaceRef = workspace,
): ClientAgentSession {
  return ClientAgentSessionSchema.parse({
    id,
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
    defaultWorkspace,
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

class FakeTimer implements Timer {
  readonly delays: number[] = [];
  private readonly callbacks: (() => void)[] = [];

  schedule(delayMs: number, callback: () => void): TimerHandle {
    this.delays.push(delayMs);
    this.callbacks.push(callback);
    return { cancel: () => undefined };
  }

  fireNext(): void {
    this.callbacks.shift()?.();
  }
}
