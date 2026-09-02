import {
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  DaemonInfoSchema,
  createRunId,
  createSessionId,
  createStepId,
  createVerificationPlanId,
  createWorkspaceId,
  type AgentEvent,
  type ClientAgentRun,
  type ClientAgentSession,
  type DaemonInfo,
  type RunActionResponse,
  type WorkspaceRef,
} from "@caelush/protocol";
import type { WatchRunEventsOptions } from "@caelush/client";
import { describe, expect, it, vi } from "vitest";
import { WebSessionManager, type WebSessionClient } from "../src/application/session-manager.js";

const workspace: WorkspaceRef = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
const otherWorkspace: WorkspaceRef = {
  id: createWorkspaceId(),
  path: "C:\\workspace\\other",
};

describe("WebSessionManager", () => {
  it("loads only current-workspace Sessions and preserves selected identity", async () => {
    const current = makeSession({ defaultWorkspace: workspace });
    const other = makeSession({ defaultWorkspace: otherWorkspace });
    const client = makeClient({
      sessions: [current, other],
      latestRuns: new Map([
        [current.id, []],
        [other.id, []],
      ]),
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    await manager.loadSessions();
    expect(manager.getSnapshot().candidates.map((item) => item.session.id)).toEqual([current.id]);
    await expect(manager.selectSession(current.id)).resolves.toBe(true);
    expect(manager.getSnapshot().selectedSessionId).toBe(current.id);

    manager.dispose();
  });

  it("keeps New Session as a local draft until the first valid prompt", async () => {
    const client = makeClient();
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    manager.beginDraft();

    expect(manager.getSnapshot()).toMatchObject({
      isDraft: true,
      selectedSession: undefined,
      history: [],
      composerEnabled: true,
    });
    expect(client.createSession).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("creates a Session on first submit and inherits daemon Run defaults", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id, goal: "repair login" });
    const client = makeClient({
      createSessionResult: session,
      createRunResult: pendingRun,
      watchEvents: [
        lifecycleEvent("run.started", pendingRun),
        lifecycleEvent("run.completed", pendingRun),
      ],
    });
    const runningRun = makeRun({ ...pendingRun, status: "RUNNING" });
    const completedRun = makeCompletedRun(pendingRun);
    const calls: string[] = [];
    client.createSession.mockImplementation(async (input) => {
      calls.push("createSession");
      expect(input).toEqual({
        title: "repair login",
        defaultWorkspace: workspace,
        defaultModel: { provider: "fixture", model: "fixture-model" },
        metadata: {},
      });
      return session;
    });
    client.createRun.mockImplementation(async (_sessionId, input) => {
      calls.push("createRun");
      expect(input).toMatchObject({
        goal: "repair login",
        workspace,
        model: { provider: "fixture", model: "fixture-model" },
        ...makeInfo().defaultRunConfiguration,
      });
      return pendingRun;
    });
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      calls.push("watch");
      options?.onOpen?.();
      calls.push("watch-open");
      await Promise.resolve();
      for (const event of client.watchEvents) {
        calls.push("event");
        yield event;
      }
    });
    client.startRun.mockImplementation(async (runId) => {
      calls.push("startRun");
      return actionResponse(runningRun, runId);
    });
    client.getRun.mockResolvedValueOnce(runningRun).mockResolvedValueOnce(completedRun);
    client.listRuns.mockResolvedValue({ items: [completedRun] });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    manager.beginDraft();

    await expect(manager.submitPrompt("repair login")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().submission === "IDLE");

    expect(calls.slice(0, 4)).toEqual(["createSession", "createRun", "watch", "watch-open"]);
    expect(calls).toContain("startRun");
    expect(manager.getSnapshot()).toMatchObject({
      selectedSessionId: session.id,
      composerEnabled: true,
      history: [
        { kind: "USER", text: "repair login" },
        { kind: "ASSISTANT", text: "verified answer" },
      ],
    });

    manager.dispose();
  });

  it("keeps empty Timeline state for bootstrap, draft, and a selected completed Session", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const completedRun = makeCompletedRun(makeRun({ sessionId: session.id }));
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [completedRun]]]),
    });
    client.listRuns.mockResolvedValue({ items: [completedRun] });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    expect(manager.getSnapshot().timeline).toMatchObject({
      settled: [],
      activeTools: [],
      activeLlm: [],
      activeProcesses: [],
      activeApprovals: [],
    });
    manager.beginDraft();
    expect(manager.getSnapshot().timeline.settled).toEqual([]);
    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);
    expect(manager.getSnapshot().timeline).toMatchObject({ settled: [] });
    manager.dispose();
  });

  it("creates an empty Timeline scoped to a newly created Run", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id });
    const client = makeClient({ createSessionResult: session, createRunResult: pendingRun });
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      yield* [] as AgentEvent[];
      await new Promise<void>(() => undefined);
    });
    client.startRun.mockResolvedValue(
      actionResponse(makeRun({ ...pendingRun, status: "RUNNING" }), pendingRun.id),
    );
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    manager.beginDraft();
    await expect(manager.submitPrompt("start fresh timeline")).resolves.toBe(true);

    expect(manager.getSnapshot().timeline).toMatchObject({
      runId: pendingRun.id,
      settled: [],
      activeTools: [],
      activeLlm: [],
      activeProcesses: [],
      activeApprovals: [],
    });
    expect(client.watchRunEvents).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("projects activity from the single Run stream without refreshing authority, then flushes it on terminal settlement", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id, goal: "inspect timeline" });
    const runningRun = makeRun({ ...pendingRun, status: "RUNNING" });
    const completedRun = makeCompletedRun(pendingRun);
    const client = makeClient({
      createSessionResult: session,
      createRunResult: pendingRun,
      watchEvents: [
        reasoningEvent(pendingRun, "Inspecting the workspace."),
        lifecycleEvent("run.completed", pendingRun),
      ],
    });
    client.getRun.mockResolvedValue(completedRun);
    client.listRuns.mockResolvedValue({ items: [completedRun] });
    client.startRun.mockResolvedValue(actionResponse(runningRun, pendingRun.id));
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    manager.beginDraft();
    await expect(manager.submitPrompt("inspect timeline")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().submission === "IDLE");

    const snapshot = manager.getSnapshot();
    expect(client.watchRunEvents).toHaveBeenCalledTimes(1);
    expect(client.getRun).toHaveBeenCalledTimes(1);
    expect(snapshot.timeline.runId).toBe(pendingRun.id);
    expect(snapshot.timeline.settled).toContainEqual(
      expect.objectContaining({ kind: "REASONING", text: "Inspecting the workspace." }),
    );
    expect(snapshot.timeline).toMatchObject({
      activeLlm: [],
      activeTools: [],
      activeProcesses: [],
      activeApprovals: [],
      retries: [],
      verification: [],
    });
    manager.dispose();
  });

  it("exposes only the shared safe Timeline error for conflicting durable event order", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id });
    const client = makeClient({
      createSessionResult: session,
      createRunResult: pendingRun,
      watchEvents: [
        durableReasoningEvent(
          pendingRun,
          "evt_00000000-0000-7000-8000-000000000010",
          1,
          "First safe summary.",
        ),
        durableReasoningEvent(
          pendingRun,
          "evt_00000000-0000-7000-8000-000000000011",
          1,
          "raw secret-like detail must not be exposed",
        ),
      ],
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    manager.beginDraft();
    await expect(manager.submitPrompt("conflict")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().timeline.error !== undefined);

    expect(manager.getSnapshot().timeline.error).toBe(
      "Timeline event order could not be verified.",
    );
    expect(manager.getSnapshot().timeline.settled).toHaveLength(1);
    expect(manager.getSnapshot().timeline.settled[0]).toMatchObject({
      kind: "REASONING",
      text: "First safe summary.",
    });
    expect(client.getRun).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("ignores a stale lifecycle event so it cannot update the new active Run", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const activeRun = makeRun({ sessionId: session.id, status: "PENDING" });
    const staleRun = makeRun({ sessionId: session.id, status: "RUNNING" });
    const client = makeClient({ createSessionResult: session, createRunResult: activeRun });
    let staleEventDelivered = false;
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      yield lifecycleEvent("status.changed", staleRun);
      staleEventDelivered = true;
      await new Promise<void>(() => undefined);
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    manager.beginDraft();
    await expect(manager.submitPrompt("new run")).resolves.toBe(true);
    await waitFor(() => staleEventDelivered);

    expect(client.getRun).not.toHaveBeenCalled();
    expect(manager.getSnapshot().activeRun?.id).toBe(activeRun.id);
    expect(manager.getSnapshot().timeline).toMatchObject({ runId: activeRun.id, settled: [] });
    manager.dispose();
  });

  it("keeps prior Run-level history when submitting the next Run in one Session", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const previousRun = makeCompletedRun(makeRun({ sessionId: session.id, goal: "previous task" }));
    const nextRun = makeRun({ sessionId: session.id, goal: "next task" });
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [previousRun]]]),
      createRunResult: nextRun,
    });
    client.listRuns.mockResolvedValue({ items: [previousRun] });
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      yield* [] as AgentEvent[];
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);

    await expect(manager.submitPrompt("next task")).resolves.toBe(true);

    expect(manager.getSnapshot().history).toEqual([
      {
        id: `history:user:${previousRun.id}`,
        kind: "USER",
        text: "previous task",
        runId: previousRun.id,
      },
      {
        id: `history:assistant:${previousRun.id}`,
        kind: "ASSISTANT",
        text: "verified answer",
        runId: previousRun.id,
      },
      { id: `history:user:${nextRun.id}`, kind: "USER", text: "next task", runId: nextRun.id },
    ]);
    manager.dispose();
  });

  it("retains no fabricated history when Session admission fails", async () => {
    const client = makeClient();
    client.createSession.mockRejectedValue(new Error("database detail"));
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    manager.beginDraft();

    await expect(manager.submitPrompt("first task")).resolves.toBe(false);

    expect(manager.getSnapshot()).toMatchObject({
      history: [],
      isDraft: true,
      composerEnabled: true,
      error: { code: "SESSION_CREATE_FAILED", message: "无法创建会话。" },
    });
    manager.dispose();
  });

  it("fails closed when the daemon has no default model", async () => {
    const client = makeClient();
    const info = makeInfo({ defaultModel: undefined });
    const manager = new WebSessionManager({ client, workspace, info });
    manager.beginDraft();

    await expect(manager.submitPrompt("task")).resolves.toBe(false);

    expect(manager.getSnapshot()).toMatchObject({
      error: { code: "DEFAULT_MODEL_UNAVAILABLE" },
      history: [],
    });
    expect(client.createSession).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("disables the composer for one existing non-terminal Run", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const activeRun = makeRun({ sessionId: session.id, status: "RUNNING" });
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [activeRun]]]),
    });
    client.listRuns.mockResolvedValue({ items: [activeRun] });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);

    expect(manager.getSnapshot()).toMatchObject({
      activeRun: { id: activeRun.id, status: "RUNNING" },
      composerEnabled: false,
      submission: "IDLE",
    });
    await expect(manager.submitPrompt("blocked")).resolves.toBe(false);
    expect(client.createRun).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("fails closed when a Session has multiple non-terminal Runs", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const runs = [
      makeRun({ sessionId: session.id, status: "RUNNING" }),
      makeRun({ sessionId: session.id, status: "VERIFYING" }),
    ];
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [runs[0]]]]),
    });
    client.listRuns.mockResolvedValue({ items: runs });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);

    expect(manager.getSnapshot()).toMatchObject({
      activeRuns: runs,
      composerEnabled: false,
      error: {
        code: "MULTIPLE_ACTIVE_RUNS",
        message: "该会话存在多个未完成运行，暂时无法安全继续。",
      },
    });
    manager.dispose();
  });

  it("maps stream and refresh failures to safe errors", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id });
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, []]]),
      createRunResult: pendingRun,
    });
    client.listRuns.mockResolvedValue({ items: [] });
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("raw stream detail");
      yield* [] as AgentEvent[];
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    await manager.selectSession(session.id);

    await expect(manager.submitPrompt("stream task")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().error?.code === "RUN_STREAM_FAILED");

    expect(manager.getSnapshot().error).toEqual({
      code: "RUN_STREAM_FAILED",
      message: "任务执行连接中断。",
    });
    manager.dispose();
  });

  it("keeps the active Run blocked when lifecycle refresh fails", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id });
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, []]]),
      createRunResult: pendingRun,
    });
    client.listRuns.mockResolvedValue({ items: [] });
    client.getRun.mockRejectedValue(new Error("database detail"));
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      yield lifecycleEvent("status.changed", pendingRun);
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    manager.beginDraft();

    await expect(manager.submitPrompt("refresh task")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().error?.code === "RUN_REFRESH_FAILED");

    expect(manager.getSnapshot()).toMatchObject({
      activeRun: { id: pendingRun.id },
      composerEnabled: false,
      error: { code: "RUN_REFRESH_FAILED", message: "无法刷新任务状态。" },
    });
    manager.dispose();
  });
});

