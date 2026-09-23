import {
  agentMessageId,
  createRunTransitionPlanner,
  type RunExecutionDirective,
  type RunExecutionEffectResult,
} from "@caelush/agent";
import {
  createAssistantMessageAppend,
  createRunCommitEventMaterializer,
  createUserMessageAppend,
} from "@caelush/core";
import type { RunExecutionCommitView } from "@caelush/core";
import {
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type AgentRun,
  type AgentState,
  type AgentStep,
  type StepId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { makeSession } from "./support/fixtures.js";
import { testRunMessageAuthority } from "../../core/test/support/run-message-authority.js";

/**
 * The planned commit is one the durable store actually accepts.
 *
 * A planner is only as good as the commit it produces. This drives the real chain — plan, then
 * materialize, then commit through the real SQLite store — and reads the result back, which is what
 * proves the transition the planner described is one the durable invariant and the schema admit
 * rather than merely one a unit test liked.
 *
 * The RunController is deliberately not involved: Checkpoint 4 implements and tests the planner,
 * and the production cutover is Checkpoint 5.
 */

const AT = createTimestampMs(1_000);
const NOW = createTimestampMs(1_100);
const RUN_ID = createRunId();
const SESSION_ID = createSessionId();
const STEP_ID: StepId = createStepId();
const USER_MESSAGE_ID = agentMessageId("user-message");

const MODEL_TURN = {
  callId: "llm_0195f3a0-0000-7000-8000-000000000000",
  model: { provider: "fixture", model: "fixture-model" },
  finishReason: "TOOL_CALLS" as const,
  assistantMessage: {
    role: "assistant" as const,
    content: [
      { type: "text" as const, text: "reading" },
      {
        type: "tool-call" as const,
        toolCallId: "call_a",
        toolName: "read_file",
        input: { path: "a.ts" },
      },
    ],
  },
  usage: { inputTokens: 5, outputTokens: 3 },
};

const PENDING_DECISION = {
  type: "TOOL_CALLS_REQUESTED" as const,
  modelTurn: MODEL_TURN,
  toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } }],
};

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return AgentRunSchema.parse({
    id: RUN_ID,
    sessionId: SESSION_ID,
    goal: "inspect the project",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 10_000 },
    createdAt: AT,
    startedAt: AT,
    ...overrides,
  });
}

function makeState(run: AgentRun, overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: run.id,
    sessionId: run.sessionId,
    goal: run.goal,
    status: run.status === "PENDING" ? "PENDING" : run.status,
    workspace: run.workspace,
    runtime: run.runtime,
    permissionProfile: run.permissionProfile,
    approvalPolicy: run.approvalPolicy,
    plan: [],
    recentObservations: [],
    changedFiles: [],
    activeProcesses: [],
    errors: [],
    verification: "NOT_RUN",
    usage: { steps: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
    updatedAt: AT,
    startedAt: AT,
    ...overrides,
  };
}

function makeStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: STEP_ID,
    runId: RUN_ID,
    sequence: 2,
    status: "RUNNING",
    startedAt: AT,
    ...overrides,
  };
}

