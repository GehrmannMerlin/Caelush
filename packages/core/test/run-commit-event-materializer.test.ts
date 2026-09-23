import type { AIMessage } from "@caelush/ai";
import type { RunExecutionDirective, RunExecutionEffectResult } from "@caelush/agent";
import {
  AgentRunSchema,
  AgentStateSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type AgentRun,
  type AgentState,
  type AgentStep,
  type EventId,
  type StepId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createRunCommitEventMaterializer } from "../src/run-commit-event-materializer.js";
import { createRunControllerEventFactory } from "../src/run-controller-events.js";
import type {
  RunExecutionCommitView,
  RunExecutionSnapshotView,
} from "../src/run-execution-store.js";
import { createRunTransitionPlanner } from "@caelush/agent";

/**
 * The event materialization boundary.
 *
 * The assertion that matters is not "events were produced" — it is that *nothing else changed*. A
 * materializer that quietly recomputed a status, re-settled a Step or dropped a continuation would
 * still emit a plausible event list, and the only way to see it is to compare the commit with its
 * events removed against the commit the planner produced.
 */

const AT = createTimestampMs(1_000);
const NOW = createTimestampMs(1_100);
const RUN_ID = createRunId();
const SESSION_ID = createSessionId();
const STEP_ID: StepId = createStepId();

const MODEL_TURN = {
  callId: "llm_0195f3a0-0000-7000-8000-000000000000",
  model: { provider: "fixture", model: "fixture-model" },
  finishReason: "TOOL_CALLS" as const,
  assistantMessage: {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "reading" }],
  },
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
  return AgentStateSchema.parse({
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
  });
}

/** A RUNNING Run with an active Step — the Agent-turn shape. */
function activeStepSnapshot(
  overrides: Partial<RunExecutionSnapshotView> = {},
): RunExecutionSnapshotView {
  const run = overrides.run ?? makeRun({ currentStepId: STEP_ID });
  return {
    run,
    state: overrides.state ?? makeState(run, { currentStepId: STEP_ID }),
    stateRevision: 1,
    conversationRecords: [],
    activeStep:
      overrides.activeStep ??
      ({
        id: STEP_ID,
        runId: RUN_ID,
        sequence: 2,
        status: "RUNNING",
        startedAt: AT,
      } satisfies AgentStep),
    ...overrides,
  };
}

/**
 * A RUNNING Run at a boundary with no active Step.
 *
 * This is the shape a `FINALIZE` is planned from: the coordinator refuses to route a Run whose Step
 * is still open, so a terminal settlement always starts from a settled boundary.
 */
function runningBoundarySnapshot(
  overrides: Partial<RunExecutionSnapshotView> = {},
): RunExecutionSnapshotView {
  const run = overrides.run ?? makeRun();
  return {
    run,
    state: overrides.state ?? makeState(run),
    stateRevision: 1,
    continuationRevision: 1,
    conversationRecords: [],
    continuation: {
      type: "WAITING_TOOL_RESULTS",
      runId: run.id,
      sourceStepId: STEP_ID,
      pendingDecision: PENDING_DECISION,
    },
    ...overrides,
  };
}

/** A VERIFYING Run with a candidate waiting for its completion decision. */
function verifyingSnapshot(
  overrides: Partial<RunExecutionSnapshotView> = {},
): RunExecutionSnapshotView {
  const run = overrides.run ?? makeRun({ status: "VERIFYING" });
  return {
    run,
    state: overrides.state ?? makeState(run, { status: "VERIFYING" }),
    stateRevision: 1,
    continuationRevision: 1,
    conversationRecords: [],
    ...overrides,
  };
}

/** A monotonic, obviously-synthetic EventId factory, so ordering is attributable in a failure. */
function eventIds(): { create(): EventId; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    create: () => {
      const id =
        `evt_0195f3a0-0000-7000-8000-${String(GLOBAL_ID_SEQUENCE++).padStart(12, "0")}` as EventId;
      seen.push(id);
      return id;
    },
  };
}

/** One counter for the whole file: two materializations must not be able to collide. */
let GLOBAL_ID_SEQUENCE = 0;

const ASSISTANT_APPEND: AIMessage = {
  role: "assistant",
  content: [{ type: "text", text: "reading" }],
};

