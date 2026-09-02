import { describe, expect, it, vi } from "vitest";
import {
  ApprovalRequestSchema,
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  DaemonInfoSchema,
  createApprovalRequestId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
  createVerificationPlanId,
  createWorkspaceId,
  type AgentEvent,
  type ApprovalRequest,
  type ClientAgentRun,
  type ClientAgentSession,
  type DaemonInfo,
  type WorkspaceRef,
} from "@caelush/protocol";
import { WebSessionManager, type WebSessionClient } from "../src/application/session-manager.js";

const workspace: WorkspaceRef = { id: createWorkspaceId(), path: "/workspace" };

describe("WebSessionManager approval controls", () => {
  it("projects requested approvals from the event stream and removes resolved approvals", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const approval = makeApproval(run.id, 20);
    const client = makeClient({ session, run });
    client.listRuns.mockResolvedValue({ items: [] });
    client.createRun.mockResolvedValue(run);
    client.startRun.mockResolvedValue({ disposition: "SCHEDULED", run });
    let continueStream!: () => void;
    client.watchRunEvents.mockImplementation(async function* () {
      yield approvalRequested(run, approval);
      await new Promise<void>((resolve) => {
        continueStream = resolve;
      });
      yield approvalResolved(run, approval);
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);
    await expect(manager.submitPrompt("approval task")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().approvalState?.requests.length === 1);
    expect(manager.getSnapshot().approvalState?.requests).toEqual([
      expect.objectContaining({ id: approval.id, title: "Approve write", summary: "Write a file" }),
    ]);
    expect(Object.isFrozen(manager.getSnapshot().approvalState)).toBe(true);
    expect(Object.isFrozen(manager.getSnapshot().approvalState?.requests)).toBe(true);
    expect(Object.isFrozen(manager.getSnapshot().approvalState?.requests[0])).toBe(true);
    continueStream();
    await waitFor(() => manager.getSnapshot().approvalState?.requests.length === 0);

    manager.dispose();
  });

  it("loads and orders pending approvals when an active session is opened", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const later = makeApproval(run.id, 20);
    const earlier = makeApproval(run.id, 10);
    const client = makeClient({ session, run, pendingApprovals: [later, earlier] });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    await openActiveSession(manager, session);

    expect(manager.getSnapshot().approvalState?.requests.map((request) => request.id)).toEqual([
      earlier.id,
      later.id,
    ]);
    manager.dispose();
  });

  it("revalidates pending identity before resolving and suppresses duplicate submissions", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const approval = makeApproval(run.id, 10);
    let resolve!: () => void;
    const client = makeClient({ session, run, pendingApprovals: [approval] });
    client.resolveApproval.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await openActiveSession(manager, session);

    const first = manager.resolveApproval(approval.id, { action: "APPROVE", scope: "ONCE" });
    await waitFor(
      () => manager.getSnapshot().approvalState?.submitting.includes(approval.id) === true,
    );
    await expect(
      manager.resolveApproval(approval.id, { action: "APPROVE", scope: "ONCE" }),
    ).resolves.toBe(false);
    expect(client.resolveApproval).toHaveBeenCalledTimes(1);
    resolve();
    await expect(first).resolves.toBe(true);
    expect(client.resolveApproval).toHaveBeenCalledWith(run.id, approval.id, {
      action: "APPROVE",
      scope: "ONCE",
    });
    manager.dispose();
  });

  it("removes an externally resolved approval after stale revalidation", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const approval = makeApproval(run.id, 10);
    const client = makeClient({ session, run, pendingApprovals: [approval] });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await openActiveSession(manager, session);
    client.listPendingApprovals.mockResolvedValue({ items: [] });

    await expect(manager.resolveApproval(approval.id, { action: "REJECT" })).resolves.toBe(false);

    expect(client.resolveApproval).not.toHaveBeenCalled();
    expect(manager.getSnapshot().approvalState?.requests).toEqual([]);
    manager.dispose();
  });

  it("reconciles the control projection after a resolution failure", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const approval = makeApproval(run.id, 10);
    const client = makeClient({ session, run, pendingApprovals: [approval] });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await openActiveSession(manager, session);
    client.resolveApproval.mockRejectedValueOnce(new Error("already resolved"));
    client.listPendingApprovals
      .mockResolvedValueOnce({ items: [approval] })
      .mockResolvedValueOnce({ items: [] });

    await expect(manager.resolveApproval(approval.id, { action: "REJECT" })).resolves.toBe(false);

    expect(manager.getSnapshot().approvalState?.requests).toEqual([]);
    expect(manager.getSnapshot().approvalState?.submitting.includes(approval.id)).toBe(false);
    manager.dispose();
  });

  it("reserves an approval before asynchronous preflight so concurrent resolves submit once", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const approval = makeApproval(run.id, 10);
    const client = makeClient({ session, run, pendingApprovals: [approval] });
    let releasePreflight!: () => void;
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await openActiveSession(manager, session);
    client.listPendingApprovals.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePreflight = () => resolve({ items: [approval] });
        }),
    );

    const first = manager.resolveApproval(approval.id, { action: "REJECT" });
    await waitFor(() => releasePreflight !== undefined);
    const second = manager.resolveApproval(approval.id, { action: "REJECT" });
    releasePreflight();
    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(client.resolveApproval).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it.each(["preflight", "mutation"] as const)(
    "clears a stale approval when %s reconciliation cannot list pending approvals",
    async (failure) => {
      const session = makeSession();
      const run = makeRun({ sessionId: session.id, status: "RUNNING" });
      const approval = makeApproval(run.id, 10);
      const client = makeClient({ session, run, pendingApprovals: [approval] });
      const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
      await openActiveSession(manager, session);
      if (failure === "preflight")
        client.listPendingApprovals.mockRejectedValueOnce(new Error("offline"));
      else {
        client.resolveApproval.mockRejectedValueOnce(new Error("conflict"));
        client.listPendingApprovals.mockResolvedValueOnce({ items: [approval] });
      }
      client.listPendingApprovals.mockRejectedValueOnce(new Error("offline"));

      await expect(manager.resolveApproval(approval.id, { action: "REJECT" })).resolves.toBe(false);
      expect(manager.getSnapshot().approvalState?.requests).toEqual([]);
      expect(client.getRun).toHaveBeenCalledWith(run.id);
      manager.dispose();
    },
  );

  it("does not carry approval controls into a different run, session, or draft", async () => {
    const first = makeSession();
    const second = makeSession();
    const firstRun = makeRun({ sessionId: first.id, status: "RUNNING" });
    const secondRun = makeRun({ sessionId: second.id, status: "RUNNING" });
    const approval = makeApproval(firstRun.id, 10);
    const client = makeClient({ session: first, run: firstRun, pendingApprovals: [approval] });
    client.listSessions.mockResolvedValue({ items: [first, second] });
    client.listRuns.mockResolvedValue({ items: [] });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await openActiveSession(manager, first);
    await manager.refreshApprovals(firstRun.id);
    expect(manager.getSnapshot().approvalState?.requests).toHaveLength(1);
    client.listPendingApprovals.mockResolvedValueOnce({ items: [] });
    await manager.refreshApprovals(secondRun.id);
    expect(manager.getSnapshot().approvalState?.requests).toHaveLength(0);
    await expect(manager.selectSession(second.id)).resolves.toBe(true);
    expect(manager.getSnapshot()).toMatchObject({ approvalState: undefined, controlMode: "NONE" });
    manager.beginDraft();
    expect(manager.getSnapshot()).toMatchObject({ approvalState: undefined, controlMode: "NONE" });
    manager.dispose();
  });

  it("settles a terminal reconciliation without leaving it active", async () => {
    const session = makeSession();
    const run = makeRun({ sessionId: session.id, status: "RUNNING" });
    const terminal = makeCompletedRun(run);
    const approval = makeApproval(run.id, 10);
    const client = makeClient({ session, run, pendingApprovals: [approval] });
    client.getRun.mockResolvedValue(terminal);
    client.listRuns.mockResolvedValue({ items: [terminal] });
    client.resolveApproval.mockRejectedValueOnce(new Error("conflict"));
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await openActiveSession(manager, session);

    await expect(manager.resolveApproval(approval.id, { action: "REJECT" })).resolves.toBe(false);
    expect(manager.getSnapshot()).toMatchObject({
      activeRuns: [],
      activeRun: undefined,
      composerEnabled: true,
    });
    expect(manager.getSnapshot().history).toContainEqual(
      expect.objectContaining({ runId: terminal.id, kind: "ASSISTANT" }),
    );
    manager.dispose();
  });
});

