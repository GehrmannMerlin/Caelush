import type { AIMessage } from "@caelush/ai";
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
  type StepId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { agentMessageId } from "../src/index.js";
import type { AgentLoopAdvanceResult } from "../src/loop/types.js";
import {
  createRunTransitionPlanner,
  planRunTransition,
} from "../src/run/default-run-transition-planner.js";
import type { RunExecutionDirective } from "../src/run/directive.js";
import type { RunExecutionEffectResult } from "../src/run/effect-result.js";
import { RunExecutionInvariantError } from "../src/run/ports/run-execution-store.js";
import type {
  RunExecutionCommit,
  RunExecutionSnapshot,
} from "../src/run/ports/run-execution-store.js";
import type { AgentToolResult, ToolTurnResult } from "../src/run/ports/tool-turn.js";
import type { RunTransitionPlanInput } from "../src/run/run-transition-planner.js";

/**
 * The pure Run transition planner, asserted as a branch matrix.
 *
 * Two things are being proved at once. The first is that every branch the frozen input *can*
 * express plans the transition the durable invariant admits. The second, and the more important
 * one, is that every branch it *cannot* express fails closed instead of inventing the identity it
 * is missing — a planner that fabricated a verification plan id or a retry time would be a second
 * authority over durable state, and no amount of green tests elsewhere would show it.
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

const OBSERVATION_POLICY = { maxSingleObservationTokens: 11, maxObservationBatchTokens: 22 };

const ASSISTANT_APPEND: AIMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "reading" },
    {
      type: "tool-call",
      toolCallId: "call_a",
      toolName: "read_file",
      input: { path: "a.ts" },
    },
  ],
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
    usage: { steps: 1, toolCalls: 1, inputTokens: 0, outputTokens: 0 },
    updatedAt: AT,
    startedAt: AT,
    ...overrides,
  });
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

/** A RUNNING Run with an open Tool boundary and no active Step — the Tool-turn shape. */
function toolBoundarySnapshot(overrides: Partial<RunExecutionSnapshot> = {}): RunExecutionSnapshot {
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
      observationPolicy: OBSERVATION_POLICY,
    },
    ...overrides,
  };
}

/** A RUNNING Run with an active Step — the Agent-turn shape. */
function activeStepSnapshot(overrides: Partial<RunExecutionSnapshot> = {}): RunExecutionSnapshot {
  const run = overrides.run ?? makeRun({ currentStepId: STEP_ID });
  return {
    run,
    state: overrides.state ?? makeState(run, { currentStepId: STEP_ID }),
    stateRevision: 1,
    conversationRecords: [],
    activeStep: overrides.activeStep ?? makeStep(),
    ...overrides,
  };
}

/** A VERIFYING Run with a candidate waiting for its completion decision. */
function verifyingSnapshot(overrides: Partial<RunExecutionSnapshot> = {}): RunExecutionSnapshot {
  const run = overrides.run ?? makeRun({ status: "VERIFYING" });
  return {
    run,
    state: overrides.state ?? makeState(run, { status: "VERIFYING" }),
    stateRevision: 1,
    continuationRevision: 1,
    conversationRecords: [],
    continuation: {
      type: "AWAITING_VERIFICATION",
      runId: run.id,
      sourceStepId: STEP_ID,
      verificationPlanId: "vplan_0195f3a0-0000-7000-8000-000000000000" as never,
      finalDecision: {
        type: "FINAL_CANDIDATE",
        modelTurn: { ...MODEL_TURN, finishReason: "STOP" },
        candidateText: "reading",
      },
    },
    ...overrides,
  };
}

function plan(
  snapshot: RunExecutionSnapshot,
  directive: RunExecutionDirective,
  effect: RunExecutionEffectResult,
): RunExecutionCommit {
  return planRunTransition({ snapshot, directive, effect, now: NOW });
}

const NONE_EFFECT: RunExecutionEffectResult = { kind: "NONE" };

const TOOL_RESULT: AgentToolResult = {
  externalCallId: "call_a",
  toolName: "read_file",
  content: "a.ts:1: hello",
  isError: false,
};

/* ------------------------------------------------------------------ matrix */

