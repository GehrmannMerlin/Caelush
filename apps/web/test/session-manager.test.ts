import {
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  DaemonInfoSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createVerificationPlanId,
  createWorkspaceId,
  type PublicRunEvent,
  type ClientAgentRun,
  type ClientAgentSession,
  type ContextUsageProjection,
  type DaemonInfo,
  type RunActionResponse,
  type SessionTranscriptResponse,
  type SessionTurnPresentationResponse,
  type SessionTurnPresentationResponseV2,
  type SessionTurnPresentationResponseV3,
  type SessionContinuityPreflightResponse,
  type TranscriptEntry,
  type WorkspaceSessionSummary,
  type WorkspaceRef,
} from "@caelush/protocol";
import {
  CaelushProtocolCompatibilityError,
  type Timer,
  type WatchRunEventsOptions,
} from "@caelush/client";
import { describe, expect, it, vi } from "vitest";
import type {
  FrameHandle,
  FrameScheduler,
} from "../src/application/frame-publication-scheduler.js";
import { SessionSelectionStore } from "../src/application/session-persistence.js";
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

  it("offers a same-workspace continuity session without copying history or submitting", async () => {
    const oldSession = makeSession({
      defaultWorkspace: workspace,
      defaultModel: { provider: "fixture", model: "fixture-model" },
      defaultReasoningLevel: "HIGH",
    });
    const oldRun = makeCompletedRun(
      makeRun({
        sessionId: oldSession.id,
        goal: "old task",
        securityPolicy: {
          schemaVersion: 1,
          preset: { id: "WORKSPACE_WRITE", version: 1 },
          permissionProfile: "PROJECT_ACCESS",
          approvalPolicy: "DANGEROUS_ONLY",
          filesystemBoundary: "WORKSPACE_READ_WRITE",
          processBoundary: "WORKSPACE_WRITE",
          requiredEnforcement: "OS_RESTRICTED",
          hardSafetyPolicyVersion: "hard-safety@1",
          commandPolicyVersion: "command-policy@1",
          secretPolicyVersion: "secret-policy@1",
          createdAt: new Date(1).toISOString(),
          policyDigest: "a".repeat(64),
        },
      }),
    );
    const newSession = makeSession({
      defaultWorkspace: workspace,
      defaultModel: { provider: "fixture", model: "fixture-model" },
      defaultReasoningLevel: "HIGH",
    });
    const client = makeClient({
      sessions: [oldSession],
      latestRuns: new Map([[oldSession.id, [oldRun]]]),
      createSessionResult: newSession,
      transcriptResponse: { items: [userTranscript(oldRun, "old prompt")] },
    });
    client.getSessionContinuityPreflight.mockResolvedValue({ status: "POSSIBLE_INCOMPATIBILITY" });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: { ...makeInfo().capabilities, sessionContinuityPreflight: true },
      }),
    });

    await manager.loadSessions();
    await expect(manager.selectSession(oldSession.id)).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().continuityWarning);
    expect(manager.getSnapshot().history).toEqual([userTranscript(oldRun, "old prompt")]);
    expect(manager.getSnapshot().selectedPreset).toEqual({
      id: "WORKSPACE_WRITE",
      expectedVersion: 1,
    });

    await expect(manager.createContinuitySession()).resolves.toBe(true);

    expect(client.createSession).toHaveBeenCalledWith({
      title: "旧会话（新会话）",
      defaultWorkspace: workspace,
      defaultModel: { provider: "fixture", model: "fixture-model" },
      defaultReasoningLevel: "HIGH",
      metadata: {},
    });
    expect(client.createRun).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toMatchObject({
      selectedSessionId: newSession.id,
      selectedSession: newSession,
      history: [],
      runs: [],
      composerEnabled: true,
      continuityWarning: false,
      selectedPreset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
    });
    expect(manager.getSnapshot().candidates.map((candidate) => candidate.session.id)).toContain(
      oldSession.id,
    );
    expect(manager.getSnapshot().candidates.map((candidate) => candidate.session.id)).toContain(
      newSession.id,
    );
    manager.dispose();
  });

  it("persists a newly created Session selection so it is restored after reload", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id, goal: "remember this session" });
    const client = makeClient({
      sessions: [session],
      createSessionResult: session,
      createRunResult: pendingRun,
    });
    const selectionStore = new SessionSelectionStore(new Map<string, string>());
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo(),
      selectionStore,
    });

    manager.beginDraft();
    await expect(manager.submitPrompt("remember this session")).resolves.toBe(true);

    expect(selectionStore.read(workspace.id)).toBe(session.id);
    manager.dispose();

    const reloadedManager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo(),
      selectionStore,
    });
    await reloadedManager.loadSessions();

    expect(reloadedManager.getSnapshot().selectedSessionId).toBe(session.id);
    reloadedManager.dispose();
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
    client.getSessionTranscript.mockResolvedValue({
      items: [
        userTranscript(completedRun, "repair login"),
        assistantTranscript(completedRun, "verified answer"),
      ],
    });
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
        runtime: makeInfo().defaultRunConfiguration.runtime,
        preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
        limits: makeInfo().defaultRunConfiguration.limits,
      });
      expect(input).not.toHaveProperty("permissionProfile");
      expect(input).not.toHaveProperty("approvalPolicy");
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
      history: expect.arrayContaining([
        expect.objectContaining({ kind: "USER", text: "repair login" }),
        expect.objectContaining({ kind: "ASSISTANT", text: "verified answer" }),
      ]),
    });

    manager.dispose();
  });

  it("reconciles an optimistic Web user entry with the canonical transcript by Run identity", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id, goal: "canonical web prompt" });
    const durableUser: TranscriptEntry = {
      id: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000006",
      runId: pendingRun.id,
      conversationTurnId: pendingRun.id,
      createdAt: pendingRun.createdAt,
      kind: "USER",
      text: pendingRun.goal,
    };
    const transcriptResponse: SessionTranscriptResponse = { items: [durableUser] };
    const client = makeClient({
      createSessionResult: session,
      createRunResult: pendingRun,
      transcriptResponse,
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: { ...makeInfo().capabilities, sessionTranscript: true },
      }),
    });
    manager.beginDraft();

    await expect(manager.submitPrompt(pendingRun.goal)).resolves.toBe(true);

    expect(client.getSessionTranscript).toHaveBeenCalled();
    expect(manager.getSnapshot().history).toEqual([durableUser]);
    manager.dispose();
  });

  it("loads the ordered turn presentation when the daemon advertises the capability", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const run = makeCompletedRun(makeRun({ sessionId: session.id }));
    const presentation: SessionTurnPresentationResponse = {
      capabilityVersion: 1,
      highWatermark: 4,
      items: [
        {
          id: "presentation:assistant",
          runId: run.id,
          conversationTurnId: run.id,
          ordinal: 0,
          status: "COMPLETED",
          createdAt: run.finishedAt ?? run.createdAt,
          kind: "ASSISTANT",
          phase: "FINAL_ANSWER",
          text: "已完成检查。",
        },
      ],
    };
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [run]]]),
      turnPresentationResponse: presentation,
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: { ...makeInfo().capabilities, sessionTurnPresentation: true },
      }),
    });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);

    expect(client.getSessionTurnPresentation).toHaveBeenCalledWith(session.id, { limit: 100 });
    expect(manager.getSnapshot().turnPresentation).toEqual(presentation);
    manager.dispose();
  });

  it("loads every ordered turn-presentation page so long tasks remain complete after navigation", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const run = makeCompletedRun(makeRun({ sessionId: session.id }));
    const firstItem = {
      id: "presentation:user",
      runId: run.id,
      conversationTurnId: run.id,
      ordinal: 0,
      status: "COMPLETED" as const,
      createdAt: run.createdAt,
      kind: "USER" as const,
      text: "检查项目",
    };
    const secondItem = {
      id: "presentation:assistant",
      runId: run.id,
      conversationTurnId: run.id,
      ordinal: 1,
      status: "COMPLETED" as const,
      createdAt: run.finishedAt ?? run.createdAt,
      kind: "ASSISTANT" as const,
      phase: "FINAL_ANSWER" as const,
      text: "已完成检查。",
    };
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [run]]]),
    });
    client.getSessionTurnPresentation.mockImplementation(async (_sessionId, query) =>
      query?.cursor === "1"
        ? { capabilityVersion: 1, highWatermark: 8, items: [secondItem] }
        : {
            capabilityVersion: 1,
            highWatermark: 8,
            items: [firstItem],
            nextCursor: "1",
          },
    );
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: { ...makeInfo().capabilities, sessionTurnPresentation: true },
      }),
    });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);

    expect(client.getSessionTurnPresentation).toHaveBeenNthCalledWith(1, session.id, {
      limit: 100,
    });
    expect(client.getSessionTurnPresentation).toHaveBeenNthCalledWith(2, session.id, {
      limit: 100,
      cursor: "1",
    });
    expect(manager.getSnapshot().turnPresentation?.items).toEqual([firstItem, secondItem]);
    expect(manager.getSnapshot().turnPresentation?.nextCursor).toBeUndefined();
    manager.dispose();
  });

  it("preserves v2 across every turn presentation page", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const run = makeCompletedRun(makeRun({ sessionId: session.id }));
    const firstItem = {
      id: "presentation:user-v2",
      runId: run.id,
      conversationTurnId: run.id,
      ordinal: 0,
      status: "COMPLETED" as const,
      createdAt: run.createdAt,
      kind: "USER" as const,
      text: "检查项目",
    };
    const secondItem = {
      id: "presentation:assistant-v2",
      runId: run.id,
      conversationTurnId: run.id,
      ordinal: 1,
      status: "COMPLETED" as const,
      createdAt: run.finishedAt ?? run.createdAt,
      kind: "ASSISTANT" as const,
      phase: "FINAL_ANSWER" as const,
      sourceStepId: createStepId(),
      text: "已完成检查。",
    };
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [run]]]),
    });
    client.getSessionTurnPresentation.mockImplementation(async (_sessionId, query) =>
      query?.cursor === "1"
        ? { capabilityVersion: 2, highWatermark: 8, items: [secondItem] }
        : {
            capabilityVersion: 2,
            highWatermark: 8,
            items: [firstItem],
            nextCursor: "1",
          },
    );
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: { ...makeInfo().capabilities, sessionTurnPresentation: true },
      }),
    });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);

    expect(manager.getSnapshot().turnPresentation).toEqual({
      capabilityVersion: 2,
      items: [firstItem, secondItem],
      highWatermark: 8,
    } satisfies SessionTurnPresentationResponseV2);
    expect(manager.getSnapshot().turnPresentation?.items[1]).toMatchObject({
      sourceStepId: secondItem.sourceStepId,
    });
    manager.dispose();
  });

  it("keeps v3 pages as whole Run Turns in canonical order", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const runOne = makeCompletedRun(makeRun({ sessionId: session.id, createdAt: 1 }));
    const runTwo = makeCompletedRun(makeRun({ sessionId: session.id, createdAt: 2 }));
    const turnOne = {
      runId: runOne.id,
      conversationTurnId: "turn-one-canonical",
      runStatus: "COMPLETED" as const,
      openedAt: runOne.createdAt,
      closedAt: runOne.finishedAt,
      highWatermark: 85,
      items: [
        {
          id: "run-one-user",
          runId: runOne.id,
          conversationTurnId: "turn-one-canonical",
          ordinal: 0,
          status: "COMPLETED" as const,
          createdAt: runOne.createdAt,
          kind: "USER" as const,
          text: "first request",
        },
        {
          id: "run-one-final",
          runId: runOne.id,
          conversationTurnId: "turn-one-canonical",
          ordinal: 1,
          status: "COMPLETED" as const,
          createdAt: runOne.finishedAt ?? runOne.createdAt,
          kind: "ASSISTANT" as const,
          phase: "FINAL_ANSWER" as const,
          text: "first done",
        },
      ],
    };
    const turnTwo = {
      runId: runTwo.id,
      conversationTurnId: "turn-two-canonical",
      runStatus: "COMPLETED" as const,
      openedAt: runTwo.createdAt,
      closedAt: runTwo.finishedAt,
      highWatermark: 7,
      items: [
        {
          id: "run-two-user",
          runId: runTwo.id,
          conversationTurnId: "turn-two-canonical",
          ordinal: 0,
          status: "COMPLETED" as const,
          createdAt: runTwo.createdAt,
          kind: "USER" as const,
          text: "second request",
        },
        {
          id: "run-two-final",
          runId: runTwo.id,
          conversationTurnId: "turn-two-canonical",
          ordinal: 1,
          status: "COMPLETED" as const,
          createdAt: runTwo.finishedAt ?? runTwo.createdAt,
          kind: "ASSISTANT" as const,
          phase: "FINAL_ANSWER" as const,
          text: "second done",
        },
      ],
    };
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [runOne, runTwo]]]),
    });
    client.getSessionTurnPresentation.mockImplementation(async (_sessionId, query) =>
      query?.cursor === runOne.id
        ? { capabilityVersion: 3, turns: [turnTwo] }
        : { capabilityVersion: 3, turns: [turnOne], nextCursor: runOne.id },
    );
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: { ...makeInfo().capabilities, sessionTurnPresentation: true },
      }),
    });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);

    expect(client.getSessionTurnPresentation).toHaveBeenNthCalledWith(1, session.id, {
      limit: 100,
    });
    expect(client.getSessionTurnPresentation).toHaveBeenNthCalledWith(2, session.id, {
      limit: 100,
      cursor: runOne.id,
    });
    expect(manager.getSnapshot().turnPresentation).toEqual({
      capabilityVersion: 3,
      turns: [turnOne, turnTwo],
    } satisfies SessionTurnPresentationResponseV3);
    manager.dispose();
  });

  it("single-flights a durable burst and merges one Active V3 Turn into the full Session", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const previousRun = makeCompletedRun(makeRun({ sessionId: session.id, createdAt: 1 }));
    const pendingRun = makeRun({ sessionId: session.id, createdAt: 2, goal: "singleflight goal" });
    const runningRun = makeRun({ ...pendingRun, status: "RUNNING" });
    const stream = new TestRunEventStream();
    const previousTurn = {
      runId: previousRun.id,
      conversationTurnId: `turn:${previousRun.id}`,
      runStatus: "COMPLETED" as const,
      openedAt: previousRun.createdAt,
      closedAt: previousRun.finishedAt,
      highWatermark: 12,
      items: [
        {
          id: `presentation:user:${previousRun.id}`,
          runId: previousRun.id,
          conversationTurnId: `turn:${previousRun.id}`,
          ordinal: 0,
          status: "COMPLETED" as const,
          createdAt: previousRun.createdAt,
          kind: "USER" as const,
          text: previousRun.goal,
        },
      ],
    };
    const activeTurn = (
      highWatermark: number,
      items: SessionTurnPresentationResponseV3["turns"][number]["items"] = [],
    ) => ({
      runId: pendingRun.id,
      conversationTurnId: `turn:${pendingRun.id}`,
      runStatus: "RUNNING" as const,
      openedAt: pendingRun.createdAt,
      highWatermark,
      items,
    });
    const initialPresentation: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [previousTurn],
    };
    const firstRefresh = deferred<SessionTurnPresentationResponseV3>();
    const trailingRefresh = deferred<SessionTurnPresentationResponseV3>();
    let targetedRequestCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [previousRun]]]),
      createRunResult: pendingRun,
      turnPresentationResponse: initialPresentation,
    });
    client.listRuns.mockResolvedValue({ items: [previousRun] });
    client.startRun.mockResolvedValue(actionResponse(runningRun, pendingRun.id));
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      return stream;
    });
    client.getSessionTurnPresentation.mockImplementation(async (_sessionId, query) => {
      if (query?.runId === undefined) return initialPresentation;
      targetedRequestCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await (targetedRequestCount === 1 ? firstRefresh.promise : trailingRefresh.promise);
      } finally {
        inFlight -= 1;
      }
    });
    const info = makeInfo({
      capabilities: {
        ...makeInfo().capabilities,
        sessionTranscript: true,
        sessionTurnPresentation: true,
      },
    });
    const manager = new WebSessionManager({ client, workspace, info });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);
    await expect(manager.submitPrompt(pendingRun.goal)).resolves.toBe(true);

    const stepId = createStepId();
    const completedInvocationId = createToolInvocationId();
    for (let sequence = 1; sequence <= 97; sequence += 1) {
      stream.push(toolRequestedEvent(runningRun, stepId, sequence, `call-${String(sequence)}`));
    }
    stream.push(toolRequestedEvent(runningRun, stepId, 98, "call-settled", completedInvocationId));
    stream.push(toolStartedEvent(runningRun, stepId, 99, completedInvocationId));
    stream.push(toolCompletedEvent(runningRun, stepId, 100, completedInvocationId));
    await waitFor(() => manager.getSnapshot().timeline.lastDurableSequence === 100);
    await waitFor(() => targetedRequestCount === 1);

    expect(maxInFlight).toBe(1);
    expect(client.getSessionTurnPresentation).toHaveBeenLastCalledWith(session.id, {
      runId: pendingRun.id,
      limit: 1,
    });
    expect(manager.getSnapshot().turnPresentation?.turns.map((turn) => turn.runId)).toEqual([
      previousRun.id,
    ]);

    firstRefresh.resolve({ capabilityVersion: 3, turns: [activeTurn(99)] });
    await waitFor(() => targetedRequestCount === 2);
    await waitFor(() => manager.getSnapshot().turnPresentation?.turns.length === 2);
    expect(manager.getSnapshot().turnPresentation?.turns[0]).toEqual(previousTurn);
    expect(manager.getSnapshot().turnPresentation?.turns[1]).toMatchObject({
      runId: pendingRun.id,
      highWatermark: 99,
      items: [expect.objectContaining({ id: `optimistic:presentation:user:${pendingRun.id}` })],
    });
    expect(manager.getSnapshot().liveActivity.activities).toContainEqual(
      expect.objectContaining({
        kind: "TOOL_ACTIVITY",
        toolInvocationId: completedInvocationId,
        settledAtSequence: 100,
      }),
    );

    const canonicalUser = {
      id: `presentation:user:${pendingRun.id}`,
      runId: pendingRun.id,
      conversationTurnId: `turn:${pendingRun.id}`,
      ordinal: 0,
      status: "COMPLETED" as const,
      createdAt: pendingRun.createdAt,
      kind: "USER" as const,
      text: pendingRun.goal,
    };
    trailingRefresh.resolve({ capabilityVersion: 3, turns: [activeTurn(100, [canonicalUser])] });
    await waitFor(() => manager.getSnapshot().turnPresentation?.turns[1]?.highWatermark === 100);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(targetedRequestCount).toBe(2);
    expect(maxInFlight).toBe(1);
    expect(manager.getSnapshot().turnPresentation?.turns[1]?.items).toEqual([canonicalUser]);
    expect(manager.getSnapshot().liveActivity.activities).not.toContainEqual(
      expect.objectContaining({ toolInvocationId: completedInvocationId }),
    );
    manager.dispose();
    stream.close();
  });

  it("ignores an Active-turn response after switching Sessions", async () => {
    const firstSession = makeSession({ defaultWorkspace: workspace });
    const secondSession = makeSession({ defaultWorkspace: workspace });
    const firstRun = makeRun({
      sessionId: firstSession.id,
      status: "WAITING_RESOURCE",
      createdAt: 1,
    });
    const firstStream = new TestRunEventStream();
    const secondStream = new TestRunEventStream();
    const firstPresentation: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [],
    };
    const secondPresentation: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [],
    };
    const staleRefresh = deferred<SessionTurnPresentationResponseV3>();
    const client = makeClient({ sessions: [firstSession, secondSession] });
    client.listRuns.mockImplementation(async (sessionId: string) => ({
      items: sessionId === firstSession.id ? [firstRun] : [],
    }));
    client.watchRunEvents.mockImplementation((runId, options) => {
      options?.onOpen?.();
      return runId === firstRun.id ? firstStream : secondStream;
    });
    client.getSessionTurnPresentation.mockImplementation(async (sessionId, query) => {
      if (query?.runId !== undefined) return staleRefresh.promise;
      return sessionId === firstSession.id ? firstPresentation : secondPresentation;
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: {
          ...makeInfo().capabilities,
          sessionTranscript: true,
          sessionTurnPresentation: true,
        },
      }),
    });

    await manager.loadSessions();
    await expect(manager.selectSession(firstSession.id)).resolves.toBe(true);
    firstStream.push(toolRequestedEvent(firstRun, createStepId(), 1, "call-stale"));
    await waitFor(() =>
      client.getSessionTurnPresentation.mock.calls.some((call) => call[1]?.runId === firstRun.id),
    );

    await expect(manager.selectSession(secondSession.id)).resolves.toBe(true);
    staleRefresh.resolve({
      capabilityVersion: 3,
      turns: [
        {
          runId: firstRun.id,
          conversationTurnId: `turn:${firstRun.id}`,
          runStatus: "WAITING_RESOURCE",
          openedAt: firstRun.createdAt,
          highWatermark: 99,
          items: [],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getSnapshot().selectedSessionId).toBe(secondSession.id);
    expect(manager.getSnapshot().turnPresentation).toEqual(secondPresentation);
    manager.dispose();
    firstStream.close();
    secondStream.close();
  });

  it("ignores an old refresh after stream reconnect and runs one current-generation trailing read", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const activeRun = makeRun({ sessionId: session.id, status: "WAITING_RESOURCE" });
    const firstStream = new TestRunEventStream();
    const secondStream = new TestRunEventStream();
    const initialPresentation: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [
        {
          runId: activeRun.id,
          conversationTurnId: `turn:${activeRun.id}`,
          runStatus: "WAITING_RESOURCE",
          openedAt: activeRun.createdAt,
          highWatermark: 1,
          items: [],
        },
      ],
    };
    const oldRefresh = deferred<SessionTurnPresentationResponseV3>();
    const currentRefresh = deferred<SessionTurnPresentationResponseV3>();
    const timer = new TestTimer();
    let streamCount = 0;
    let refreshCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [activeRun]]]),
      turnPresentationResponse: initialPresentation,
    });
    client.listRuns.mockResolvedValue({ items: [activeRun] });
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      streamCount += 1;
      return streamCount === 1 ? firstStream : secondStream;
    });
    client.getSessionTurnPresentation.mockImplementation(async (_sessionId, query) => {
      if (query?.runId === undefined) return initialPresentation;
      refreshCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await (refreshCount === 1 ? oldRefresh.promise : currentRefresh.promise);
      } finally {
        inFlight -= 1;
      }
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      timer,
      info: makeInfo({
        capabilities: {
          ...makeInfo().capabilities,
          sessionTranscript: true,
          sessionTurnPresentation: true,
        },
      }),
    });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);
    firstStream.push(toolRequestedEvent(activeRun, createStepId(), 1, "call-reconnect"));
    await waitFor(() => refreshCount === 1);
    firstStream.close();
    await waitFor(() => timer.pendingCount === 1);
    timer.flush();
    await waitFor(() => streamCount === 2);

    oldRefresh.resolve({
      capabilityVersion: 3,
      turns: [
        {
          ...initialPresentation.turns[0]!,
          highWatermark: 4,
        },
      ],
    });
    await waitFor(() => refreshCount === 2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getSnapshot().turnPresentation).toEqual(initialPresentation);
    expect(maxInFlight).toBe(1);
    expect(client.getSessionTurnPresentation).toHaveBeenLastCalledWith(session.id, {
      runId: activeRun.id,
      limit: 1,
    });

    currentRefresh.resolve({
      capabilityVersion: 3,
      turns: [
        {
          ...initialPresentation.turns[0]!,
          highWatermark: 5,
        },
      ],
    });
    await waitFor(
      () =>
        manager.getSnapshot().turnPresentation?.capabilityVersion === 3 &&
        manager.getSnapshot().turnPresentation.turns[0]?.highWatermark === 5,
    );

    expect(maxInFlight).toBe(1);
    expect(manager.getSnapshot().turnPresentation?.turns[0]?.highWatermark).toBe(5);
    manager.dispose();
    firstStream.close();
    secondStream.close();
  });

  it("waits for an Active-turn read, then performs full-session presentation settlement at terminal", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const historyRun = makeCompletedRun(makeRun({ sessionId: session.id, createdAt: 1 }));
    const activeRun = makeRun({ sessionId: session.id, status: "WAITING_RESOURCE", createdAt: 2 });
    const completedRun = makeCompletedRun(activeRun);
    const stream = new TestRunEventStream();
    const historyTurn = {
      runId: historyRun.id,
      conversationTurnId: `turn:${historyRun.id}`,
      runStatus: "COMPLETED" as const,
      openedAt: historyRun.createdAt,
      highWatermark: 10,
      items: [],
    };
    const activeTurn = (highWatermark: number, runStatus: "WAITING_RESOURCE" | "COMPLETED") => ({
      runId: activeRun.id,
      conversationTurnId: `turn:${activeRun.id}`,
      runStatus,
      openedAt: activeRun.createdAt,
      ...(runStatus === "COMPLETED" ? { closedAt: completedRun.finishedAt } : {}),
      highWatermark,
      items: [],
    });
    const initialPresentation: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [historyTurn, activeTurn(1, "WAITING_RESOURCE")],
    };
    const terminalPresentation: SessionTurnPresentationResponseV3 = {
      capabilityVersion: 3,
      turns: [historyTurn, activeTurn(3, "COMPLETED")],
    };
    const targetedRefresh = deferred<SessionTurnPresentationResponseV3>();
    let fullSessionReadCount = 0;
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [activeRun]]]),
      turnPresentationResponse: initialPresentation,
    });
    client.listRuns.mockResolvedValue({ items: [activeRun] });
    client.getRun.mockResolvedValue(completedRun);
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      return stream;
    });
    client.getSessionTurnPresentation.mockImplementation(async (_sessionId, query) => {
      if (query?.runId !== undefined) return targetedRefresh.promise;
      fullSessionReadCount += 1;
      return fullSessionReadCount === 1 ? initialPresentation : terminalPresentation;
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: {
          ...makeInfo().capabilities,
          sessionTranscript: true,
          sessionTurnPresentation: true,
        },
      }),
    });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);
    expect(manager.getSnapshot().activeRun?.id).toBe(activeRun.id);
    expect(client.watchRunEvents).toHaveBeenCalledTimes(1);
    client.listRuns.mockResolvedValue({ items: [completedRun] });
    stream.push(toolRequestedEvent(activeRun, createStepId(), 1, "call-terminal"));
    stream.push(lifecycleEvent("run.completed", activeRun));
    await waitFor(() => manager.getSnapshot().timeline.lastDurableSequence === 1);
    await waitFor(() => client.getSessionTurnPresentation.mock.calls.length === 2);
    await waitFor(() => client.getRun.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.getSessionTurnPresentation).toHaveBeenNthCalledWith(1, session.id, {
      limit: 100,
    });
    expect(client.getSessionTurnPresentation).toHaveBeenNthCalledWith(2, session.id, {
      runId: activeRun.id,
      limit: 1,
    });
    expect(fullSessionReadCount).toBe(1);

    targetedRefresh.resolve({
      capabilityVersion: 3,
      turns: [activeTurn(2, "WAITING_RESOURCE")],
    });
    await waitFor(() => client.getSessionTurnPresentation.mock.calls.length === 3);
    await waitFor(() => manager.getSnapshot().activeRun === undefined);

    expect(client.getSessionTurnPresentation).toHaveBeenNthCalledWith(3, session.id, {
      limit: 100,
    });
    expect(manager.getSnapshot().turnPresentation).toEqual(terminalPresentation);
    manager.dispose();
    stream.close();
  });

  it("keeps legacy presentation refreshes on the full-session path", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const activeRun = makeRun({ sessionId: session.id, status: "WAITING_RESOURCE" });
    const stream = new TestRunEventStream();
    const presentation: SessionTurnPresentationResponse = {
      capabilityVersion: 2,
      items: [
        {
          id: "canonical-legacy-user",
          runId: activeRun.id,
          conversationTurnId: activeRun.id,
          ordinal: 0,
          status: "COMPLETED",
          createdAt: activeRun.createdAt,
          kind: "USER",
          text: "canonical user text",
        },
      ],
      highWatermark: 4,
    };
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [activeRun]]]),
      turnPresentationResponse: presentation,
    });
    client.listRuns.mockResolvedValue({ items: [activeRun] });
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      return stream;
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: {
          ...makeInfo().capabilities,
          sessionTranscript: true,
          sessionTurnPresentation: true,
        },
      }),
    });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);
    stream.push(toolRequestedEvent(activeRun, createStepId(), 1, "legacy-call"));
    await waitFor(() => client.getSessionTurnPresentation.mock.calls.length >= 2);

    expect(
      client.getSessionTurnPresentation.mock.calls.every((call) => call[1]?.runId === undefined),
    ).toBe(true);
    expect(manager.getSnapshot().turnPresentation).toMatchObject({
      capabilityVersion: 2,
      highWatermark: 4,
      items: [
        expect.objectContaining({
          id: "canonical-legacy-user",
          runId: activeRun.id,
          kind: "USER",
          text: "canonical user text",
        }),
      ],
    });
    manager.dispose();
    stream.close();
  });

  it("rejects mixed turn presentation page versions without publishing partial data", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const run = makeCompletedRun(makeRun({ sessionId: session.id }));
    const firstItem = {
      id: "presentation:user-v1",
      runId: run.id,
      conversationTurnId: run.id,
      ordinal: 0,
      status: "COMPLETED" as const,
      createdAt: run.createdAt,
      kind: "USER" as const,
      text: "检查项目",
    };
    const secondItem = {
      id: "presentation:assistant-v2",
      runId: run.id,
      conversationTurnId: run.id,
      ordinal: 1,
      status: "COMPLETED" as const,
      createdAt: run.finishedAt ?? run.createdAt,
      kind: "ASSISTANT" as const,
      phase: "FINAL_ANSWER" as const,
      sourceStepId: createStepId(),
      text: "已完成检查。",
    };
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [run]]]),
    });
    client.getSessionTurnPresentation.mockImplementation(async (_sessionId, query) =>
      query?.cursor === "1"
        ? { capabilityVersion: 2, highWatermark: 8, items: [secondItem] }
        : {
            capabilityVersion: 1,
            highWatermark: 8,
            items: [firstItem],
            nextCursor: "1",
          },
    );
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: { ...makeInfo().capabilities, sessionTurnPresentation: true },
      }),
    });

    await manager.loadSessions();
    await expect(
      (
        manager as unknown as {
          loadSessionTurnPresentation(sessionId: typeof session.id): Promise<unknown>;
        }
      ).loadSessionTurnPresentation(session.id),
    ).rejects.toBeInstanceOf(CaelushProtocolCompatibilityError);
    await expect(manager.selectSession(session.id)).resolves.toBe(false);

    expect(manager.getSnapshot().status).toBe("ERROR");
    expect(manager.getSnapshot().turnPresentation).toBeUndefined();
    manager.dispose();
  });

  it("loads every transcript page for the compatibility view", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const run = makeCompletedRun(makeRun({ sessionId: session.id }));
    const firstItem = userTranscript(run, "检查项目");
    const secondItem = assistantTranscript(run, "已完成检查");
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [run]]]),
    });
    client.getSessionTranscript.mockImplementation(async (_sessionId, query) =>
      query?.cursor === "1" ? { items: [secondItem] } : { items: [firstItem], nextCursor: "1" },
    );
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);

    expect(client.getSessionTranscript).toHaveBeenNthCalledWith(1, session.id, { limit: 100 });
    expect(client.getSessionTranscript).toHaveBeenNthCalledWith(2, session.id, {
      limit: 100,
      cursor: "1",
    });
    expect(manager.getSnapshot().history).toEqual([firstItem, secondItem]);
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
      yield* [] as PublicRunEvent[];
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
    expect(snapshot.timeline.settled).not.toContainEqual(
      expect.objectContaining({ kind: "REASONING", text: "Inspecting the workspace." }),
    );
    expect(snapshot.liveActivity.activities).toContainEqual(
      expect.objectContaining({ kind: "MODEL_REASONING", text: "Inspecting the workspace." }),
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

  it("reduces 1000 stream deltas immediately and publishes their latest snapshot once per frame", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id });
    const runningRun = makeRun({ ...pendingRun, status: "RUNNING" });
    const stream = new TestRunEventStream();
    const frameScheduler = new TestFrameScheduler();
    const client = makeClient({ createSessionResult: session, createRunResult: pendingRun });
    client.startRun.mockResolvedValue(actionResponse(runningRun, pendingRun.id));
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      return stream;
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo(),
      frameScheduler,
    });
    manager.beginDraft();
    const listener = vi.fn();
    manager.subscribe(listener);

    await expect(manager.submitPrompt("stream a bounded answer")).resolves.toBe(true);
    const notificationsBeforeStream = listener.mock.calls.length;
    const chunks = ["A", "B", "C", ...Array.from({ length: 997 }, () => "x")];
    chunks.forEach((text, index) => stream.push(textDeltaEvent(runningRun, index + 1, text)));
    await waitFor(() => modelText(manager.getSnapshot()) === chunks.join(""));

    expect(modelText(manager.getSnapshot())).toBe(chunks.join(""));
    expect(frameScheduler.scheduleCount).toBe(1);
    expect(frameScheduler.pendingCount).toBe(1);
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeStream);

    frameScheduler.flushNext();

    expect(listener).toHaveBeenCalledTimes(notificationsBeforeStream + 1);
    expect(modelText(listener.mock.lastCall?.[0] as ReturnType<typeof manager.getSnapshot>)).toBe(
      chunks.join(""),
    );
    manager.dispose();
    stream.close();
  });

  it("publishes two stream batches once each when separated by frame flushes", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id });
    const runningRun = makeRun({ ...pendingRun, status: "RUNNING" });
    const stream = new TestRunEventStream();
    const frameScheduler = new TestFrameScheduler();
    const client = makeClient({ createSessionResult: session, createRunResult: pendingRun });
    client.startRun.mockResolvedValue(actionResponse(runningRun, pendingRun.id));
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      return stream;
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo(),
      frameScheduler,
    });
    manager.beginDraft();
    const listener = vi.fn();
    manager.subscribe(listener);
    await expect(manager.submitPrompt("stream two batches")).resolves.toBe(true);
    const notificationsBeforeStream = listener.mock.calls.length;

    for (let index = 1; index <= 500; index += 1) {
      stream.push(textDeltaEvent(runningRun, index, "x"));
    }
    await waitFor(() => modelText(manager.getSnapshot()).length === 500);
    expect(frameScheduler.pendingCount).toBe(1);
    frameScheduler.flushNext();
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeStream + 1);

    for (let index = 501; index <= 1000; index += 1) {
      stream.push(textDeltaEvent(runningRun, index, "x"));
    }
    await waitFor(() => modelText(manager.getSnapshot()).length === 1000);
    expect(frameScheduler.pendingCount).toBe(1);
    frameScheduler.flushNext();

    expect(frameScheduler.scheduleCount).toBe(2);
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeStream + 2);
    expect(modelText(manager.getSnapshot())).toBe("x".repeat(1000));
    manager.dispose();
    stream.close();
  });

  it("lets durable Tool admission immediately publish pending text and hand off preparation", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id });
    const runningRun = makeRun({ ...pendingRun, status: "RUNNING" });
    const stream = new TestRunEventStream();
    const frameScheduler = new TestFrameScheduler();
    const client = makeClient({ createSessionResult: session, createRunResult: pendingRun });
    client.startRun.mockResolvedValue(actionResponse(runningRun, pendingRun.id));
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      return stream;
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo(),
      frameScheduler,
    });
    manager.beginDraft();
    const listener = vi.fn();
    manager.subscribe(listener);
    await expect(manager.submitPrompt("prepare a file edit")).resolves.toBe(true);
    const notificationsBeforeStream = listener.mock.calls.length;
    const callId = `call-${runningRun.id}`;
    const stepId = createStepId();
    stream.push(textDeltaEvent(runningRun, 1, "A"));
    stream.push(textDeltaEvent(runningRun, 2, "B"));
    stream.push(toolPreparationEvent(runningRun, stepId, callId));
    await waitFor(() =>
      manager
        .getSnapshot()
        .liveActivity.activities.some((activity) => activity.kind === "TOOL_PREPARATION"),
    );
    expect(frameScheduler.pendingCount).toBe(1);

    const callNotificationsBeforeDurable = listener.mock.calls.length;
    stream.push(toolRequestedEvent(runningRun, stepId, 1, callId));
    await waitFor(() => manager.getSnapshot().timeline.activeTools.length === 1);

    expect(listener.mock.calls.length).toBe(callNotificationsBeforeDurable + 1);
    expect(modelText(manager.getSnapshot())).toBe("AB");
    expect(manager.getSnapshot().liveActivity.activities).toContainEqual(
      expect.objectContaining({ kind: "TOOL_ACTIVITY", toolPhase: "REQUESTED" }),
    );
    expect(manager.getSnapshot().liveActivity.activities).not.toContainEqual(
      expect.objectContaining({ kind: "TOOL_PREPARATION" }),
    );
    frameScheduler.flushStale();
    expect(listener).toHaveBeenCalledTimes(callNotificationsBeforeDurable + 1);
    stream.push(textDeltaEvent(runningRun, 3, "C"));
    await waitFor(() => modelText(manager.getSnapshot()) === "ABC");
    expect(frameScheduler.scheduleCount).toBe(2);
    frameScheduler.flushStale();
    expect(listener).toHaveBeenCalledTimes(callNotificationsBeforeDurable + 1);
    frameScheduler.flushNext();
    expect(listener).toHaveBeenCalledTimes(callNotificationsBeforeDurable + 2);
    expect(modelText(manager.getSnapshot())).toBe("ABC");
    expect(notificationsBeforeStream).toBeGreaterThan(0);
    manager.dispose();
    stream.close();
  });

  it("invalidates a pending stream publication on disposal", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id });
    const runningRun = makeRun({ ...pendingRun, status: "RUNNING" });
    const stream = new TestRunEventStream();
    const frameScheduler = new TestFrameScheduler();
    const client = makeClient({ createSessionResult: session, createRunResult: pendingRun });
    client.startRun.mockResolvedValue(actionResponse(runningRun, pendingRun.id));
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      return stream;
    });
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo(),
      frameScheduler,
    });
    manager.beginDraft();
    const listener = vi.fn();
    manager.subscribe(listener);
    await expect(manager.submitPrompt("dispose a pending frame")).resolves.toBe(true);
    const notificationsBeforeStream = listener.mock.calls.length;
    stream.push(textDeltaEvent(runningRun, 1, "pending"));
    await waitFor(() => modelText(manager.getSnapshot()) === "pending");
    expect(frameScheduler.pendingCount).toBe(1);

    manager.dispose();
    expect(frameScheduler.pendingCount).toBe(0);
    frameScheduler.flushStale();

    expect(listener).toHaveBeenCalledTimes(notificationsBeforeStream);
    stream.close();
  });

  it("publishes ordinary submission state immediately without waiting for a stream frame", async () => {
    const manager = new WebSessionManager({
      client: makeClient(),
      workspace,
      info: makeInfo(),
      frameScheduler: new TestFrameScheduler(),
    });
    manager.beginDraft();
    const listener = vi.fn();
    manager.subscribe(listener);

    const submission = manager.submitPrompt("ordinary local state");

    expect(listener).toHaveBeenCalled();
    expect(listener.mock.lastCall?.[0].submission).toBe("SUBMITTING");
    await submission;
    manager.dispose();
  });

  it("prunes live activity using the active Run's V3 event watermark", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id, goal: "persist the execution feed" });
    const completedRun = makeCompletedRun(pendingRun);
    const earlierRunId = createRunId();
    const terminalEvent = {
      type: "run.completed",
      eventId: "evt_00000000-0000-7000-8000-000000000012",
      schemaVersion: 1,
      runId: pendingRun.id,
      sessionId: pendingRun.sessionId,
      timestamp: 2,
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1, sequence: 8 },
      payload: { result: { status: "COMPLETED" } },
    } as PublicRunEvent;
    const client = makeClient({
      createSessionResult: session,
      createRunResult: pendingRun,
      watchEvents: [reasoningEvent(pendingRun, "temporary live copy"), terminalEvent],
      turnPresentationResponse: {
        capabilityVersion: 3,
        turns: [
          {
            runId: earlierRunId,
            conversationTurnId: "earlier-turn",
            runStatus: "COMPLETED",
            openedAt: createTimestampMs(Number(pendingRun.createdAt) - 1),
            closedAt: createTimestampMs(Number(pendingRun.createdAt) - 1),
            highWatermark: 85,
            items: [],
          },
          {
            runId: pendingRun.id,
            conversationTurnId: "active-turn",
            runStatus: "COMPLETED",
            openedAt: pendingRun.createdAt,
            closedAt: completedRun.finishedAt,
            highWatermark: 7,
            items: [],
          },
        ],
      },
    });
    client.getRun.mockResolvedValue(completedRun);
    client.listRuns.mockResolvedValue({ items: [completedRun] });
    client.startRun.mockResolvedValue(
      actionResponse(makeRun({ ...pendingRun, status: "RUNNING" }), pendingRun.id),
    );
    const manager = new WebSessionManager({
      client,
      workspace,
      info: makeInfo({
        capabilities: { ...makeInfo().capabilities, sessionTurnPresentation: true },
      }),
    });

    manager.beginDraft();
    await expect(manager.submitPrompt("persist the execution feed")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().submission === "IDLE");

    expect(manager.getSnapshot().turnPresentation).toMatchObject({
      capabilityVersion: 3,
      turns: [{ highWatermark: 85 }, { runId: pendingRun.id, highWatermark: 7 }],
    });
    expect(manager.getSnapshot().liveActivity.activities).toHaveLength(1);
    expect(manager.getSnapshot().liveActivity.activities[0]).toMatchObject({
      status: "COMPLETED",
      settledAtSequence: 8,
    });
    manager.dispose();
  });

  it("resets Timeline when terminal settlement selects a different active Run", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const terminalRun = makeRun({ sessionId: session.id, goal: "first task" });
    const otherRun = makeRun({ sessionId: session.id, goal: "second task", status: "RUNNING" });
    const completedRun = makeCompletedRun(terminalRun);
    const client = makeClient({
      createSessionResult: session,
      createRunResult: terminalRun,
      watchEvents: [
        reasoningEvent(terminalRun, "Finishing the first task."),
        lifecycleEvent("run.completed", terminalRun),
      ],
    });
    client.getRun.mockResolvedValue(completedRun);
    client.listRuns.mockResolvedValue({ items: [completedRun, otherRun] });
    client.startRun.mockResolvedValue(
      actionResponse(makeRun({ ...terminalRun, status: "RUNNING" }), terminalRun.id),
    );
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    manager.beginDraft();
    await expect(manager.submitPrompt("first task")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().submission === "IDLE");

    expect(manager.getSnapshot().activeRun?.id).toBe(otherRun.id);
    expect(manager.getSnapshot().timeline).toMatchObject({
      runId: otherRun.id,
      settled: [],
      activeTools: [],
      activeLlm: [],
      activeProcesses: [],
      activeApprovals: [],
      retries: [],
      verification: [],
      currentPlan: [],
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
    client.getSessionTranscript.mockResolvedValue({
      items: [
        userTranscript(previousRun, "previous task"),
        assistantTranscript(previousRun, "verified answer", "history:assistant"),
      ],
    });
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      yield* [] as PublicRunEvent[];
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);

    await expect(manager.submitPrompt("next task")).resolves.toBe(true);

    expect(manager.getSnapshot().history).toEqual([
      {
        id: `history:user:${previousRun.id}`,
        conversationTurnId: previousRun.id,
        createdAt: previousRun.createdAt,
        kind: "USER",
        text: "previous task",
        runId: previousRun.id,
      },
      {
        id: `history:assistant:${previousRun.id}`,
        conversationTurnId: previousRun.id,
        createdAt: previousRun.finishedAt,
        kind: "ASSISTANT",
        text: "verified answer",
        runId: previousRun.id,
      },
      {
        id: `optimistic:user:${nextRun.id}`,
        conversationTurnId: nextRun.id,
        createdAt: nextRun.createdAt,
        kind: "USER",
        text: "next task",
        runId: nextRun.id,
      },
    ]);
    manager.dispose();
  });

  it("publishes the optimistic user before waiting for the V3 presentation refresh", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const run = makeRun({ sessionId: session.id, goal: "show immediately" });
    const client = makeClient({ createSessionResult: session, createRunResult: run });
    let resolvePresentation!: (response: SessionTurnPresentationResponseV3) => void;
    const presentationPromise = new Promise<SessionTurnPresentationResponseV3>((resolve) => {
      resolvePresentation = resolve;
    });
    client.getSessionTurnPresentation.mockImplementation(async () => presentationPromise);
    const info = makeInfo({
      capabilities: {
        ...makeInfo().capabilities,
        sessionTranscript: true,
        sessionTurnPresentation: true,
      },
    });
    const manager = new WebSessionManager({ client, workspace, info });
    manager.beginDraft();

    const submission = manager.submitPrompt("show immediately");
    await waitFor(() =>
      manager.getSnapshot().history.some((entry) => entry.id === `optimistic:user:${run.id}`),
    );

    expect(manager.getSnapshot().history).toContainEqual(
      expect.objectContaining({
        id: `optimistic:user:${run.id}`,
        runId: run.id,
        kind: "USER",
        text: "show immediately",
      }),
    );
    expect(manager.getSnapshot().turnPresentation).toBeUndefined();

    resolvePresentation({ capabilityVersion: 3, turns: [] });
    await expect(submission).resolves.toBe(true);
    expect(
      manager.getSnapshot().history.some((entry) => entry.id === `optimistic:user:${run.id}`),
    ).toBe(true);
    expect(manager.getSnapshot().turnPresentation).toEqual({ capabilityVersion: 3, turns: [] });
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

  it("allows navigation away from an active Run without cancelling it", async () => {
    const activeSession = makeSession({ defaultWorkspace: workspace, workspaceId: workspace.id });
    const otherSession = makeSession({ defaultWorkspace: workspace, workspaceId: workspace.id });
    const activeRun = makeRun({ sessionId: activeSession.id, status: "RUNNING" });
    const summaries: readonly WorkspaceSessionSummary[] = [
      { session: activeSession, latestRun: activeRun, lastActivityAt: 2 },
      { session: otherSession, lastActivityAt: 1 },
    ];
    const stream = new TestRunEventStream();
    const frameScheduler = new TestFrameScheduler();
    const client = makeClient({
      latestRuns: new Map([[activeSession.id, [activeRun]]]),
    });
    client.listWorkspaceSessions = vi.fn(async () => ({ items: summaries }));
    client.listRuns.mockImplementation(async (sessionId: string) => ({
      items: sessionId === activeSession.id ? [activeRun] : [],
    }));
    client.cancelRun.mockResolvedValue(actionResponse(activeRun, activeRun.id));
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      return stream;
    });

    const manager = new WebSessionManager({ client, workspace, info: makeInfo(), frameScheduler });
    await manager.loadSessions();
    await expect(manager.selectSession(activeSession.id)).resolves.toBe(true);
    const listener = vi.fn();
    manager.subscribe(listener);
    const notificationsBeforeStream = listener.mock.calls.length;
    stream.push(textDeltaEvent(activeRun, 1, "old Session text"));
    await waitFor(() => modelText(manager.getSnapshot()) === "old Session text");
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeStream);
    expect(frameScheduler.pendingCount).toBe(1);

    await expect(manager.selectSession(otherSession.id)).resolves.toBe(true);
    const notificationsAfterSwitch = listener.mock.calls.length;

    expect(manager.getSnapshot().selectedSessionId).toBe(otherSession.id);
    expect(modelText(manager.getSnapshot())).toBe("");
    expect(frameScheduler.pendingCount).toBe(0);
    expect(client.cancelRun).not.toHaveBeenCalled();
    expect(client.listSessions).not.toHaveBeenCalled();
    expect(client.listWorkspaceSessions).toHaveBeenCalledTimes(1);
    frameScheduler.flushStale();
    expect(listener).toHaveBeenCalledTimes(notificationsAfterSwitch);
    manager.dispose();
    stream.close();
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

  it("keeps a lost stream in the reconnect lifecycle without exposing its raw error", async () => {
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
      yield* [] as PublicRunEvent[];
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    await manager.selectSession(session.id);

    await expect(manager.submitPrompt("stream task")).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().transportState === "RECONNECTING");

    expect(manager.getSnapshot().error).toBeUndefined();
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

  it("restores persisted context usage whenever a completed Session is selected again", async () => {
    const firstSession = makeSession({ defaultWorkspace: workspace });
    const secondSession = makeSession({ defaultWorkspace: workspace });
    const firstRun = makeCompletedRun(
      makeRun({ sessionId: firstSession.id, createdAt: 1, goal: "first completed task" }),
    );
    const secondRun = makeCompletedRun(
      makeRun({ sessionId: secondSession.id, createdAt: 2, goal: "second completed task" }),
    );
    const firstUsage = makeContextUsage(firstRun, 320);
    const secondUsage = makeContextUsage(secondRun, 640);
    const client = makeClient({
      sessions: [firstSession, secondSession],
      latestRuns: new Map([
        [firstSession.id, [firstRun]],
        [secondSession.id, [secondRun]],
      ]),
    });
    client.getRunContextUsage.mockImplementation(async (runId) => {
      if (runId === firstRun.id) return firstUsage;
      if (runId === secondRun.id) return secondUsage;
      return null;
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    await manager.loadSessions();
    await expect(manager.selectSession(firstSession.id)).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().contextUsage?.runId === firstRun.id);
    expect(manager.getSnapshot().contextUsage).toEqual(firstUsage);

    await expect(manager.selectSession(secondSession.id)).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().contextUsage?.runId === secondRun.id);
    expect(manager.getSnapshot().contextUsage).toEqual(secondUsage);

    await expect(manager.selectSession(firstSession.id)).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().contextUsage?.runId === firstRun.id);
    expect(manager.getSnapshot().contextUsage).toEqual(firstUsage);
    expect(client.getRunContextUsage.mock.calls.map(([runId]) => runId)).toEqual([
      firstRun.id,
      secondRun.id,
      firstRun.id,
    ]);
    manager.dispose();
  });

  it("does not let a delayed completed-Session usage response overwrite the newly selected Session", async () => {
    const firstSession = makeSession({ defaultWorkspace: workspace });
    const secondSession = makeSession({ defaultWorkspace: workspace });
    const firstRun = makeCompletedRun(makeRun({ sessionId: firstSession.id, createdAt: 1 }));
    const secondRun = makeCompletedRun(makeRun({ sessionId: secondSession.id, createdAt: 2 }));
    const firstUsage = makeContextUsage(firstRun, 320);
    const secondUsage = makeContextUsage(secondRun, 640);
    let resolveFirstUsage: ((usage: ContextUsageProjection) => void) | undefined;
    const client = makeClient({
      sessions: [firstSession, secondSession],
      latestRuns: new Map([
        [firstSession.id, [firstRun]],
        [secondSession.id, [secondRun]],
      ]),
    });
    client.getRunContextUsage.mockImplementation((runId) => {
      if (runId === firstRun.id) {
        return new Promise<ContextUsageProjection>((resolve) => {
          resolveFirstUsage = resolve;
        });
      }
      return Promise.resolve(secondUsage);
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    await manager.loadSessions();
    await expect(manager.selectSession(firstSession.id)).resolves.toBe(true);
    await waitFor(() => client.getRunContextUsage.mock.calls.length === 1);
    await expect(manager.selectSession(secondSession.id)).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().contextUsage?.runId === secondRun.id);

    resolveFirstUsage?.(firstUsage);
    await Promise.resolve();

    expect(manager.getSnapshot().contextUsage).toEqual(secondUsage);
    manager.dispose();
  });

  it("throttles context usage refreshes after public lifecycle activity", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id });
    const runningRun = makeRun({ ...pendingRun, status: "RUNNING" });
    const timer = new TestTimer();
    const client = makeClient({
      createSessionResult: session,
      createRunResult: pendingRun,
      contextUsage: { runId: runningRun.id },
    });
    client.startRun.mockResolvedValue(actionResponse(runningRun, runningRun.id));
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      yield lifecycleEvent("llm.started", runningRun);
      await new Promise<void>(() => undefined);
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo(), timer });
    manager.beginDraft();

    await expect(manager.submitPrompt("refresh context safely")).resolves.toBe(true);
    expect(client.getRunContextUsage).not.toHaveBeenCalled();

    timer.flush();
    await waitFor(() => client.getRunContextUsage.mock.calls.length === 1);
    await waitFor(() => manager.getSnapshot().contextUsage?.runId === runningRun.id);
    expect(manager.getSnapshot().contextUsage).toMatchObject({ runId: runningRun.id });
    manager.dispose();
  });

  it("reconciles terminal usage once more when durable coverage first remains PARTIAL", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const pendingRun = makeRun({ sessionId: session.id, goal: "finish usage accounting" });
    const runningRun = makeRun({ ...pendingRun, status: "RUNNING" });
    const completedRun = makeCompletedRun(pendingRun);
    const partial = makeUsageCoverage(completedRun, 20, 19);
    const reported = makeUsageCoverage(completedRun, 20, 20);
    const timer = new TestTimer();
    const client = makeClient({ createSessionResult: session, createRunResult: pendingRun });
    client.getRun.mockResolvedValue(completedRun);
    client.listRuns.mockResolvedValue({ items: [completedRun] });
    client.startRun.mockResolvedValue(actionResponse(runningRun, runningRun.id));
    let usageRead = 0;
    client.getRunContextUsage.mockImplementation(async () =>
      usageRead++ === 0 ? partial : reported,
    );
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      yield lifecycleEvent("run.completed", completedRun);
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo(), timer });
    manager.beginDraft();

    await expect(manager.submitPrompt("finish usage accounting")).resolves.toBe(true);
    await waitFor(() => client.getRunContextUsage.mock.calls.length === 1);
    expect(manager.getSnapshot().activeRun).toBeUndefined();
    expect(manager.getSnapshot().contextUsage?.promptCache?.metricsV2?.usageCoverage).toMatchObject(
      {
        completeCacheUsageCount: 19,
        missingInvocationRecordCount: 1,
        status: "PARTIAL",
      },
    );

    timer.flush();
    await waitFor(() => client.getRunContextUsage.mock.calls.length === 2);
    await waitFor(
      () =>
        manager.getSnapshot().contextUsage?.promptCache?.metricsV2?.usageCoverage?.status ===
        "REPORTED",
    );

    expect(manager.getSnapshot().contextUsage).toEqual(reported);
    expect(manager.getSnapshot().contextUsage?.promptCache?.metricsV2?.usageCoverage).toMatchObject(
      {
        observedRequestCount: 20,
        completeCacheUsageCount: 20,
        incompleteOrUnknownCount: 0,
        missingInvocationRecordCount: 0,
        status: "REPORTED",
      },
    );
    expect(client.createRun).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("reconciles terminal usage after a confirmed cancellation", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const runningRun = makeRun({ sessionId: session.id, status: "RUNNING" });
    const cancelledRun = makeRun({ ...runningRun, status: "CANCELLED", finishedAt: 4 });
    const usage = makeUsageCoverage(cancelledRun, 20, 20);
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [runningRun]]]),
    });
    client.listRuns.mockResolvedValue({ items: [runningRun] });
    client.cancelRun.mockResolvedValue(actionResponse(cancelledRun, runningRun.id));
    client.getRunContextUsage.mockResolvedValue(usage);
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      await new Promise<void>(() => undefined);
      yield* [] as PublicRunEvent[];
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);
    await expect(manager.cancelRun()).resolves.toBe(true);
    await waitFor(() => manager.getSnapshot().contextUsage?.runId === cancelledRun.id);

    expect(manager.getSnapshot()).toMatchObject({
      activeRun: undefined,
      composerEnabled: true,
      runs: [{ status: "CANCELLED" }],
      contextUsage: usage,
    });
    expect(client.getRunContextUsage).toHaveBeenCalledTimes(1);
    expect(client.getRunContextUsage).toHaveBeenCalledWith(cancelledRun.id);
    manager.dispose();
  });

  it("ignores a delayed live PARTIAL response after terminal REPORTED usage", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const runningRun = makeRun({ sessionId: session.id, status: "RUNNING" });
    const completedRun = makeCompletedRun(runningRun);
    const partial = makeUsageCoverage(completedRun, 20, 19);
    const reported = makeUsageCoverage(completedRun, 20, 20);
    const delayedLiveUsage = deferred<ContextUsageProjection>();
    const stream = new TestRunEventStream();
    const timer = new TestTimer();
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [runningRun]]]),
    });
    client.listRuns.mockResolvedValue({ items: [runningRun] });
    client.getRun.mockResolvedValue(completedRun);
    client.watchRunEvents.mockImplementation((_runId, options) => {
      options?.onOpen?.();
      return stream;
    });
    client.getRunContextUsage.mockImplementation(async () =>
      client.getRunContextUsage.mock.calls.length === 1 ? delayedLiveUsage.promise : reported,
    );
    const manager = new WebSessionManager({ client, workspace, info: makeInfo(), timer });

    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);
    timer.flush();
    await waitFor(() => client.getRunContextUsage.mock.calls.length === 1);

    client.listRuns.mockResolvedValue({ items: [completedRun] });
    stream.push(lifecycleEvent("run.completed", runningRun));
    await waitFor(() => client.getRunContextUsage.mock.calls.length === 2);
    await waitFor(
      () =>
        manager.getSnapshot().contextUsage?.promptCache?.metricsV2?.usageCoverage?.status ===
        "REPORTED",
    );
    delayedLiveUsage.resolve(partial);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getSnapshot().contextUsage).toEqual(reported);
    expect(manager.getSnapshot().contextUsage?.promptCache?.metricsV2?.usageCoverage).toMatchObject(
      {
        completeCacheUsageCount: 20,
        incompleteOrUnknownCount: 0,
        status: "REPORTED",
      },
    );
    manager.dispose();
    stream.close();
  });

  it("ignores a delayed context usage response after disposal", async () => {
    const session = makeSession({ defaultWorkspace: workspace });
    const activeRun = makeRun({ sessionId: session.id, status: "RUNNING" });
    const timer = new TestTimer();
    let resolveUsage: ((value: null) => void) | undefined;
    const client = makeClient({
      sessions: [session],
      latestRuns: new Map([[session.id, [activeRun]]]),
      contextUsage: new Promise((resolve) => {
        resolveUsage = resolve;
      }),
    });
    client.listRuns.mockResolvedValue({ items: [activeRun] });
    client.watchRunEvents.mockImplementation(async function* (_runId, options) {
      options?.onOpen?.();
      await new Promise<void>(() => undefined);
      yield* [] as PublicRunEvent[];
    });
    const manager = new WebSessionManager({ client, workspace, info: makeInfo(), timer });
    await manager.loadSessions();
    await expect(manager.selectSession(session.id)).resolves.toBe(true);
    timer.flush();
    await waitFor(() => client.getRunContextUsage.mock.calls.length === 1);
    manager.dispose();
    resolveUsage?.(null);
    await Promise.resolve();

    expect(manager.getSnapshot().contextUsage).toBeNull();
  });
});

