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
  type StepId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createRunExecutionCoordinator,
  nextRunExecutionDirective,
} from "../src/run/run-execution-coordinator.js";
import { isTerminalExecutionStatus } from "../src/run/directive.js";
import { RunExecutionInvariantError } from "../src/run/ports/run-execution-store.js";
import type {
  RunContinuationCheckpoint,
  RunExecutionDirective,
  RunExecutionSnapshot,
} from "../src/index.js";

/**
 * The frozen coordinator matrix.
 *
 * `next(snapshot, now)` is pure, so every routing rule is asserted as a table row: a status plus a
 * durable boundary plus `now` produces exactly one directive, and the governance priority decides
 * which one when several could apply.
 */

const AT = createTimestampMs(1_000);
const NOW = createTimestampMs(1_100);
const RUN_ID = createRunId();
const SESSION_ID = createSessionId();

const TOOL_STEP: StepId = createStepId();

const MODEL_TURN = {
  callId: "llm_0195f3a0-0000-7000-8000-000000000000",
  model: { provider: "fixture", model: "fixture-model" },
  finishReason: "TOOL_CALLS" as const,
  assistantMessage: {
    role: "assistant" as const,
    content: [
      {
        type: "tool-call" as const,
        toolCallId: "call_a",
        toolName: "read_file",
        input: { path: "a.ts" },
      },
    ],
  },
};

const PENDING_DECISION = {
  type: "TOOL_CALLS_REQUESTED" as const,
  modelTurn: MODEL_TURN,
  toolRequests: [{ externalCallId: "call_a", toolName: "read_file", args: { path: "a.ts" } }],
};

const INITIAL_INPUT = {
  kind: "USER_INPUT" as const,
  messages: [{ role: "user" as const, content: "inspect the project" }],
};

const toolResults = [
  {
    role: "tool" as const,
    toolCallId: "call_a",
    toolName: "read_file",
    content: "source",
    isError: false,
  },
];

const DURABLE_USER_RECORD = {
  messageType: "USER",
  source: { kind: "USER", origin: "GOAL" },
} as never;

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

function makeState(run: AgentRun): AgentState {
  return AgentStateSchema.parse({
    runId: run.id,
    sessionId: run.sessionId,
    goal: run.goal,
    status:
      run.status === "PENDING" ? "PENDING" : run.status === "RUNNING" ? "RUNNING" : run.status,
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
  });
}

function snapshot(overrides: Partial<RunExecutionSnapshot> = {}): RunExecutionSnapshot {
  const run = overrides.run ?? makeRun();
  return {
    run,
    state: overrides.state ?? makeState(run),
    conversationRecords: [DURABLE_USER_RECORD],
    ...overrides,
  };
}

const TOOL_REQUEST_CONTINUATION: RunContinuationCheckpoint = {
  type: "WAITING_TOOL_RESULTS",
  runId: RUN_ID,
  sourceStepId: TOOL_STEP,
  pendingDecision: PENDING_DECISION,
};