const AGENT_DIRECTIVE: RunExecutionDirective = {
  kind: "ADVANCE_AGENT",
  mode: "EXECUTE",
  reason: "INITIAL",
  input: { kind: "USER_INPUT", messages: [] },
};

/** Materialize a planned commit, and return everything worth asserting about. */
function materialize(
  snapshot: RunExecutionSnapshotView,
  directive: RunExecutionDirective,
  effect: RunExecutionEffectResult,
  /**
   * Whether a provider call happened. Defaults to a completed one, which is what the success
   * fixtures describe; a failure fixture states its own, because the materializer never infers it.
   */
  providerTurnState: "NOT_STARTED" | "COMPLETED" | "FAILED" | "CANCELLED" = "COMPLETED",
) {
  const planner = createRunTransitionPlanner();
  const planned = planner.plan({ snapshot, directive, effect, now: NOW }) as RunExecutionCommitView;
  const ids = eventIds();
  const materializer = createRunCommitEventMaterializer({
    eventFactory: createRunControllerEventFactory(),
  });
  const materialized = materializer.materialize({
    snapshot,
    directive,
    effect,
    plannedCommit: planned,
    now: NOW,
    // These fixtures describe turns whose provider call completed. Whether one did is a
    // Core-private fact the facade reports; the materializer never infers it.
    providerTurnState,
    ownership: { eventIds: { create: ids.create } },
  });
  return { planned, materialized, ids };
}

/** Everything the materializer is forbidden to touch. */
function withoutEvents(commit: RunExecutionCommitView): Omit<RunExecutionCommitView, "events"> {
  const { events, ...rest } = commit;
  // Reference the removed field so the intent is explicit to the linter as well as the reader.
  void events;
  return rest;
}

