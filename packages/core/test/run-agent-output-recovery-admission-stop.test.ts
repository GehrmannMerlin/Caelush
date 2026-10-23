import type { ModelTurnExecutionResult } from "@caelush/agent";
import {
  AgentRunSchema,
  AgentStateSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type AgentState,
  type ContextBudgetPolicySnapshot,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import type { RunBudgetPort, RunBudgetSettlement } from "../src/budget-ports.js";
import { RunController } from "../src/run-controller.js";
import { RunControllerInfrastructureError } from "../src/run-controller-errors.js";
import type { RunExecutionCommit, RunExecutionSnapshot } from "../src/run-execution-store.js";
import { createUserMessageAppend } from "../src/run-message-materializer.js";
import { MemoryRunStore } from "./support/phase-3d-tool-turn.js";
import { completionStoreOver } from "./support/completion-store.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { testRunMessageAuthority } from "./support/run-message-authority.js";

const outputRecoveryPolicy = {
  version: "TURN_BUDGET_V3",
  algorithm: "HEADROOM_V1",
  minOutputTokens: 1_024,
  preferredOutputTokens: 16_384,
  safetyTokens: 2_048,
  expectedGrowthTokens: 4_096,
  postCompactionRatio: 0.5,
  outputRecovery: {
    version: "OUTPUT_RECOVERY_V1",
    maxRecoveryTurns: 1,
    outputMultiplier: 2,
  },
} satisfies ContextBudgetPolicySnapshot;

const PREVIOUS_OUTPUT_TOKENS = 100;
const ADMITTED_RECOVERY_TARGET = 200;
const unopenedSettlementExceeded: Extract<RunBudgetSettlement, { kind: "EXCEEDED" }> = {
  kind: "EXCEEDED",
  dimension: "TOKENS",
  accounted: 101,
  limit: 100,
};

class BoundaryRejectingStore extends MemoryRunStore {
  override async commit(command: RunExecutionCommit) {
    if (command.stepWrites.some((write) => write.step.status === "RUNNING")) {
      throw new Error("fixture rejects model boundary commit");
    }
    return super.commit(command);
  }
}

function recoverySnapshot(): RunExecutionSnapshot {
  const runId = createRunId();
  const sessionId = createSessionId();
  const createdAt = createTimestampMs(1);
  const pendingRun = AgentRunSchema.parse({
    id: runId,
    sessionId,
    goal: "recover one truncated model response",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 100_000, maxTokens: 100_000 },
    contextBudgetPolicy: outputRecoveryPolicy,
    createdAt,
  });
  const retryAt = createTimestampMs(10);
  const failedStepId = createStepId();
  const run = AgentRunSchema.parse({
    ...pendingRun,
    status: "RUNNING",
    startedAt: createTimestampMs(2),
  });
  const recovery: NonNullable<AgentState["modelOutputRecovery"]> = {
    version: 1,
    sourceStepId: failedStepId,
    previousOutputTokens: PREVIOUS_OUTPUT_TOKENS,
    targetOutputTokens: ADMITTED_RECOVERY_TARGET,
    phase: "RESERVED",
  };
  const state = AgentStateSchema.parse({
    ...startAgentState(createInitialAgentState(pendingRun, createdAt), createTimestampMs(2)),
    modelOutputRecovery: recovery,
  });
  const userMessage = createUserMessageAppend(testRunMessageAuthority(), run, "GOAL").draft;
  return {
    run,
    state,
    stateRevision: 1,
    continuationRevision: 1,
    conversationRecords: [{ runId, sequence: 1, ...userMessage }],
    continuation: {
      type: "WAITING_RETRY",
      runId,
      failedStepId,
      attempt: 2,
      maxAttempts: 2,
      nextAttemptAt: retryAt,
      errorCode: "LLM_OUTPUT_TRUNCATED",
      mode: "START",
    },
  };
}

