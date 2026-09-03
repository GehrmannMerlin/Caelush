import { describe, expect, it, vi } from "vitest";
import {
  ApprovalRequestSchema,
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  DaemonInfoSchema,
  createApprovalRequestId,
  createRunId,
  createSessionId,
  createToolInvocationId,
  createWorkspaceId,
  type ApprovalRequest,
  type ClientAgentRun,
  type ClientAgentSession,
  type DaemonInfo,
  type RunActionResponse,
  type WorkspaceRef,
} from "@caelush/protocol";
import { WebSessionManager, type WebSessionClient } from "../src/application/session-manager.js";

const workspace: WorkspaceRef = { id: createWorkspaceId(), path: "/workspace" };

describe("WebSessionManager cancellation controls", () => {
  it.each(["RUNNING", "WAITING_APPROVAL", "VERIFYING"] as const)(
    "sends cancellation only for active %s runs",
    async (status) => {
      const session = makeSession();
      const run = makeRun({ sessionId: session.id, status });
      const client = makeClient(session, run);
      const manager = await openActiveSession(client, session);

      await expect(manager.cancelRun()).resolves.toBe(true);

      expect(client.cancelRun).toHaveBeenCalledWith(run.id);
      manager.dispose();
    },
  );

  it("shares one cancellation request while the daemon response is pending", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const client = makeClient(session, run);
    let release!: (response: RunActionResponse) => void;
    client.cancelRun.mockImplementation(
      () =>
        new Promise<RunActionResponse>((resolve) => {
          release = resolve;
        }),
    );
    const manager = await openActiveSession(client, session);

    const first = manager.cancelRun();
    const second = manager.cancelRun();

    expect(first).toBe(second);
    expect(manager.getSnapshot()).toMatchObject({
      activeRun: { id: run.id, status: "RUNNING" },
      controlMode: "CANCELLING",
    });
    expect(client.cancelRun).toHaveBeenCalledTimes(1);
    release(actionResponse(run));
    await expect(first).resolves.toBe(true);
    expect(manager.getSnapshot().controlMode).toBe("NONE");
    manager.dispose();
  });

  it("settles the local session only when the daemon returns a terminal Run", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const cancelled = makeRun({ ...run, status: "CANCELLED", finishedAt: 2 });
    const client = makeClient(session, run);
    const manager = await openActiveSession(client, session);
    client.cancelRun.mockResolvedValue(actionResponse(cancelled));
    client.listRuns.mockResolvedValue({ items: [cancelled] });

    await expect(manager.cancelRun()).resolves.toBe(true);

    expect(manager.getSnapshot()).toMatchObject({
      activeRuns: [],
      activeRun: undefined,
      composerEnabled: true,
      controlMode: "NONE",
      error: undefined,
    });
    expect(manager.getSnapshot().runs).toEqual([cancelled]);
    manager.dispose();
  });

  it.each([
    ["returns an older same-id run", (run: ClientAgentRun) => [run]],
    ["omits the run", () => []],
  ] as const)(
    "retains the daemon-confirmed terminal run when listRuns %s",
    async (_caseName, staleRuns) => {
      const session = makeSession();
      const run = makeRun({ sessionId: session.id, status: "RUNNING" });
      const cancelled = makeRun({ ...run, status: "CANCELLED", finishedAt: 2 });
      const client = makeClient(session, run);
      const manager = await openActiveSession(client, session);
      client.cancelRun.mockResolvedValue(actionResponse(cancelled));
      client.listRuns.mockResolvedValue({ items: staleRuns(run) });

      await expect(manager.cancelRun()).resolves.toBe(true);

      expect(manager.getSnapshot()).toMatchObject({
        activeRun: undefined,
        activeRuns: [],
        runs: [cancelled],
        controlMode: "NONE",
      });
      manager.dispose();
    },
  );

  it("returns to coherent nonterminal controls when cancellation is not terminal", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const waiting = makeRun({ ...run, status: "WAITING_APPROVAL" });
    const approval = makeApproval(run.id);
    const client = makeClient(session, run, [approval]);
    client.cancelRun.mockResolvedValue(actionResponse(waiting));
    const manager = await openActiveSession(client, session);

    await expect(manager.cancelRun()).resolves.toBe(true);

    expect(manager.getSnapshot()).toMatchObject({
      activeRun: { id: run.id, status: "WAITING_APPROVAL" },
      controlMode: "APPROVAL",
      approvalState: { requests: [expect.objectContaining({ id: approval.id })] },
      error: undefined,
    });
    manager.dispose();
  });

  it("keeps the run recoverable and exposes only the safe cancellation failure text", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const client = makeClient(session, run);
    client.cancelRun.mockRejectedValue(new Error("network token and raw server detail"));
    const manager = await openActiveSession(client, session);

    await expect(manager.cancelRun()).resolves.toBe(false);

    expect(manager.getSnapshot()).toMatchObject({
      activeRun: run,
      activeRuns: [run],
      controlMode: "NONE",
      error: {
        code: "RUN_CANCEL_FAILED",
        message: "无法确认取消请求。任务可能仍在后台运行。",
      },
    });
    manager.dispose();
  });

  it("clears approval controls after daemon-confirmed cancellation wins an approval race", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "WAITING_APPROVAL" });
    const approval = makeApproval(run.id);
    const cancelled = makeRun({ ...run, status: "CANCELLED", finishedAt: 2 });
    const client = makeClient(session, run, [approval]);
    let resolveApproval!: () => void;
    client.resolveApproval.mockImplementation(
      () =>
        new Promise<RunActionResponse>((resolve) => {
          resolveApproval = () => resolve(actionResponse(run));
        }),
    );
    const manager = await openActiveSession(client, session);
    client.cancelRun.mockResolvedValue(actionResponse(cancelled));
    client.listRuns.mockResolvedValue({ items: [cancelled] });

    const approvalRequest = manager.resolveApproval(approval.id, {
      action: "APPROVE",
      scope: "ONCE",
    });
    await waitFor(
      () => manager.getSnapshot().approvalState?.submitting.includes(approval.id) === true,
    );
    await expect(manager.cancelRun()).resolves.toBe(true);
    resolveApproval();
    await expect(approvalRequest).resolves.toBe(false);

    expect(manager.getSnapshot()).toMatchObject({
      activeRun: undefined,
      approvalState: undefined,
      controlMode: "NONE",
    });
    manager.dispose();
  });

  it("retains CANCELLING during a live approval refresh before terminal cancellation settles", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "WAITING_APPROVAL" });
    const approval = makeApproval(run.id);
    const cancelled = makeRun({ ...run, status: "CANCELLED", finishedAt: 2 });
    const client = makeClient(session, run);
    let releaseCancellation!: (response: RunActionResponse) => void;
    client.cancelRun.mockImplementation(
      () =>
        new Promise<RunActionResponse>((resolve) => {
          releaseCancellation = resolve;
        }),
    );
    const manager = await openActiveSession(client, session);
    client.listPendingApprovals.mockResolvedValue({ items: [approval] });
    client.listRuns.mockResolvedValue({ items: [cancelled] });

    const cancellation = manager.cancelRun();
    await manager.refreshApprovals(run.id);

    expect(manager.getSnapshot()).toMatchObject({
      controlMode: "CANCELLING",
      approvalState: { requests: [expect.objectContaining({ id: approval.id })] },
    });
    releaseCancellation(actionResponse(cancelled));
    await expect(cancellation).resolves.toBe(true);
    expect(manager.getSnapshot()).toMatchObject({
      activeRun: undefined,
      approvalState: undefined,
      controlMode: "NONE",
    });
    manager.dispose();
  });

  it("refuses cancellation from non-cancellable statuses", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "PENDING" });
    const client = makeClient(session, run);
    const manager = await openActiveSession(client, session);

    await expect(manager.cancelRun()).resolves.toBe(false);

    expect(client.cancelRun).not.toHaveBeenCalled();
    expect(manager.getSnapshot().controlMode).toBe("PENDING_RUN_CONFIRMATION");
    manager.dispose();
  });

  it.each([
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ] as const)("does not call the daemon for terminal %s runs", async (status) => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status, finishedAt: 2 });
    const client = makeClient(session, run);
    const manager = await openActiveSession(client, session);

    await expect(manager.cancelRun()).resolves.toBe(false);

    expect(client.cancelRun).not.toHaveBeenCalled();
    expect(manager.getSnapshot().controlMode).toBe("NONE");
    manager.dispose();
  });
});