/** Every routing case, as one table. */
const MATRIX: readonly (readonly [string, RunExecutionSnapshot, RunExecutionDirective])[] = [
  [
    "PENDING Run starts its first Reason",
    snapshot({ run: makeRun({ status: "PENDING", startedAt: undefined }) }),
    { kind: "ADVANCE_AGENT", mode: "EXECUTE", reason: "INITIAL", input: INITIAL_INPUT },
  ],
  [
    "RUNNING with no continuation and no conversation",
    snapshot(),
    { kind: "ADVANCE_AGENT", mode: "EXECUTE", reason: "INITIAL", input: INITIAL_INPUT },
  ],
  [
    "Tool results not yet accepted run the batch, carrying the observation policy",
    snapshot({
      continuation: {
        ...TOOL_REQUEST_CONTINUATION,
        observationPolicy: { maxSingleObservationTokens: 10, maxObservationBatchTokens: 20 },
      },
    }),
    {
      kind: "EXECUTE_TOOL_BATCH",
      mode: "EXECUTE",
      sourceStepId: TOOL_STEP,
      pendingDecision: PENDING_DECISION,
      observationPolicy: { maxSingleObservationTokens: 10, maxObservationBatchTokens: 20 },
    },
  ],
  [
    "Tool results accepted resume the Reason with them",
    snapshot({
      continuation: { ...TOOL_REQUEST_CONTINUATION, receivedResults: toolResults },
    }),
    {
      kind: "ADVANCE_AGENT",
      mode: "RECOVER",
      reason: "TOOL_RESULTS",
      input: {
        kind: "TOOL_RESULTS",
        sourceStepId: TOOL_STEP,
        pendingDecision: PENDING_DECISION,
        results: toolResults,
      },
    },
  ],
  [
    "a retry that is not due suspends with its resume time",
    snapshot({
      continuation: {
        type: "WAITING_RETRY",
        runId: RUN_ID,
        failedStepId: TOOL_STEP,
        attempt: 2,
        maxAttempts: 3,
        nextAttemptAt: createTimestampMs(9_999),
        errorCode: "LLM_NETWORK",
        mode: "START",
      },
    }),
    { kind: "SUSPEND", boundary: "RETRY", resumeAt: createTimestampMs(9_999) },
  ],
  [
    "a due START retry advances a fresh Reason",
    snapshot({
      continuation: {
        type: "WAITING_RETRY",
        runId: RUN_ID,
        failedStepId: TOOL_STEP,
        attempt: 2,
        maxAttempts: 3,
        nextAttemptAt: createTimestampMs(1_050),
        errorCode: "LLM_NETWORK",
        mode: "START",
      },
    }),
    { kind: "ADVANCE_AGENT", mode: "RECOVER", reason: "RETRY", input: INITIAL_INPUT },
  ],
  [
    "a due TOOL_RESULTS retry resumes with the request Step and the batch",
    snapshot({
      continuation: {
        type: "WAITING_RETRY",
        runId: RUN_ID,
        failedStepId: createStepId(),
        attempt: 2,
        maxAttempts: 3,
        nextAttemptAt: createTimestampMs(1_050),
        errorCode: "LLM_NETWORK",
        mode: "TOOL_RESULTS",
        pendingDecision: PENDING_DECISION,
        receivedResults: toolResults,
        sourceStepId: TOOL_STEP,
      },
    }),
    {
      kind: "ADVANCE_AGENT",
      mode: "RECOVER",
      reason: "RETRY",
      input: {
        kind: "TOOL_RESULTS",
        sourceStepId: TOOL_STEP,
        pendingDecision: PENDING_DECISION,
        results: toolResults,
      },
    },
  ],
  [
    "a waiting approval Run suspends",
    snapshot({ run: makeRun({ status: "WAITING_APPROVAL" }) }),
    { kind: "SUSPEND", boundary: "APPROVAL" },
  ],
  [
    "a waiting resource Run suspends",
    snapshot({ run: makeRun({ status: "WAITING_RESOURCE" }) }),
    { kind: "SUSPEND", boundary: "RESOURCE" },
  ],
  [
    "a waiting Tool boundary holding an approval pointer suspends",
    snapshot({
      continuation: {
        ...TOOL_REQUEST_CONTINUATION,
        waitingApproval: {
          invocationId: "tiv_0195f3a0-0000-7000-8000-000000000001" as never,
          externalCallId: "call_a",
          toolName: "read_file",
        },
      },
    }),
    { kind: "SUSPEND", boundary: "APPROVAL" },
  ],
  [
    "a VERIFYING Run evaluates its candidate",
    snapshot({
      run: makeRun({ status: "VERIFYING" }),
      continuation: {
        type: "AWAITING_VERIFICATION",
        runId: RUN_ID,
        sourceStepId: TOOL_STEP,
        verificationPlanId: "vplan_0195f3a0-0000-7000-8000-000000000001" as never,
        finalDecision: {
          type: "FINAL_CANDIDATE",
          modelTurn: MODEL_TURN,
          candidateText: "done",
        },
      },
    }),
    {
      kind: "EVALUATE_COMPLETION",
      mode: "RECOVER",
      sourceStepId: TOOL_STEP,
      candidate: { type: "FINAL_CANDIDATE", modelTurn: MODEL_TURN, candidateText: "done" },
    },
  ],
  [
    "a verification repair continues the same Run",
    snapshot({
      continuation: {
        type: "WAITING_VERIFICATION_REPAIR",
        runId: RUN_ID,
        failedPlanId: "vplan_0195f3a0-0000-7000-8000-000000000001" as never,
        sourceStepId: TOOL_STEP,
        failedCheckIds: [],
        evidenceIds: [],
        repairCycle: 1,
      },
    }),
    {
      kind: "ADVANCE_AGENT",
      mode: "RECOVER",
      reason: "COMPLETION_REPAIR",
      input: { kind: "CONTINUATION", reason: "VERIFICATION_REPAIR" },
    },
  ],
  [
    "durable cancellation intent finalizes as CANCELLED",
    snapshot({ cancellationIntent: { runId: RUN_ID, cause: "USER_REQUESTED", requestedAt: AT } }),
    { kind: "FINALIZE", reason: "CANCELLED" },
  ],
  [
    "an expired Run finalizes as TIMEOUT",
    snapshot({ run: makeRun({ limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 50 } }) }),
    { kind: "FINALIZE", reason: "TIMEOUT" },
  ],
  [
    "a spent step budget finalizes before another turn",
    snapshot({ run: makeRun({ limits: { maxSteps: 1, maxToolCalls: 8, timeoutMs: 10_000 } }) }),
    { kind: "FINALIZE", reason: "MAX_STEPS_REACHED" },
  ],
];