function makeClient(
  options: {
    sessions?: readonly ClientAgentSession[];
    latestRuns?: Map<string, readonly ClientAgentRun[]>;
    createSessionResult?: ClientAgentSession;
    createRunResult?: ClientAgentRun;
    watchEvents?: readonly AgentEvent[];
    refreshedRuns?: readonly ClientAgentRun[];
  } = {},
): WebSessionClient & {
  readonly createSession: ReturnType<typeof vi.fn>;
  readonly createRun: ReturnType<typeof vi.fn>;
  readonly startRun: ReturnType<typeof vi.fn>;
  readonly getRun: ReturnType<typeof vi.fn>;
  readonly watchRunEvents: ReturnType<typeof vi.fn>;
  readonly watchEvents: readonly AgentEvent[];
} {
  let refreshIndex = 0;
  const sessions = options.sessions ?? [];
  const latestRuns = options.latestRuns ?? new Map<string, readonly ClientAgentRun[]>();
  const client = {
    listSessions: vi.fn(async () => ({ items: sessions })),
    listRuns: vi.fn(async (sessionId: { toString(): string }) => ({
      items:
        options.refreshedRuns === undefined
          ? [...(latestRuns.get(sessionId.toString()) ?? [])]
          : refreshIndex++ === 0
            ? [...(latestRuns.get(sessionId.toString()) ?? [])]
            : [...options.refreshedRuns],
    })),
    getSession: vi.fn(async (session: ClientAgentSession) => session),
    createSession: vi.fn(
      async () => options.createSessionResult ?? makeSession({ defaultWorkspace: workspace }),
    ),
    createRun: vi.fn(async () => options.createRunResult ?? makeRun()),
    getRun: vi.fn(
      async () => options.refreshedRuns?.at(-1) ?? options.createRunResult ?? makeRun(),
    ),
    startRun: vi.fn(async (runId: string) =>
      actionResponse(options.createRunResult ?? makeRun(), runId),
    ),
    watchRunEvents: vi.fn(async function* (_runId: string, watchOptions?: WatchRunEventsOptions) {
      watchOptions?.onOpen?.();
      for (const event of options.watchEvents ?? []) yield event;
    }),
    watchEvents: options.watchEvents ?? [],
  } as unknown as WebSessionClient & {
    readonly createSession: ReturnType<typeof vi.fn>;
    readonly createRun: ReturnType<typeof vi.fn>;
    readonly startRun: ReturnType<typeof vi.fn>;
    readonly getRun: ReturnType<typeof vi.fn>;
    readonly watchRunEvents: ReturnType<typeof vi.fn>;
    readonly watchEvents: readonly AgentEvent[];
  };
  return client;
}