function createHarness(options: {
  readonly snapshot?: RunExecutionSnapshot;
  readonly budget: RunBudgetPort;
  readonly now?: () => ReturnType<typeof createTimestampMs>;
  readonly executor?: ReturnType<typeof fakeFrozenModelTurnExecutor>;
  readonly store?: MemoryRunStore;
}) {
  const snapshot = options.snapshot ?? recoverySnapshot();
  const store = options.store ?? new MemoryRunStore(snapshot);
  const notified: string[] = [];
  const executor =
    options.executor ??
    fakeFrozenModelTurnExecutor((): ModelTurnExecutionResult => ({
      kind: "FAILED",
      error: {
        code: "PROVIDER_ERROR",
        message: "Unexpected provider call in a pre-boundary recovery test.",
        retryable: false,
      },
    }));
  const execution = testRunAgentExecution({ executor }).factory;
  const controller = new RunController({
    agentExecution: execution,
    executionStore: store,
    completionStore: completionStoreOver(store),
    messages: testRunMessageAuthority({ snapshot: () => store.snapshot }),
    events: {
      notifyCommitted(events) {
        notified.push(...events.map((event) => event.type));
      },
      emitTransient: () => undefined,
    },
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "base",
        contextLimits: { maxInputTokens: 1_000 },
      }),
    },
    clock: { now: options.now ?? (() => createTimestampMs(20)) },
    eventIdFactory: { create: createEventId },
    budget: options.budget,
  });
  return { controller, store, notified, executor, snapshot };
}

function budgetPort(
  admission: RunBudgetPort["admitLLM"],
  settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][],
  settlement: RunBudgetSettlement | void = { kind: "SETTLED" },
): RunBudgetPort {
  return {
    admitLLM: admission,
    async admitLLMRecovery() {
      return { kind: "ALLOWED", effectiveMaxOutputTokens: ADMITTED_RECOVERY_TARGET };
    },
    async settleLLM(input) {
      settleCalls.push(input);
      return settlement;
    },
  };
}

function typesOf(store: MemoryRunStore): string[] {
  return store.commits.flatMap((commit) => commit.events.map((event) => event.type));
}