function makeClient(
  options: {
    sessions?: readonly ClientAgentSession[];
    latestRuns?: Map<string, readonly ClientAgentRun[]>;
    createSessionResult?: ClientAgentSession;
    createRunResult?: ClientAgentRun;
    watchEvents?: readonly PublicRunEvent[];
    refreshedRuns?: readonly ClientAgentRun[];
    transcriptResponse?: SessionTranscriptResponse;
    continuityPreflight?: SessionContinuityPreflightResponse;
    turnPresentationResponse?: SessionTurnPresentationResponse;
    contextUsage?: ContextUsageProjection | Promise<ContextUsageProjection | null> | null;
  } = {},
): WebSessionClient & {
  readonly createSession: ReturnType<typeof vi.fn>;
  readonly createRun: ReturnType<typeof vi.fn>;
  readonly startRun: ReturnType<typeof vi.fn>;
  readonly getRun: ReturnType<typeof vi.fn>;
  readonly getSessionTranscript: ReturnType<typeof vi.fn>;
  readonly getSessionContinuityPreflight: ReturnType<typeof vi.fn>;
  readonly getSessionTurnPresentation: ReturnType<typeof vi.fn>;
  readonly watchRunEvents: ReturnType<typeof vi.fn>;
  readonly watchEvents: readonly PublicRunEvent[];
  readonly getRunContextUsage: ReturnType<typeof vi.fn>;
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
    getSessionTranscript: vi.fn(async () => options.transcriptResponse ?? { items: [] }),
    getSessionContinuityPreflight: vi.fn(
      async () => options.continuityPreflight ?? { status: "NO_OBVIOUS_GAP" },
    ),
    getSessionTurnPresentation: vi.fn(
      async () =>
        options.turnPresentationResponse ?? { capabilityVersion: 1, items: [], highWatermark: 0 },
    ),
    startRun: vi.fn(async (runId: string) =>
      actionResponse(options.createRunResult ?? makeRun(), runId),
    ),
    watchRunEvents: vi.fn(async function* (_runId: string, watchOptions?: WatchRunEventsOptions) {
      watchOptions?.onOpen?.();
      for (const event of options.watchEvents ?? []) yield event;
    }),
    watchEvents: options.watchEvents ?? [],
    getRunContextUsage: vi.fn(async () => (await options.contextUsage) ?? null),
    cancelRun: vi.fn(),
  } as unknown as WebSessionClient & {
    readonly createSession: ReturnType<typeof vi.fn>;
    readonly createRun: ReturnType<typeof vi.fn>;
    readonly startRun: ReturnType<typeof vi.fn>;
    readonly getRun: ReturnType<typeof vi.fn>;
    readonly getSessionTranscript: ReturnType<typeof vi.fn>;
    readonly getSessionContinuityPreflight: ReturnType<typeof vi.fn>;
    readonly getSessionTurnPresentation: ReturnType<typeof vi.fn>;
    readonly watchRunEvents: ReturnType<typeof vi.fn>;
    readonly watchEvents: readonly PublicRunEvent[];
    readonly getRunContextUsage: ReturnType<typeof vi.fn>;
    readonly cancelRun: ReturnType<typeof vi.fn>;
  };
  return client;
}