async function openActiveSession(
  manager: WebSessionManager,
  session: ClientAgentSession,
): Promise<void> {
  await manager.loadSessions();
  await expect(manager.selectSession(session.id)).resolves.toBe(true);
}

function makeClient(input: {
  readonly session: ClientAgentSession;
  readonly run: ClientAgentRun;
  readonly events?: readonly AgentEvent[];
  readonly pendingApprovals?: readonly ApprovalRequest[];
}): WebSessionClient & {
  readonly listPendingApprovals: ReturnType<typeof vi.fn>;
  readonly resolveApproval: ReturnType<typeof vi.fn>;
} {
  return {
    listSessions: vi.fn(async () => ({ items: [input.session] })),
    listRuns: vi.fn(async () => ({ items: [input.run] })),
    getSession: vi.fn(async () => input.session),
    createSession: vi.fn(),
    createRun: vi.fn(),
    startRun: vi.fn(),
    getRun: vi.fn(async () => input.run),
    listPendingApprovals: vi.fn(async () => ({ items: input.pendingApprovals ?? [] })),
    resolveApproval: vi.fn(async () => ({ disposition: "SCHEDULED", run: input.run })),
    watchRunEvents: vi.fn(async function* () {
      for (const event of input.events ?? []) yield event;
    }),
  } as unknown as WebSessionClient & {
    readonly listPendingApprovals: ReturnType<typeof vi.fn>;
    readonly resolveApproval: ReturnType<typeof vi.fn>;
  };
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
function makeRun(input: Partial<ClientAgentRun>): ClientAgentRun {
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
    ...input,
  });
}
function makeCompletedRun(run: ClientAgentRun): ClientAgentRun {
  return makeRun({
    ...run,
    status: "COMPLETED",
    finishedAt: 3,
    finalResult: {
      type: "VERIFIED_COMPLETION",
      text: "verified answer",
      verification: {
        planId: createVerificationPlanId(),
        sourceStepId: createStepId(),
        planHash: "a".repeat(64),
        candidateHash: "b".repeat(64),
        evidenceDigest: "c".repeat(64),
        freshnessHash: "d".repeat(64),
        sealHash: "e".repeat(64),
        checks: { total: 1, passed: 1, skipped: 0, advisoryWarnings: 0 },
      },
    },
  });
}
function makeApproval(runId: ClientAgentRun["id"], createdAt: number): ApprovalRequest {
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
    createdAt,
  });
}
function approvalRequested(run: ClientAgentRun, approval: ApprovalRequest): AgentEvent {
  return {
    type: "approval.requested",
    eventId: "evt_00000000-0000-7000-8000-000000000001",
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    timestamp: 1,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", sequence: 1 },
    payload: { approval },
  } as AgentEvent;
}
function approvalResolved(run: ClientAgentRun, approval: ApprovalRequest): AgentEvent {
  return {
    type: "approval.resolved",
    eventId: "evt_00000000-0000-7000-8000-000000000002",
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    timestamp: 2,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", sequence: 2 },
    payload: { approvalId: approval.id, status: "APPROVED", scope: "ONCE" },
  } as AgentEvent;
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}