describe("RunController output recovery admission stop", () => {
  it("settles a no-increment stop without opening a Step or emitting model events", async () => {
    const settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][] = [];
    const budget = budgetPort(
      async () => ({ kind: "ALLOWED", effectiveMaxOutputTokens: PREVIOUS_OUTPUT_TOKENS }),
      settleCalls,
    );
    const h = createHarness({ budget });

    const result = await h.controller.recover(h.snapshot.run.id);

    expect(result.status).toBe("FAILED");
    expect(h.store.snapshot.run.status).toBe("FAILED");
    expect(h.store.snapshot.state?.errors.at(-1)).toMatchObject({
      code: "MODEL_ERROR",
      phase: "LLM",
      retryable: false,
      details: { modelOutputFailure: "OUTPUT_TRUNCATED" },
    });
    expect(h.store.snapshot.continuation).toBeUndefined();
    expect(h.store.steps.size).toBe(0);
    expect(h.executor.callCount()).toBe(0);
    expect(settleCalls).toEqual([
      {
        runId: h.snapshot.run.id,
        stepId: expect.any(String),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        settledAt: createTimestampMs(20),
      },
    ]);
    expect(typesOf(h.store)).toEqual(["error", "status.changed", "run.failed"]);
    expect(h.notified).toEqual(typesOf(h.store));
  });

  it("keeps a real budget refusal on the existing budget authority path", async () => {
    const settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][] = [];
    const budget = budgetPort(
      async () => ({ kind: "EXCEEDED", dimension: "TOKENS", accounted: 100, limit: 100 }),
      settleCalls,
    );
    const h = createHarness({ budget });

    const result = await h.controller.recover(h.snapshot.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(h.store.snapshot.run.status).toBe("BUDGET_EXCEEDED");
    expect(h.store.snapshot.state?.status).toBe("BUDGET_EXCEEDED");
    expect(settleCalls).toHaveLength(0);
    expect(h.executor.callCount()).toBe(0);
    expect(typesOf(h.store)).toContain("budget.exceeded");
    expect(typesOf(h.store)).not.toContain("run.failed");
  });

  it("does not apply the no-increment stop without output-recovery policy provenance", async () => {
    const base = recoverySnapshot();
    const snapshot = {
      ...base,
      run: AgentRunSchema.parse({
        ...base.run,
        contextBudgetPolicy: {
          version: outputRecoveryPolicy.version,
          algorithm: outputRecoveryPolicy.algorithm,
          minOutputTokens: outputRecoveryPolicy.minOutputTokens,
          preferredOutputTokens: outputRecoveryPolicy.preferredOutputTokens,
          safetyTokens: outputRecoveryPolicy.safetyTokens,
          expectedGrowthTokens: outputRecoveryPolicy.expectedGrowthTokens,
          postCompactionRatio: outputRecoveryPolicy.postCompactionRatio,
        },
      }),
    } satisfies RunExecutionSnapshot;
    const settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][] = [];
    const budget = budgetPort(
      async () => ({ kind: "ALLOWED", effectiveMaxOutputTokens: PREVIOUS_OUTPUT_TOKENS }),
      settleCalls,
    );
    const h = createHarness({ snapshot, budget });

    await h.controller.recover(snapshot.run.id);

    expect(h.executor.callCount()).toBe(1);
    expect(h.store.steps.size).toBe(1);
    expect(typesOf(h.store)).toContain("llm.started");
    expect(settleCalls).toHaveLength(1);
  });

  it("lets a durable cancellation win over output recovery stop", async () => {
    const snapshot = recoverySnapshot();
    const store = new MemoryRunStore(snapshot);
    const settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][] = [];
    const budget = budgetPort(async () => {
      await store.requestCancellation(snapshot.run.id, {
        runId: snapshot.run.id,
        cause: "USER_REQUESTED",
        requestedAt: createTimestampMs(20),
      });
      return { kind: "ALLOWED", effectiveMaxOutputTokens: PREVIOUS_OUTPUT_TOKENS };
    }, settleCalls);
    const h = createHarness({ snapshot, store, budget });

    const result = await h.controller.recover(snapshot.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(store.snapshot.run.status).toBe("CANCELLED");
    expect(settleCalls).toHaveLength(1);
    expect(typesOf(store)).toContain("run.cancelled");
    expect(typesOf(store)).not.toContain("run.failed");
  });

  it("lets an elapsed deadline win over output recovery stop", async () => {
    const snapshot = recoverySnapshot();
    const store = new MemoryRunStore(snapshot);
    let now = createTimestampMs(20);
    const settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][] = [];
    const budget = budgetPort(async () => {
      now = createTimestampMs(200_000);
      return { kind: "ALLOWED", effectiveMaxOutputTokens: PREVIOUS_OUTPUT_TOKENS };
    }, settleCalls);
    const h = createHarness({ snapshot, store, budget, now: () => now });

    const result = await h.controller.recover(snapshot.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(store.snapshot.run.status).toBe("TIMEOUT");
    expect(settleCalls).toHaveLength(1);
    expect(typesOf(store)).toContain("run.timed_out");
    expect(typesOf(store)).not.toContain("run.failed");
  });

  it("settles an admitted reservation when the boundary commit fails", async () => {
    const snapshot = recoverySnapshot();
    const store = new BoundaryRejectingStore(snapshot);
    const settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][] = [];
    const budget = budgetPort(
      async () => ({ kind: "ALLOWED", effectiveMaxOutputTokens: ADMITTED_RECOVERY_TARGET }),
      settleCalls,
    );
    const h = createHarness({ snapshot, store, budget });

    await expect(h.controller.recover(snapshot.run.id)).rejects.toBeInstanceOf(
      RunControllerInfrastructureError,
    );

    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      runId: snapshot.run.id,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    expect(store.snapshot.run.status).toBe("RUNNING");
    expect(store.snapshot.continuation).toMatchObject({
      type: "WAITING_RETRY",
      errorCode: "LLM_OUTPUT_TRUNCATED",
    });
    expect(store.steps.size).toBe(0);
    expect(h.executor.callCount()).toBe(0);
    expect(typesOf(store)).not.toContain("llm.started");
  });

  it("sends an unopened settlement overage through budget authority after boundary repair", async () => {
    const snapshot = recoverySnapshot();
    const store = new BoundaryRejectingStore(snapshot);
    const settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][] = [];
    const budget = budgetPort(
      async () => ({ kind: "ALLOWED", effectiveMaxOutputTokens: ADMITTED_RECOVERY_TARGET }),
      settleCalls,
      unopenedSettlementExceeded,
    );
    const h = createHarness({ snapshot, store, budget });

    const result = await h.controller.recover(snapshot.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(store.snapshot.run.status).toBe("BUDGET_EXCEEDED");
    expect(store.snapshot.state?.status).toBe("BUDGET_EXCEEDED");
    expect(store.snapshot.continuation).toBeUndefined();
    expect(settleCalls).toHaveLength(1);
    expect(store.steps.size).toBe(0);
    expect(h.executor.callCount()).toBe(0);
    expect(typesOf(store)).toContain("budget.exceeded");
    expect(typesOf(store)).not.toContain("run.failed");
  });

  it("settles an unopened reservation after managed restart before the active-Step check", async () => {
    let enteredAdmission!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredAdmission = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const snapshot = recoverySnapshot();
    const store = new MemoryRunStore(snapshot);
    const settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][] = [];
    const budget = budgetPort(async () => {
      enteredAdmission();
      await admissionGate;
      return { kind: "ALLOWED", effectiveMaxOutputTokens: ADMITTED_RECOVERY_TARGET };
    }, settleCalls);
    const h = createHarness({ snapshot, store, budget });
    const running = h.controller.recover(snapshot.run.id);
    await entered;
    const shutdown = h.controller.prepareForShutdown(snapshot.run.id);
    releaseAdmission();

    const [result, checkpoint] = await Promise.all([running, shutdown]);

    expect(checkpoint).toBe("CHECKPOINTED");
    expect(result.status).toBe("WAITING_RETRY");
    expect(store.snapshot.run.status).toBe("RUNNING");
    expect(store.snapshot.continuation).toMatchObject({
      type: "WAITING_RETRY",
      errorCode: "LLM_OUTPUT_TRUNCATED",
    });
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      runId: snapshot.run.id,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    expect(store.steps.size).toBe(0);
    expect(h.executor.callCount()).toBe(0);
    expect(typesOf(store)).not.toContain("llm.started");
  });

  it("sends a managed-restart unopened settlement overage through budget authority", async () => {
    let enteredAdmission!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredAdmission = resolve;
    });
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const snapshot = recoverySnapshot();
    const store = new MemoryRunStore(snapshot);
    const settleCalls: Parameters<RunBudgetPort["settleLLM"]>[0][] = [];
    const budget = budgetPort(
      async () => {
        enteredAdmission();
        await admissionGate;
        return { kind: "ALLOWED", effectiveMaxOutputTokens: ADMITTED_RECOVERY_TARGET };
      },
      settleCalls,
      unopenedSettlementExceeded,
    );
    const h = createHarness({ snapshot, store, budget });
    const running = h.controller.recover(snapshot.run.id);
    await entered;
    const shutdown = h.controller.prepareForShutdown(snapshot.run.id);
    releaseAdmission();

    const [result, checkpoint] = await Promise.all([running, shutdown]);

    expect(result.status).toBe("TERMINAL");
    expect(checkpoint).toBe("ALREADY_SAFE");
    expect(store.snapshot.run.status).toBe("BUDGET_EXCEEDED");
    expect(store.snapshot.state?.status).toBe("BUDGET_EXCEEDED");
    expect(store.snapshot.continuation).toBeUndefined();
    expect(settleCalls).toHaveLength(1);
    expect(store.steps.size).toBe(0);
    expect(h.executor.callCount()).toBe(0);
    expect(typesOf(store)).toContain("budget.exceeded");
    expect(typesOf(store)).not.toContain("run.failed");
  });
});