describe("planner branch matrix", () => {
  it("plans the three terminal finalizations", () => {
    const cancelled = plan(
      toolBoundarySnapshot(),
      { kind: "FINALIZE", reason: "CANCELLED" },
      NONE_EFFECT,
    );
    expect(cancelled.run.status).toBe("CANCELLED");
    expect(cancelled.state?.status).toBe("CANCELLED");
    expect(cancelled.continuation).toEqual({ operation: "CLEAR" });
    expect(cancelled.run.finishedAt).toBe(NOW);

    const timedOut = plan(
      toolBoundarySnapshot(),
      { kind: "FINALIZE", reason: "TIMEOUT" },
      NONE_EFFECT,
    );
    expect(timedOut.run.status).toBe("TIMEOUT");
    expect(timedOut.state?.status).toBe("TIMEOUT");

    const maxSteps = plan(
      toolBoundarySnapshot(),
      { kind: "FINALIZE", reason: "MAX_STEPS_REACHED" },
      NONE_EFFECT,
    );
    expect(maxSteps.run.status).toBe("MAX_STEPS_REACHED");
    expect(maxSteps.state?.status).toBe("MAX_STEPS_REACHED");
  });

  it("changes nothing for RETURN_TERMINAL or SUSPEND", () => {
    const snapshot = toolBoundarySnapshot({ run: makeRun({ status: "COMPLETED" }) });

    for (const directive of [
      { kind: "RETURN_TERMINAL" as const },
      { kind: "SUSPEND" as const, boundary: "APPROVAL" as const },
      { kind: "SUSPEND" as const, boundary: "RETRY" as const, resumeAt: NOW },
    ]) {
      const commit = plan(snapshot, directive, NONE_EFFECT);
      expect(commit.run).toBe(snapshot.run);
      expect(commit.state).toBe(snapshot.state);
      expect(commit.stepWrites).toEqual([]);
      expect(commit.messagesToAppend).toEqual([]);
      expect(commit.continuation).toBeUndefined();
      expect(commit.events).toEqual([]);
    }
  });

  it("settles the Step and opens WAITING_TOOL_RESULTS for AGENT TOOL_REQUESTS", () => {
    const snapshot = activeStepSnapshot();
    const result: AgentLoopAdvanceResult = {
      kind: "TOOL_REQUESTS",
      turn: { stepId: STEP_ID, sequence: 2 },
      modelTurn: MODEL_TURN,
      messagesToAppend: [ASSISTANT_APPEND],
      context: { report: {} as never, observationPolicy: OBSERVATION_POLICY, recovery: "NONE" },
      decision: PENDING_DECISION,
    };

    const commit = plan(
      snapshot,
      {
        kind: "ADVANCE_AGENT",
        mode: "EXECUTE",
        reason: "INITIAL",
        input: { kind: "USER_INPUT", userMessageId: agentMessageId("planner-user") },
      },
      { kind: "AGENT", result },
    );

    expect(commit.run.status).toBe("RUNNING");
    expect(commit.run.currentStepId).toBeUndefined();
    expect(commit.state?.currentStepId).toBeUndefined();
    // The attempt is counted exactly once, with the usage the turn reported.
    expect(commit.state?.usage).toEqual({
      steps: 2,
      toolCalls: 1,
      inputTokens: 5,
      outputTokens: 3,
    });
    expect(commit.stepWrites).toEqual([
      { operation: "UPDATE", step: { ...makeStep(), status: "COMPLETED", finishedAt: NOW } },
    ]);
    // Message V2 semantic materialization belongs to Core's RunMessageAuthority; the frozen
    // transition planner only plans lifecycle state and continuation changes.
    expect(commit.messagesToAppend).toEqual([]);
    expect(commit.continuation).toEqual({
      operation: "SET",
      checkpoint: {
        type: "WAITING_TOOL_RESULTS",
        runId: RUN_ID,
        sourceStepId: STEP_ID,
        pendingDecision: PENDING_DECISION,
        observationPolicy: OBSERVATION_POLICY,
      },
      updatedAt: NOW,
    });
  });

  it("fails the Run and the State for a final AGENT failure", () => {
    const snapshot = activeStepSnapshot();
    const result: AgentLoopAdvanceResult = {
      kind: "FAILED",
      turn: { stepId: STEP_ID, sequence: 2 },
      error: { code: "INTERNAL_ERROR", message: "safe", retryable: false, phase: "RUNTIME" },
      usage: { inputTokens: 1 },
      messagesToAppend: [],
    };

    const commit = plan(
      snapshot,
      {
        kind: "ADVANCE_AGENT",
        mode: "EXECUTE",
        reason: "INITIAL",
        input: { kind: "USER_INPUT", userMessageId: agentMessageId("planner-user") },
      },
      { kind: "AGENT", result },
    );

    expect(commit.run.status).toBe("FAILED");
    expect(commit.state?.status).toBe("FAILED");
    expect(commit.state?.errors).toHaveLength(1);
    expect(commit.stepWrites[0]?.step.status).toBe("FAILED");
    // This snapshot held no continuation, and "absent" means "leave it alone" rather than "clear".
    // A failure that *did* hold one clears it, which the completion-failure case asserts.
    expect(commit.continuation).toBeUndefined();
  });

  it("settles only the Step for AGENT CANCELLED, never the Run", () => {
    const snapshot = activeStepSnapshot();
    const result: AgentLoopAdvanceResult = {
      kind: "CANCELLED",
      turn: { stepId: STEP_ID, sequence: 2 },
      messagesToAppend: [],
      context: { report: {} as never, observationPolicy: OBSERVATION_POLICY, recovery: "NONE" },
    };

    const commit = plan(
      snapshot,
      {
        kind: "ADVANCE_AGENT",
        mode: "EXECUTE",
        reason: "INITIAL",
        input: { kind: "USER_INPUT", userMessageId: agentMessageId("planner-user") },
      },
      { kind: "AGENT", result },
    );

    // The termination authority owns cancellation; the planner only unwinds the attempt.
    expect(commit.run.status).toBe("RUNNING");
    expect(commit.run.currentStepId).toBeUndefined();
    expect(commit.stepWrites[0]?.step.status).toBe("CANCELLED");
    // A cancellation after the provider was contacted did spend an attempt.
    expect(commit.state?.usage.steps).toBe(2);
  });

  it("writes accepted Tool results onto the open continuation, keeping the Run RUNNING", () => {
    for (const turnResult of [
      { kind: "COMPLETED" as const, results: [TOOL_RESULT] },
      { kind: "REPLAN" as const, syntheticResults: [TOOL_RESULT] },
    ] satisfies readonly ToolTurnResult[]) {
      const snapshot = toolBoundarySnapshot();
      const commit = plan(
        snapshot,
        {
          kind: "EXECUTE_TOOL_BATCH",
          mode: "EXECUTE",
          sourceStepId: STEP_ID,
          pendingDecision: PENDING_DECISION,
          observationPolicy: OBSERVATION_POLICY,
        },
        { kind: "TOOLS", result: turnResult },
      );

      expect(commit.run.status, turnResult.kind).toBe("RUNNING");
      expect(commit.run).toBe(snapshot.run);
      expect(commit.continuation?.operation).toBe("SET");
      if (commit.continuation?.operation !== "SET") throw new Error("expected a SET");
      expect(commit.continuation.checkpoint).toMatchObject({
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
      // Exactly four fields cross; an artifact pointer is not one of them.
      expect(
        Object.keys(
          (
            commit.continuation.checkpoint as Extract<
              RunExecutionCommit["continuation"],
              { operation: "SET" }
            >["checkpoint"]
          ).type === "WAITING_TOOL_RESULTS"
            ? ((commit.continuation.checkpoint as { receivedResults?: readonly object[] })
                .receivedResults?.[0] ?? {})
            : {},
        ).sort(),
      ).toEqual(["content", "isError", "role", "toolCallId", "toolName"]);
    }
  });

  it("plans the durable approval boundary without fabricating an approval id", () => {
    const snapshot = toolBoundarySnapshot();
    const commit = plan(
      snapshot,
      {
        kind: "EXECUTE_TOOL_BATCH",
        mode: "EXECUTE",
        sourceStepId: STEP_ID,
        pendingDecision: PENDING_DECISION,
      },
      {
        kind: "TOOLS",
        result: {
          kind: "WAITING_APPROVAL",
          completedResults: [TOOL_RESULT],
          waiting: {
            invocationId: "tinv_0195f3a0-0000-7000-8000-000000000000" as never,
            externalCallId: "call_a",
            toolName: "read_file",
          },
        },
      },
    );

    expect(commit.run.status).toBe("WAITING_APPROVAL");
    expect(commit.state?.status).toBe("WAITING_APPROVAL");

    // The Run has stopped accepting results, so the durable invariant forbids them here.
    expect(commit.continuation?.operation).toBe("SET");
    if (commit.continuation?.operation !== "SET") throw new Error("expected a SET");
    expect(commit.continuation.checkpoint).not.toHaveProperty("receivedResults");
    expect(commit.continuation.checkpoint).toMatchObject({
      type: "WAITING_TOOL_RESULTS",
      sourceStepId: STEP_ID,
      waitingApproval: { externalCallId: "call_a", toolName: "read_file" },
    });
    // No approval id was present in the frozen input, so none was written.
    expect(
      (commit.continuation.checkpoint as { waitingApproval?: { approvalId?: unknown } })
        .waitingApproval?.approvalId,
    ).toBeUndefined();
  });

  it("plans the budget terminal settlement", () => {
    const snapshot = toolBoundarySnapshot();
    const commit = plan(
      snapshot,
      {
        kind: "EXECUTE_TOOL_BATCH",
        mode: "EXECUTE",
        sourceStepId: STEP_ID,
        pendingDecision: PENDING_DECISION,
      },
      {
        kind: "TOOLS",
        result: {
          kind: "BUDGET_EXCEEDED",
          completedResults: [TOOL_RESULT],
          block: { kind: "EXCEEDED", dimension: "TOOL_CALLS", accounted: 9, limit: 8 },
        },
      },
    );

    expect(commit.run.status).toBe("BUDGET_EXCEEDED");
    expect(commit.state?.status).toBe("BUDGET_EXCEEDED");
    expect(commit.continuation).toEqual({ operation: "CLEAR" });
  });

  it("completes the Run with the accepted result", () => {
    const snapshot = verifyingSnapshot();
    const commit = plan(
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

    expect(commit.run.status).toBe("COMPLETED");
    // The general `JsonValue` the Run schema declares, not a verified-result type.
    expect(commit.run.finalResult).toEqual({ type: "TEXT", text: "done" });
    expect(commit.run.finishedAt).toBe(NOW);
    expect(commit.state?.status).toBe("COMPLETED");
    expect(commit.continuation).toEqual({ operation: "CLEAR" });
  });

  it("fails the Run for COMPLETION REJECT and a final COMPLETION ERROR", () => {
    const error = {
      code: "VERIFICATION_FAILED" as const,
      message: "safe",
      retryable: false,
      phase: "VERIFICATION" as const,
    };
    const decisions = [
      { kind: "REJECT" as const, error },
      { kind: "ERROR" as const, error, retryable: false },
    ];

    for (const decision of decisions) {
      const commit = plan(
        verifyingSnapshot(),
        {
          kind: "EVALUATE_COMPLETION",
          mode: "RECOVER",
          sourceStepId: STEP_ID,
          candidate: { type: "FINAL_CANDIDATE", modelTurn: MODEL_TURN, candidateText: "reading" },
        },
        { kind: "COMPLETION", result: decision },
      );
      expect(commit.run.status, decision.kind).toBe("FAILED");
      expect(commit.state?.status).toBe("FAILED");
      expect(commit.state?.errors).toHaveLength(1);
      expect(commit.continuation).toEqual({ operation: "CLEAR" });
    }
  });
});

/* ------------------------------------------------- fail-closed branches */

describe("planner refuses transitions the frozen input cannot express", () => {
  const agentDirective = (
    reason: "INITIAL",
  ): Extract<RunExecutionDirective, { kind: "ADVANCE_AGENT" }> => ({
    kind: "ADVANCE_AGENT",
    mode: "EXECUTE",
    reason,
    input: { kind: "USER_INPUT", userMessageId: agentMessageId("planner-user") },
  });

  const completionDirective = (): Extract<
    RunExecutionDirective,
    { kind: "EVALUATE_COMPLETION" }
  > => ({
    kind: "EVALUATE_COMPLETION",
    mode: "RECOVER",
    sourceStepId: STEP_ID,
    candidate: { type: "FINAL_CANDIDATE", modelTurn: MODEL_TURN, candidateText: "reading" },
  });

  it("refuses AGENT FINAL_CANDIDATE rather than fabricating a verification plan id", () => {
    const result: AgentLoopAdvanceResult = {
      kind: "FINAL_CANDIDATE",
      turn: { stepId: STEP_ID, sequence: 2 },
      modelTurn: { ...MODEL_TURN, finishReason: "STOP" },
      messagesToAppend: [ASSISTANT_APPEND],
      context: { report: {} as never, observationPolicy: OBSERVATION_POLICY, recovery: "NONE" },
      decision: {
        type: "FINAL_CANDIDATE",
        modelTurn: { ...MODEL_TURN, finishReason: "STOP" },
        candidateText: "reading",
      },
    };

    const run = () =>
      plan(activeStepSnapshot(), agentDirective("INITIAL"), { kind: "AGENT", result });

    expect(run).toThrow(RunExecutionInvariantError);
    // The refusal names the gap and the owner, and produces no commit at all.
    expect(run).toThrow(/verification plan identity/);
    expect(run).toThrow(/Checkpoint 5/);
    expect(run).toThrow(/CompletionGate/);
  });

  it("refuses a retryable AGENT failure rather than inventing a retry schedule", () => {
    const result: AgentLoopAdvanceResult = {
      kind: "FAILED",
      turn: { stepId: STEP_ID, sequence: 2 },
      error: { code: "NETWORK_ERROR", message: "safe", retryable: true, phase: "LLM" },
      retry: { code: "NETWORK", retryable: true },
      messagesToAppend: [],
    };

    const run = () =>
      plan(activeStepSnapshot(), agentDirective("INITIAL"), { kind: "AGENT", result });

    expect(run).toThrow(RunExecutionInvariantError);
    expect(run).toThrow(/Run Retry compatibility decision/);
    // No `attempt` and no `nextAttemptAt` may appear anywhere: there is no commit to inspect.
    expect(run).toThrow(/no retry policy/);
  });

  it("refuses a retryable COMPLETION error rather than inventing a retry schedule", () => {
    const run = () =>
      plan(verifyingSnapshot(), completionDirective(), {
        kind: "COMPLETION",
        result: {
          kind: "ERROR",
          error: { code: "MODEL_TIMEOUT", message: "safe", retryable: true, phase: "LLM" },
          retryable: true,
        },
      });

    expect(run).toThrow(RunExecutionInvariantError);
    expect(run).toThrow(/Run Retry compatibility decision/);
  });

  it("refuses COMPLETION REPAIR rather than inventing verification evidence", () => {
    const run = () =>
      plan(verifyingSnapshot(), completionDirective(), {
        kind: "COMPLETION",
        result: {
          kind: "REPAIR",
          repair: {
            repairRef: "vplan_0195f3a0-0000-7000-8000-000000000000",
            cycle: 1,
            reason: "failed checks",
          },
        },
      });

    expect(run).toThrow(RunExecutionInvariantError);
    expect(run).toThrow(/failed plan identity, failed check identities and evidence identities/);
    expect(run).toThrow(/Phase 3E/);
  });

  it("refuses TOOLS RESOURCE_WAIT rather than inventing an operation reference", () => {
    const run = () =>
      plan(
        toolBoundarySnapshot(),
        {
          kind: "EXECUTE_TOOL_BATCH",
          mode: "EXECUTE",
          sourceStepId: STEP_ID,
          pendingDecision: PENDING_DECISION,
        },
        { kind: "TOOLS", result: { kind: "RESOURCE_WAIT", reason: "NO_PROGRESS" } },
      );

    expect(run).toThrow(RunExecutionInvariantError);
    expect(run).toThrow(/replan count and an operation reference/);
    expect(run).toThrow(/Phase 3D/);
  });

  it("refuses a directive and effect that describe different actions", () => {
    const pairs: readonly (readonly [RunExecutionDirective, RunExecutionEffectResult])[] = [
      [agentDirective("INITIAL"), { kind: "TOOLS", result: { kind: "COMPLETED", results: [] } }],
      [
        {
          kind: "EXECUTE_TOOL_BATCH",
          mode: "EXECUTE",
          sourceStepId: STEP_ID,
          pendingDecision: PENDING_DECISION,
        },
        { kind: "NONE" },
      ],
      [
        completionDirective(),
        {
          kind: "AGENT",
          result: {
            kind: "CANCELLED",
            turn: { stepId: STEP_ID, sequence: 1 },
            messagesToAppend: [],
          },
        },
      ],
      [
        { kind: "SUSPEND", boundary: "APPROVAL" },
        {
          kind: "COMPLETION",
          result: { kind: "ACCEPT", finalResult: { type: "TEXT", text: "x" } },
        },
      ],
      [{ kind: "RETURN_TERMINAL" }, { kind: "NONE" as const }],
    ];

    for (const [directive, effect] of pairs.slice(0, 4)) {
      expect(() => plan(toolBoundarySnapshot(), directive, effect), directive.kind).toThrow(
        RunExecutionInvariantError,
      );
    }
    // The last pair is the legal one, and it must not throw.
    expect(() =>
      plan(toolBoundarySnapshot(), { kind: "RETURN_TERMINAL" }, { kind: "NONE" }),
    ).not.toThrow();
  });

  it("refuses an AGENT transition whose active Step does not match the executed turn", () => {
    const result: AgentLoopAdvanceResult = {
      kind: "TOOL_REQUESTS",
      turn: { stepId: createStepId(), sequence: 2 },
      modelTurn: MODEL_TURN,
      messagesToAppend: [],
      context: { report: {} as never, observationPolicy: OBSERVATION_POLICY, recovery: "NONE" },
      decision: PENDING_DECISION,
    };

    expect(() =>
      plan(activeStepSnapshot(), agentDirective("INITIAL"), { kind: "AGENT", result }),
    ).toThrow(/but the Run's active Step is/);
  });

  it("refuses a Tool turn with no open Tool continuation", () => {
    expect(() =>
      plan(
        activeStepSnapshot(),
        {
          kind: "EXECUTE_TOOL_BATCH",
          mode: "EXECUTE",
          sourceStepId: STEP_ID,
          pendingDecision: PENDING_DECISION,
        },
        { kind: "TOOLS", result: { kind: "COMPLETED", results: [TOOL_RESULT] } },
      ),
    ).toThrow(/requires an open WAITING_TOOL_RESULTS continuation/);
  });
});

/* ------------------------------------------------------------ determinism */

describe("planner is pure and deterministic", () => {
  const CASES: readonly (readonly [
    string,
    RunExecutionSnapshot,
    RunExecutionDirective,
    RunExecutionEffectResult,
  ])[] = [
    [
      "FINALIZE TIMEOUT",
      toolBoundarySnapshot(),
      { kind: "FINALIZE", reason: "TIMEOUT" },
      { kind: "NONE" },
    ],
    [
      "RETURN_TERMINAL",
      toolBoundarySnapshot({ run: makeRun({ status: "COMPLETED" }) }),
      { kind: "RETURN_TERMINAL" },
      { kind: "NONE" },
    ],
    [
      "TOOLS COMPLETED",
      toolBoundarySnapshot(),
      {
        kind: "EXECUTE_TOOL_BATCH",
        mode: "EXECUTE",
        sourceStepId: STEP_ID,
        pendingDecision: PENDING_DECISION,
      },
      { kind: "TOOLS", result: { kind: "COMPLETED", results: [TOOL_RESULT] } },
    ],
    [
      "COMPLETION ACCEPT",
      verifyingSnapshot(),
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
    ],
  ];

  it("returns a deep-equal commit for the same input, and always an empty event list", () => {
    const planner = createRunTransitionPlanner();
    for (const [label, snapshot, directive, effect] of CASES) {
      const input: RunTransitionPlanInput = { snapshot, directive, effect, now: NOW };
      const first = planner.plan(input);
      const second = planner.plan(input);
      expect(second, label).toEqual(first);
      // The planner has no EventId factory and must not acquire one.
      expect(first.events, label).toEqual([]);
      // The revision the planner read is the revision the store must still see.
      expect(first.expectedStateRevision, label).toBe(snapshot.stateRevision ?? null);
      expect(first.expectedContinuationRevision, label).toBe(snapshot.continuationRevision ?? null);
    }
  });
});