describe("RunExecutionCoordinator.next(snapshot, now)", () => {
  it.each(MATRIX)("%s", (_name, input, expected) => {
    expect(nextRunExecutionDirective(input, NOW)).toEqual(expected);
  });

  it.each([
    ["COMPLETED"],
    ["FAILED"],
    ["CANCELLED"],
    ["TIMEOUT"],
    ["MAX_STEPS_REACHED"],
    ["BUDGET_EXCEEDED"],
  ] as const)("returns terminal for a %s Run", (status) => {
    const run = makeRun({ status });
    expect(nextRunExecutionDirective(snapshot({ run }), NOW)).toEqual({
      kind: "RETURN_TERMINAL",
    });
    expect(isTerminalExecutionStatus(status)).toBe(true);
  });

  it("gives cancellation priority over the deadline and the step budget", () => {
    const input = snapshot({
      run: makeRun({ limits: { maxSteps: 1, maxToolCalls: 8, timeoutMs: 1 } }),
      cancellationIntent: { runId: RUN_ID, cause: "USER_REQUESTED", requestedAt: AT },
    });
    expect(nextRunExecutionDirective(input, NOW)).toEqual({
      kind: "FINALIZE",
      reason: "CANCELLED",
    });
  });

  it("gives the deadline priority over the step budget", () => {
    const input = snapshot({
      run: makeRun({ limits: { maxSteps: 1, maxToolCalls: 8, timeoutMs: 1 } }),
    });
    expect(nextRunExecutionDirective(input, NOW)).toEqual({
      kind: "FINALIZE",
      reason: "TIMEOUT",
    });
  });

  it("routes a Run whose deadline is effectively unbounded instead of refusing to route it", () => {
    // A host may spend the whole safe-integer range as its "no deadline" sentinel, which is what
    // the local daemon does. `startedAt + timeoutMs` then overflows even though every input is a
    // safe integer, and a coordinator that formed that sum would make the Run unroutable. The
    // predicate is exact without it.
    const input: RunExecutionSnapshot = {
      run: makeRun({
        startedAt: createTimestampMs(1_789_000_000_000),
        limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: Number.MAX_SAFE_INTEGER },
      }),
      conversationRecords: [DURABLE_USER_RECORD],
    };

    expect(nextRunExecutionDirective(input, createTimestampMs(1_789_000_001_000))).toEqual({
      kind: "ADVANCE_AGENT",
      mode: "EXECUTE",
      reason: "INITIAL",
      input: INITIAL_INPUT,
    });

    // ...and an unbounded deadline is still a deadline: it expires the moment the elapsed time
    // reaches it, which for this sentinel is beyond any reachable `now`.
    const expired: RunExecutionSnapshot = {
      run: makeRun({
        startedAt: createTimestampMs(1_000),
        limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 500 },
      }),
      conversationRecords: [DURABLE_USER_RECORD],
    };
    expect(nextRunExecutionDirective(expired, createTimestampMs(1_500))).toEqual({
      kind: "FINALIZE",
      reason: "TIMEOUT",
    });
    expect(nextRunExecutionDirective(expired, createTimestampMs(1_499))).not.toEqual({
      kind: "FINALIZE",
      reason: "TIMEOUT",
    });
  });

  it("refuses a timeout that is not a positive safe integer", () => {
    // The Protocol schema already refuses these, so the coordinator's own guard is defence in
    // depth: it is stated directly so the routing rule never depends on a caller having validated.
    for (const timeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const run = {
        ...makeRun(),
        limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs },
      } as AgentRun;
      expect(() => nextRunExecutionDirective(snapshot({ run }), NOW), String(timeoutMs)).toThrow(
        RunExecutionInvariantError,
      );
    }
  });

  it("gives the step budget priority over an open durable boundary", () => {
    const input = snapshot({
      run: makeRun({ limits: { maxSteps: 1, maxToolCalls: 8, timeoutMs: 10_000 } }),
      continuation: TOOL_REQUEST_CONTINUATION,
    });
    expect(nextRunExecutionDirective(input, NOW)).toEqual({
      kind: "FINALIZE",
      reason: "MAX_STEPS_REACHED",
    });
  });

  it("refuses to route a Run with an active Step", () => {
    const run = makeRun();
    const input = snapshot({
      run,
      activeStep: { id: TOOL_STEP, runId: run.id, sequence: 1, status: "RUNNING", startedAt: AT },
    });
    expect(() => nextRunExecutionDirective(input, NOW)).toThrow(/active Step/);
  });

  it("refuses to route a RUNNING Run with a conversation but no continuation", () => {
    const input = snapshot({
      conversationRecords: [DURABLE_USER_RECORD, { messageType: "ASSISTANT" } as never],
    });
    expect(() => nextRunExecutionDirective(input, NOW)).toThrow(/no continuation/);
  });

  it("refuses to route a legacy retry Tool resume with no recorded request Step", () => {
    const input = snapshot({
      continuation: {
        type: "WAITING_RETRY",
        runId: RUN_ID,
        failedStepId: TOOL_STEP,
        attempt: 2,
        maxAttempts: 3,
        nextAttemptAt: createTimestampMs(1_050),
        errorCode: "LLM_NETWORK",
        mode: "TOOL_RESULTS",
        pendingDecision: PENDING_DECISION,
        receivedResults: toolResults,
      } as RunContinuationCheckpoint,
    });
    expect(() => nextRunExecutionDirective(input, NOW)).toThrow(/no recorded request Step/);
  });

  it("is deterministic over the whole matrix", () => {
    for (const [, input, expected] of MATRIX) {
      const first = nextRunExecutionDirective(input, NOW);
      expect(first).toEqual(nextRunExecutionDirective(input, NOW));
      expect(first).toEqual(expected);
    }
  });

  it("is exposed through the frozen factory", () => {
    const coordinator = createRunExecutionCoordinator();
    expect(coordinator.next(snapshot(), NOW)).toEqual(nextRunExecutionDirective(snapshot(), NOW));
  });
});
