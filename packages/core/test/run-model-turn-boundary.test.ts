import { RunExecutionInvariantError } from "@caelush/agent";
import {
  AgentRunSchema,
  AgentStateSchema,
  AgentStepSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type AgentRun,
  type AgentState,
  type AgentStep,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createAgentModelTurnBoundary,
  createAgentTurnObservation,
  createObservingModelTurnExecutor,
  requiresBoundaryRepair,
  type AgentTurnObservation,
  type PendingAgentTurn,
} from "../src/run-model-turn-boundary.js";

/**
 * The durable model turn boundary, asserted as a gate rather than as a formality.
 *
 * The invariant under test is the phase's highest-priority recovery rule:
 *
 * ```text
 * the durable Step commit must succeed before provider I/O may begin
 * ```
 *
 * A boundary that committed twice, that committed over a different Step, or that let a rejected
 * commit look like a successful one would each break recovery in a way no later test could see.
 */

const AT = createTimestampMs(1_000);
const RUN_ID = createRunId();
const SESSION_ID = createSessionId();

const RUN: AgentRun = AgentRunSchema.parse({
  id: RUN_ID,
  sessionId: SESSION_ID,
  goal: "inspect the project",
  status: "RUNNING",
  workspace: { id: createWorkspaceId(), path: "/repo" },
  model: { provider: "fixture", model: "fixture-model" },
  runtime: { id: "local", kind: "fixture" },
  permissionProfile: "READ_ONLY",
  approvalPolicy: "ALWAYS_ASK",
  limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 10_000 },
  createdAt: AT,
  startedAt: AT,
});