function makeInfo(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
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
    defaultModel: { provider: "fixture", model: "fixture-model" },
    defaultRunConfiguration: {
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    },
    ...overrides,
  });
}

function makeSession(overrides: Partial<ClientAgentSession> = {}): ClientAgentSession {
  return ClientAgentSessionSchema.parse({
    id: createSessionId(),
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
    ...overrides,
  });
}

function makeRun(overrides: Partial<ClientAgentRun> = {}): ClientAgentRun {
  return ClientAgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "task",
    status: "PENDING",
    workspace,
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    createdAt: 1,
    ...overrides,
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

function lifecycleEvent(type: string, run: ClientAgentRun): AgentEvent {
  return {
    type,
    eventId: "evt_00000000-0000-7000-8000-000000000001",
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    timestamp: 1,
    visibility: "USER_VISIBLE",
    durability: { kind: "EPHEMERAL" },
    payload: {},
  } as AgentEvent;
}

function reasoningEvent(run: ClientAgentRun, summary: string): AgentEvent {
  return {
    type: "reasoning.summary",
    eventId: "evt_00000000-0000-7000-8000-000000000002",
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    timestamp: 1,
    visibility: "USER_VISIBLE",
    durability: { kind: "EPHEMERAL" },
    payload: { summary },
  } as AgentEvent;
}

function durableReasoningEvent(
  run: ClientAgentRun,
  eventId: string,
  sequence: number,
  summary: string,
): AgentEvent {
  return {
    ...reasoningEvent(run, summary),
    eventId,
    durability: { kind: "DURABLE", sequence },
  } as AgentEvent;
}

function actionResponse(run: ClientAgentRun, runId: string): RunActionResponse {
  return { disposition: "SCHEDULED", run: { ...run, id: runId } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}