function userTranscript(run: ClientAgentRun, text: string): TranscriptEntry {
  return {
    id: `history:user:${run.id}`,
    runId: run.id,
    conversationTurnId: run.id,
    createdAt: run.createdAt,
    kind: "USER",
    text,
  };
}

function assistantTranscript(
  run: ClientAgentRun,
  text: string,
  idPrefix = "transcript:assistant",
): TranscriptEntry {
  return {
    id: `${idPrefix}:${run.id}`,
    runId: run.id,
    conversationTurnId: run.id,
    createdAt: run.finishedAt ?? run.createdAt,
    kind: "ASSISTANT",
    text,
  };
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
      sessionTranscript: true,
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

function makeContextUsage(
  run: ClientAgentRun,
  estimatedInputTokens: number,
): ContextUsageProjection {
  const effectiveInputLimitTokens = 800;
  return {
    runId: run.id,
    providerId: run.model.provider,
    modelId: run.model.model,
    profileSource: "CONFIGURATION",
    contextWindowTokens: 1_000,
    rawContextWindowTokens: 1_000,
    effectiveInputLimitTokens,
    estimatedInputTokens,
    usedRatio: estimatedInputTokens / effectiveInputLimitTokens,
    remainingTokens: effectiveInputLimitTokens - estimatedInputTokens,
    pressureState: "NORMAL",
    compactionCount: 0,
    lastBuildAt: 3,
    lastRecoveryStages: [],
    breakdown: {
      pinned: 20,
      checkpoint: 0,
      recentTail: estimatedInputTokens - 20,
      project: 0,
      files: 0,
      toolObservations: 0,
      memory: 0,
      systemTokens: 20,
      currentTurnTokens: estimatedInputTokens - 20,
      mandatoryTokens: 20,
    },
    updatedAt: 3,
    lastBuildStatus: "SUCCESS",
  };
}

function makeUsageCoverage(
  run: ClientAgentRun,
  observedRequestCount: number,
  completeCacheUsageCount: number,
): ContextUsageProjection {
  const incompleteOrUnknownCount = observedRequestCount - completeCacheUsageCount;
  const rate = {
    requestCount: observedRequestCount,
    hitTokens: 95,
    accountedTokens: 100,
    hitRate: 0.95,
  };
  return {
    ...makeContextUsage(run, 320),
    promptCache: {
      status: "WARM",
      sampleCount: completeCacheUsageCount,
      totalRequestCount: observedRequestCount,
      totalInputTokens: 100,
      totalOutputTokens: 0,
      hitTokens: 95,
      missTokens: 5,
      writeTokens: 0,
      unknownUsageCount: incompleteOrUnknownCount,
      expectedReusablePrefixTokens: 0,
      purposes: [],
      metricsV2: {
        fullRun: { mainAgent: rate, allPurposes: rate },
        warm: { mainAgent: rate, allPurposes: rate },
        rolling: { windowSize: 10, mainAgent: rate, allPurposes: rate },
        usageCoverage: {
          observedRequestCount,
          completeCacheUsageCount,
          incompleteOrUnknownCount,
          providerUsageUnreportedCount: 0,
          providerUsageWithoutCacheBreakdownCount: 0,
          failedOrCancelledWithoutUsageCount: 0,
          inProgressInvocationCount: 0,
          missingInvocationRecordCount: incompleteOrUnknownCount,
          legacyWithoutCacheBreakdownCount: 0,
          unidentifiedLegacySampleCount: 0,
          coverageRate:
            observedRequestCount === 0 ? undefined : completeCacheUsageCount / observedRequestCount,
          status:
            completeCacheUsageCount === observedRequestCount
              ? "REPORTED"
              : completeCacheUsageCount === 0
                ? "UNREPORTED"
                : "PARTIAL",
        },
      },
    },
  };
}

function lifecycleEvent(type: string, run: ClientAgentRun): PublicRunEvent {
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
  } as PublicRunEvent;
}