/** One planned + materialized + durably committed transition, driven end to end. */
async function commitPlanned(
  directive: RunExecutionDirective,
  effect: RunExecutionEffectResult,
  options: {
    readonly state?: AgentState;
    readonly activeStep?: AgentStep;
    /** Whether a provider call happened. Defaults to a completed one, the success shape. */
    readonly providerTurnState?: "NOT_STARTED" | "COMPLETED" | "FAILED" | "CANCELLED";
  } = {},
): Promise<{
  run: Awaited<ReturnType<typeof openCaelushStorage>>;
  status: string;
  eventTypes: readonly string[];
}> {
  const storage = await openCaelushStorage({ path: ":memory:" });
  const session = makeSession({ id: SESSION_ID });
  const pendingRun = makeRun({ status: "PENDING", startedAt: undefined });
  const run = makeRun(options.activeStep === undefined ? {} : { currentStepId: STEP_ID });
  const messages = testRunMessageAuthority({
    records: (runId) => storage.messageRecords.listByRun(runId),
  });
  // The Run and its AgentState are two projections of one fact, so the fixture must agree with
  // itself before the planner is asked to plan anything.
  const state =
    options.state ??
    makeState(run, options.activeStep === undefined ? {} : { currentStepId: STEP_ID });
  await storage.sessions.insert(session);
  await storage.runs.insert(pendingRun);
  await storage.execution.commit({
    run,
    state,
    expectedStateRevision: null,
    expectedContinuationRevision: null,
    stepWrites:
      options.activeStep === undefined ? [] : [{ operation: "INSERT", step: options.activeStep }],
    messagesToAppend: [createUserMessageAppend(messages, run, "GOAL")],
    events: [
      {
        eventId: createEventId(),
        schemaVersion: 1,
        runId: run.id,
        sessionId: SESSION_ID,
        timestamp: AT,
        visibility: "USER_VISIBLE",
        durability: { kind: "DURABLE", version: 1 },
        type: "run.started",
        payload: { goal: run.goal },
      },
    ],
  });

  const snapshot = await storage.execution.load(run.id);
  if (snapshot === null) throw new Error("fixture Run disappeared");

  const planned = createRunTransitionPlanner().plan({
    snapshot,
    directive,
    effect,
    now: NOW,
  }) as RunExecutionCommitView;

  const plannedWithMessages =
    effect.kind === "AGENT" && effect.result.kind === "TOOL_REQUESTS"
      ? {
          ...planned,
          messagesToAppend: [
            createAssistantMessageAppend(messages, run, STEP_ID, MODEL_TURN as never),
          ],
        }
      : planned;
  const materialized = createRunCommitEventMaterializer().materialize({
    snapshot,
    directive,
    effect,
    plannedCommit: plannedWithMessages,
    now: NOW,
    // These fixtures drive turns whose provider call completed; a failure fixture states its own.
    providerTurnState: options.providerTurnState ?? "COMPLETED",
    ownership: {
      eventIds: {
        create: () => createEventId(),
      },
    },
  });

  // The store is the authority: the commit the planner described must be admissible, unchanged.
  const committed = await storage.execution.commit(materialized);
  return {
    run: storage,
    status: committed.snapshot.run.status,
    eventTypes: committed.events.map((event) => event.type),
  };
}