describe("Run commit event materializer", () => {
  it("leaves the planner's commit untouched except for its events", () => {
    const effect: RunExecutionEffectResult = {
      kind: "AGENT",
      result: {
        kind: "TOOL_REQUESTS",
        turn: { stepId: STEP_ID, sequence: 2 },
        modelTurn: MODEL_TURN,
        messagesToAppend: [ASSISTANT_APPEND],
        context: {
          report: {} as never,
          observationPolicy: { maxSingleObservationTokens: 1, maxObservationBatchTokens: 2 },
          recovery: "NONE",
        },
        decision: PENDING_DECISION,
      },
    };

    const { planned, materialized } = materialize(activeStepSnapshot(), AGENT_DIRECTIVE, effect);

    expect(planned.events).toEqual([]);
    expect(materialized.events.length).toBeGreaterThan(0);
    // The whole point: only `events` may differ.
    expect(withoutEvents(materialized)).toEqual(withoutEvents(planned));
  });

  it("describes the settled turn, then no status change when the Run stayed RUNNING", () => {
    const effect: RunExecutionEffectResult = {
      kind: "AGENT",
      result: {
        kind: "TOOL_REQUESTS",
        turn: { stepId: STEP_ID, sequence: 2 },
        modelTurn: MODEL_TURN,
        messagesToAppend: [ASSISTANT_APPEND],
        context: {
          report: {} as never,
          observationPolicy: { maxSingleObservationTokens: 1, maxObservationBatchTokens: 2 },
          recovery: "NONE",
        },
        decision: PENDING_DECISION,
      },
    };

    const { materialized } = materialize(activeStepSnapshot(), AGENT_DIRECTIVE, effect);
    expect(materialized.events.map((event) => event.type)).toEqual(["llm.completed"]);
    expect(materialized.events[0]).toMatchObject({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      stepId: STEP_ID,
      timestamp: NOW,
    });
  });

  it("orders a failure as error, status.changed, then the terminal event", () => {
    const effect: RunExecutionEffectResult = {
      kind: "AGENT",
      result: {
        kind: "FAILED",
        turn: { stepId: STEP_ID, sequence: 2 },
        error: { code: "INTERNAL_ERROR", message: "safe", retryable: false, phase: "RUNTIME" },
        messagesToAppend: [],
      },
    };

    const { materialized } = materialize(
      activeStepSnapshot(),
      AGENT_DIRECTIVE,
      effect,
      // The provider call itself failed, which is what makes this an `llm.failed`.
      "FAILED",
    );

    // Phase 11D's frozen failure order, produced by this boundary.
    expect(materialized.events.map((event) => event.type)).toEqual([
      "llm.failed",
      "error",
      "status.changed",
      "run.failed",
    ]);
    expect(materialized.events[2]).toMatchObject({
      type: "status.changed",
      payload: { from: "RUNNING", to: "FAILED" },
    });
  });

  it("records a completed provider turn even when the classifier refused its answer", () => {
    const effect: RunExecutionEffectResult = {
      kind: "AGENT",
      result: {
        kind: "FAILED",
        turn: { stepId: STEP_ID, sequence: 2 },
        error: {
          code: "MODEL_ERROR",
          message: "safe",
          retryable: false,
          phase: "LLM",
        },
        messagesToAppend: [],
      },
    };

    const { materialized } = materialize(
      activeStepSnapshot(),
      AGENT_DIRECTIVE,
      effect,
      "COMPLETED",
    );

    // The provider answered and the Reason still failed. The ledger records both, and it records
    // no reasoning summary: a refused answer has none to report.
    expect(materialized.events.map((event) => event.type)).toEqual([
      "llm.completed",
      "error",
      "status.changed",
      "run.failed",
    ]);
  });

  it("describes a cancellation and a timeout with their determined payloads", () => {
    const cancelled = materialize(
      runningBoundarySnapshot(),
      { kind: "FINALIZE", reason: "CANCELLED" },
      { kind: "NONE" },
    );
    expect(cancelled.materialized.events.map((event) => event.type)).toEqual([
      "status.changed",
      "run.cancelled",
    ]);
    expect(cancelled.materialized.events[1]).toMatchObject({
      type: "run.cancelled",
      payload: { reason: "USER_REQUESTED" },
    });

    const timeout = materialize(
      runningBoundarySnapshot(),
      { kind: "FINALIZE", reason: "TIMEOUT" },
      { kind: "NONE" },
    );
    expect(timeout.materialized.events.map((event) => event.type)).toEqual([
      "status.changed",
      "run.timed_out",
    ]);
    expect(timeout.materialized.events[1]).toMatchObject({
      type: "run.timed_out",
      payload: { deadlineAt: AT + 10_000 },
    });
  });

  it("emits status.changed alone where a verified payload would be required", () => {
    const snapshot = verifyingSnapshot();
    const { materialized } = materialize(
      snapshot,
      {
        kind: "EVALUATE_COMPLETION",
        mode: "RECOVER",
        sourceStepId: STEP_ID,
        candidate: { type: "FINAL_CANDIDATE", modelTurn: MODEL_TURN, candidateText: "reading" },
      },
      {
        kind: "COMPLETION",
        result: { kind: "ACCEPT", finalResult: { type: "TEXT", text: "done" } },
      },
    );

    // A general completion carries no `VerifiedRunFinalResult`, so `run.completed` is not
    // materialized. Claiming one would durably assert a seal nobody produced.
    expect(materialized.events.map((event) => event.type)).toEqual(["status.changed"]);
  });

  it("produces no events when the transition changes no status", () => {
    const snapshot = activeStepSnapshot({ run: makeRun({ status: "COMPLETED" }) });
    const { materialized } = materialize(snapshot, { kind: "RETURN_TERMINAL" }, { kind: "NONE" });
    expect(materialized.events).toEqual([]);
    expect(withoutEvents(materialized)).toEqual(withoutEvents({ ...materialized, events: [] }));
  });

  it("keeps the event semantic order stable while every EventId stays unique", () => {
    const effect: RunExecutionEffectResult = {
      kind: "AGENT",
      result: {
        kind: "FAILED",
        turn: { stepId: STEP_ID, sequence: 2 },
        error: { code: "INTERNAL_ERROR", message: "safe", retryable: false, phase: "RUNTIME" },
        messagesToAppend: [],
      },
    };

    const first = materialize(activeStepSnapshot(), AGENT_DIRECTIVE, effect);
    const second = materialize(activeStepSnapshot(), AGENT_DIRECTIVE, effect);

    const order = (commit: typeof first) =>
      commit.materialized.events.map((event) => `${event.type}:${JSON.stringify(event.payload)}`);
    expect(order(second)).toEqual(order(first));

    // Same semantics, different identities: the factory is the only id authority.
    const ids = [
      ...first.materialized.events.map((event) => event.eventId),
      ...second.materialized.events.map((event) => event.eventId),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