function textDeltaEvent(run: ClientAgentRun, sequence: number, text: string): PublicRunEvent {
  return {
    type: "model.text.delta",
    eventId: `evt_00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    timestamp: sequence,
    visibility: "USER_VISIBLE",
    durability: {
      kind: "EPHEMERAL",
      version: 1,
      deliveryClass: "ORDERED",
      streamKey: `model:text:${run.id}`,
      streamSequence: sequence,
    },
    payload: { text },
  } as PublicRunEvent;
}

function toolPreparationEvent(
  run: ClientAgentRun,
  stepId: ReturnType<typeof createStepId>,
  toolCallId: string,
): PublicRunEvent {
  return {
    type: "model.tool_call.started",
    eventId: "evt_00000000-0000-7000-8000-000000000201",
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    stepId,
    timestamp: 101,
    visibility: "USER_VISIBLE",
    durability: {
      kind: "EPHEMERAL",
      version: 1,
      deliveryClass: "ORDERED",
      streamKey: `model:tool-call:${run.id}:${stepId}:${toolCallId}`,
      streamSequence: 1,
    },
    payload: { toolCallId, toolName: "apply_patch" },
  } as PublicRunEvent;
}

function toolRequestedEvent(
  run: ClientAgentRun,
  stepId: ReturnType<typeof createStepId>,
  sequence: number,
  externalCallId: string,
  invocationId = createToolInvocationId(),
): PublicRunEvent {
  return {
    type: "tool.requested",
    eventId: `evt_00000000-0000-7000-8000-${String(300 + sequence).padStart(12, "0")}`,
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    stepId,
    timestamp: sequence,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    payload: {
      invocationId,
      toolName: "apply_patch",
      externalCallId,
      riskLevel: "HIGH",
    },
  } as PublicRunEvent;
}

function toolStartedEvent(
  run: ClientAgentRun,
  stepId: ReturnType<typeof createStepId>,
  sequence: number,
  invocationId: ReturnType<typeof createToolInvocationId>,
): PublicRunEvent {
  return {
    type: "tool.started",
    eventId: `evt_00000000-0000-7000-8000-${String(700 + sequence).padStart(12, "0")}`,
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    stepId,
    timestamp: sequence,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    payload: { invocationId, toolName: "apply_patch" },
  } as PublicRunEvent;
}

function toolCompletedEvent(
  run: ClientAgentRun,
  stepId: ReturnType<typeof createStepId>,
  sequence: number,
  invocationId: ReturnType<typeof createToolInvocationId>,
): PublicRunEvent {
  return {
    type: "tool.completed",
    eventId: `evt_00000000-0000-7000-8000-${String(900 + sequence).padStart(12, "0")}`,
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    stepId,
    timestamp: sequence,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    payload: {
      invocationId,
      observationId: "obs_0195f3a0-0000-7000-8000-000000000000",
    },
  } as PublicRunEvent;
}

function modelText(snapshot: ReturnType<WebSessionManager["getSnapshot"]>): string {
  return (
    snapshot.liveActivity.activities.find((activity) => activity.kind === "MODEL_TEXT")?.text ?? ""
  );
}

class TestFrameScheduler implements FrameScheduler {
  private nextHandle = 1;
  private readonly callbacks: Array<{
    readonly handle: FrameHandle;
    readonly callback: () => void;
    cancelled: boolean;
    flushed: boolean;
    staleFlushed: boolean;
  }> = [];
  scheduleCount = 0;

  get pendingCount(): number {
    return this.callbacks.filter((item) => !item.cancelled && !item.flushed).length;
  }

  schedule(callback: () => void): FrameHandle {
    const handle = { id: this.nextHandle++ };
    this.scheduleCount += 1;
    this.callbacks.push({
      handle,
      callback,
      cancelled: false,
      flushed: false,
      staleFlushed: false,
    });
    return handle;
  }

  cancel(handle: FrameHandle): void {
    const scheduled = this.callbacks.find((item) => item.handle === handle);
    if (scheduled !== undefined) scheduled.cancelled = true;
  }

  flushNext(): void {
    const scheduled = this.callbacks.find((item) => !item.cancelled && !item.flushed);
    if (scheduled === undefined) throw new Error("No pending frame callback to flush.");
    scheduled.flushed = true;
    scheduled.callback();
  }

  flushStale(): void {
    for (const scheduled of this.callbacks) {
      if (scheduled.cancelled && !scheduled.staleFlushed) {
        scheduled.staleFlushed = true;
        scheduled.callback();
      }
    }
  }
}

class TestRunEventStream implements AsyncIterable<PublicRunEvent> {
  private readonly queued: PublicRunEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<PublicRunEvent, undefined>) => void> = [];
  private closed = false;

  [Symbol.asyncIterator](): AsyncIterator<PublicRunEvent, undefined> {
    return this;
  }

  next(): Promise<IteratorResult<PublicRunEvent, undefined>> {
    const event = this.queued.shift();
    if (event !== undefined) return Promise.resolve({ done: false, value: event });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  push(event: PublicRunEvent): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.queued.push(event);
    else waiter({ done: false, value: event });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}

function reasoningEvent(run: ClientAgentRun, summary: string): PublicRunEvent {
  return {
    type: "model.reasoning_summary.delta",
    eventId: "evt_00000000-0000-7000-8000-000000000002",
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    timestamp: 1,
    visibility: "USER_VISIBLE",
    durability: {
      kind: "EPHEMERAL",
      version: 1,
      deliveryClass: "ORDERED",
      streamKey: `model:reasoning:${run.id}`,
      streamSequence: 1,
    },
    payload: { text: summary },
  } as PublicRunEvent;
}

function durableReasoningEvent(
  run: ClientAgentRun,
  eventId: string,
  sequence: number,
  summary: string,
): PublicRunEvent {
  return {
    type: "reasoning.summary",
    schemaVersion: 1,
    runId: run.id,
    sessionId: run.sessionId,
    timestamp: sequence,
    visibility: "USER_VISIBLE",
    eventId,
    durability: { kind: "DURABLE", sequence },
    payload: { summary },
  } as PublicRunEvent;
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

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class TestTimer implements Timer {
  private readonly callbacks: Array<() => void> = [];

  get pendingCount(): number {
    return this.callbacks.length;
  }

  schedule(_delayMs: number, callback: () => void) {
    this.callbacks.push(callback);
    return { cancel: () => undefined };
  }

  flush(): void {
    const callbacks = this.callbacks.splice(0);
    for (const callback of callbacks) callback();
  }
}