describe("planned Run transition commit integration", () => {
  it("commits a planned AGENT TOOL_REQUESTS transition through the real store", async () => {
    const result = await commitPlanned(
      {
        kind: "ADVANCE_AGENT",
        mode: "EXECUTE",
        reason: "INITIAL",
        input: { kind: "USER_INPUT", userMessageId: USER_MESSAGE_ID },
      },
      {
        kind: "AGENT",
        result: {
          kind: "TOOL_REQUESTS",
          turn: { stepId: STEP_ID, sequence: 2 },
          modelTurn: MODEL_TURN,
          messagesToAppend: [{ role: "assistant", content: [{ type: "text", text: "reading" }] }],
          context: {
            report: {} as never,
            observationPolicy: { maxSingleObservationTokens: 1, maxObservationBatchTokens: 2 },
            recovery: "NONE",
          },
          decision: PENDING_DECISION,
        },
      },
      { activeStep: makeStep() },
    );

    expect(result.status).toBe("RUNNING");
    expect(result.eventTypes).toEqual(["llm.completed"]);

    const loaded = await result.run.execution.load(RUN_ID);
    expect(loaded?.continuation?.type).toBe("WAITING_TOOL_RESULTS");
    expect(loaded?.continuation).toMatchObject({
      sourceStepId: STEP_ID,
      observationPolicy: { maxSingleObservationTokens: 1, maxObservationBatchTokens: 2 },
    });
    // The attempt was durably settled: one more Step counted, with the turn's usage.
    expect(loaded?.state?.usage).toMatchObject({ steps: 2, inputTokens: 5, outputTokens: 3 });
    expect(loaded?.run.currentStepId).toBeUndefined();
    // The assistant message the turn produced is durable.
    expect(loaded?.conversationRecords.map((record) => record.messageType)).toEqual([
      "USER",
      "ASSISTANT",
    ]);
    await result.run.close();
  });

  it("commits a planned terminal failure and its materialized event order", async () => {
    const result = await commitPlanned(
      {
        kind: "ADVANCE_AGENT",
        mode: "EXECUTE",
        reason: "INITIAL",
        input: { kind: "USER_INPUT", userMessageId: USER_MESSAGE_ID },
      },
      {
        kind: "AGENT",
        result: {
          kind: "FAILED",
          turn: { stepId: STEP_ID, sequence: 2 },
          error: { code: "INTERNAL_ERROR", message: "safe", retryable: false, phase: "RUNTIME" },
          messagesToAppend: [],
        },
      },
      { activeStep: makeStep(), providerTurnState: "FAILED" },
    );

    expect(result.eventTypes).toEqual(["llm.failed", "error", "status.changed", "run.failed"]);

    const loaded = await result.run.execution.load(RUN_ID);
    expect(loaded?.run.status).toBe("FAILED");
    expect(loaded?.state?.status).toBe("FAILED");
    expect(loaded?.continuation).toBeUndefined();
    await result.run.close();
  });

  it("commits a planned tool-result acceptance onto the open continuation", async () => {
    // First open the boundary through the planner, then accept results through it again.
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession({ id: SESSION_ID });
    const pendingRun = makeRun({ status: "PENDING", startedAt: undefined });
    const run = makeRun();
    await storage.sessions.insert(session);
    await storage.runs.insert(pendingRun);
    await storage.execution.commit({
      run,
      state: makeState(run),
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [
        {
          operation: "INSERT",
          step: makeStep({ status: "COMPLETED", finishedAt: AT }),
        },
      ],
      messagesToAppend: [],
      continuation: {
        operation: "SET",
        checkpoint: {
          type: "WAITING_TOOL_RESULTS",
          runId: run.id,
          sourceStepId: STEP_ID,
          pendingDecision: PENDING_DECISION,
        },
        updatedAt: AT,
      },
      events: [],
    });

    const snapshot = await storage.execution.load(run.id);
    if (snapshot === null) throw new Error("fixture Run disappeared");
    const directive: RunExecutionDirective = {
      kind: "EXECUTE_TOOL_BATCH",
      mode: "EXECUTE",
      sourceStepId: STEP_ID,
      pendingDecision: PENDING_DECISION,
    };
    const effect: RunExecutionEffectResult = {
      kind: "TOOLS",
      result: {
        kind: "COMPLETED",
        results: [
          {
            externalCallId: "call_a",
            toolName: "read_file",
            content: "a.ts:1: hello",
            isError: false,
          },
        ],
      },
    };

    const planned = createRunTransitionPlanner().plan({
      snapshot,
      directive,
      effect,
      now: NOW,
    }) as RunExecutionCommitView;
    const materialized = createRunCommitEventMaterializer().materialize({
      snapshot,
      directive,
      effect,
      plannedCommit: planned,
      now: NOW,
      // These fixtures drive turns whose provider call completed.
      providerTurnState: "COMPLETED",
      ownership: { eventIds: { create: () => createEventId() } },
    });

    const committed = await storage.execution.commit(materialized);
    expect(committed.snapshot.run.status).toBe("RUNNING");
    expect(committed.snapshot.continuation).toMatchObject({
      type: "WAITING_TOOL_RESULTS",
      receivedResults: [
        {
          role: "tool",
          toolCallId: "call_a",
          toolName: "read_file",
          content: "a.ts:1: hello",
          isError: false,
        },
      ],
    });
    await storage.close();
  });
});