async function openActiveSession(
  client: ReturnType<typeof makeClient>,
  session: ClientAgentSession,
): Promise<WebSessionManager> {
  const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
  await manager.loadSessions();
  await expect(manager.selectSession(session.id)).resolves.toBe(true);
  return manager;
}

function makeClient(
  session: ClientAgentSession,
  run: ClientAgentRun,
  pendingApprovals: readonly ApprovalRequest[] = [],
): WebSessionClient & {
  readonly cancelRun: ReturnType<typeof vi.fn>;
  readonly listRuns: ReturnType<typeof vi.fn>;
  readonly resolveApproval: ReturnType<typeof vi.fn>;
} {
  return {
    listSessions: vi.fn(async () => ({ items: [session] })),
    listRuns: vi.fn(async () => ({ items: [run] })),
    getSession: vi.fn(async () => session),
    createSession: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(async () => run),
    listPendingApprovals: vi.fn(async () => ({ items: pendingApprovals })),
    resolveApproval: vi.fn(async () => actionResponse(run)),
    startRun: vi.fn(),
    cancelRun: vi.fn(async () => actionResponse(run)),
    watchRunEvents: vi.fn(async function* () {}),
  } as unknown as WebSessionClient & {
    readonly cancelRun: ReturnType<typeof vi.fn>;
    readonly listRuns: ReturnType<typeof vi.fn>;
    readonly resolveApproval: ReturnType<typeof vi.fn>;
  };
}

function actionResponse(run: ClientAgentRun): RunActionResponse {
  return { disposition: "SCHEDULED", run };
}

function makeInfo(): DaemonInfo {
  return DaemonInfoSchema.parse({
    apiVersion: "v1",
    protocolVersion: 1,
    daemonVersion: "0.1.0",
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
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    },
  });
}

function makeSession(): ClientAgentSession {
  return ClientAgentSessionSchema.parse({
    id: createSessionId(),
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
    defaultWorkspace: workspace,
    defaultModel: { provider: "fixture", model: "fixture" },
  });
}

function makeRun(overrides: Partial<ClientAgentRun>): ClientAgentRun {
  return ClientAgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "task",
    status: "PENDING",
    workspace,
    model: { provider: "fixture", model: "fixture" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    createdAt: 1,
    ...overrides,
  });
}

function makeApproval(runId: ClientAgentRun["id"]): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: createApprovalRequestId(),
    runId,
    toolInvocationId: createToolInvocationId(),
    status: "PENDING",
    title: "Approve write",
    reason: "This changes the workspace.",
    riskLevel: "HIGH",
    scope: "ONCE",
    action: {
      toolName: "apply_patch",
      summary: "Write a file",
      requiredCapabilities: ["filesystem.write"],
    },
    createdAt: 1,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}