const STATE: AgentState = AgentStateSchema.parse({
  runId: RUN_ID,
  sessionId: SESSION_ID,
  goal: RUN.goal,
  status: "RUNNING",
  workspace: RUN.workspace,
  runtime: RUN.runtime,
  permissionProfile: RUN.permissionProfile,
  approvalPolicy: RUN.approvalPolicy,
  plan: [],
  recentObservations: [],
  changedFiles: [],
  activeProcesses: [],
  errors: [],
  verification: "NOT_RUN",
  usage: { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
  updatedAt: AT,
  startedAt: AT,
});

function step(overrides: Partial<AgentStep> = {}): AgentStep {
  return AgentStepSchema.parse({
    id: createStepId(),
    runId: RUN_ID,
    sequence: 1,
    status: "RUNNING",
    startedAt: AT,
    ...overrides,
  });
}

/** A boundary over a pending turn, with every open recorded. */
function boundaryFor(pending: PendingAgentTurn, opens: PendingAgentTurn[]) {
  const observation = createAgentTurnObservation();
  return {
    observation,
    boundary: createAgentModelTurnBoundary({
      observation,
      pendingTurn: () => pending,
      openTurn: async (turn) => {
        opens.push(turn);
      },
    }),
  };
}

function inputFor(pending: PendingAgentTurn) {
  return {
    identity: pending.identity,
    turn: { stepId: pending.step.id, sequence: pending.step.sequence },
    model: pending.run.model,
  };
}

describe("durable model turn boundary", () => {
  it("commits the open exactly once", async () => {
    const pending: PendingAgentTurn = {
      identity: { runId: RUN_ID, sessionId: SESSION_ID, goal: RUN.goal },
      run: RUN,
      state: STATE,
      step: step(),
    };
    const opens: PendingAgentTurn[] = [];
    const { boundary, observation } = boundaryFor(pending, opens);

    await boundary.beforeExecute(inputFor(pending));

    expect(opens).toHaveLength(1);
    expect(observation.boundaryAttempted).toBe(true);
    expect(observation.boundaryCommitted).toBe(true);
    expect(observation.boundaryError).toBeUndefined();
    expect(requiresBoundaryRepair(observation)).toBe(false);
    expect(observation.providerTurnState).toBe("NOT_STARTED");
  });

  it("is idempotent for the same turn", async () => {
    const pending: PendingAgentTurn = {
      identity: { runId: RUN_ID, sessionId: SESSION_ID, goal: RUN.goal },
      run: RUN,
      state: STATE,
      step: step(),
    };
    const opens: PendingAgentTurn[] = [];
    const { boundary } = boundaryFor(pending, opens);

    await boundary.beforeExecute(inputFor(pending));
    await boundary.beforeExecute(inputFor(pending));

    // A second open would insert a second Step and publish a second `llm.started`.
    expect(opens).toHaveLength(1);
  });

  it("fails closed rather than opening a Step the Run Layer did not allocate", async () => {
    const pending: PendingAgentTurn = {
      identity: { runId: RUN_ID, sessionId: SESSION_ID, goal: RUN.goal },
      run: RUN,
      state: STATE,
      step: step({ sequence: 1 }),
    };
    const opens: PendingAgentTurn[] = [];
    const { boundary, observation } = boundaryFor(pending, opens);

    await expect(
      boundary.beforeExecute({
        ...inputFor(pending),
        turn: { stepId: pending.step.id, sequence: 2 },
      }),
    ).rejects.toBeInstanceOf(RunExecutionInvariantError);
    expect(opens).toHaveLength(0);
    expect(requiresBoundaryRepair(observation)).toBe(true);
  });

  it("fails closed for another Run and for another model", async () => {
    const pending: PendingAgentTurn = {
      identity: { runId: RUN_ID, sessionId: SESSION_ID, goal: RUN.goal },
      run: RUN,
      state: STATE,
      step: step(),
    };
    const opens: PendingAgentTurn[] = [];
    const { boundary } = boundaryFor(pending, opens);

    await expect(
      boundary.beforeExecute({
        ...inputFor(pending),
        identity: { ...pending.identity, runId: createRunId() },
      }),
    ).rejects.toBeInstanceOf(RunExecutionInvariantError);

    await expect(
      boundary.beforeExecute({
        ...inputFor(pending),
        model: { provider: "fixture", model: "other-model" },
      }),
    ).rejects.toBeInstanceOf(RunExecutionInvariantError);

    expect(opens).toHaveLength(0);
  });

  it("records a rejected commit and never reports it as committed", async () => {
    const pending: PendingAgentTurn = {
      identity: { runId: RUN_ID, sessionId: SESSION_ID, goal: RUN.goal },
      run: RUN,
      state: STATE,
      step: step(),
    };
    const observation = createAgentTurnObservation();
    const conflict = new Error("revision conflict");
    const boundary = createAgentModelTurnBoundary({
      observation,
      pendingTurn: () => pending,
      openTurn: () => Promise.reject(conflict),
    });

    await expect(boundary.beforeExecute(inputFor(pending))).rejects.toBe(conflict);

    expect(observation.boundaryAttempted).toBe(true);
    expect(observation.boundaryCommitted).toBe(false);
    expect(observation.boundaryError).toBe(conflict);
    // The Run Layer reads exactly this to decide it must surface an infrastructure failure rather
    // than let a model failure be recorded for a turn that never reached a model.
    expect(requiresBoundaryRepair(observation)).toBe(true);
  });

  it("does not require repair when the boundary was never entered", () => {
    const observation: AgentTurnObservation = createAgentTurnObservation();
    expect(requiresBoundaryRepair(observation)).toBe(false);
  });
});

describe("provider turn observation", () => {
  function observing(
    result: Awaited<ReturnType<Parameters<typeof createObservingModelTurnExecutor>[0]["execute"]>>,
  ) {
    const observation = createAgentTurnObservation();
    const executor = createObservingModelTurnExecutor({ execute: async () => result }, observation);
    return { observation, executor };
  }

  it("reads the state from the frozen union, never from an error", async () => {
    const completed = observing({ kind: "COMPLETED", result: {} as never });
    await completed.executor.execute({} as never);
    expect(completed.observation.providerTurnState).toBe("COMPLETED");

    const failed = observing({
      kind: "FAILED",
      error: { code: "NETWORK", retryable: true } as never,
    });
    await failed.executor.execute({} as never);
    expect(failed.observation.providerTurnState).toBe("FAILED");

    const cancelled = observing({ kind: "CANCELLED" });
    await cancelled.executor.execute({} as never);
    expect(cancelled.observation.providerTurnState).toBe("CANCELLED");
  });

  it("returns the frozen result unchanged", async () => {
    const result = { kind: "CANCELLED" as const };
    const { executor } = observing(result);
    await expect(executor.execute({} as never)).resolves.toBe(result);
  });

  it("never records an infrastructure throw as a completed turn", async () => {
    const observation = createAgentTurnObservation();
    const thrown = new Error("injected infrastructure failure");
    const executor = createObservingModelTurnExecutor(
      {
        execute: () => Promise.reject(thrown),
      },
      observation,
    );

    await expect(executor.execute({} as never)).rejects.toBe(thrown);
    expect(observation.providerTurnState).toBe("FAILED");
    expect(observation.providerError).toBe(thrown);
  });
});
