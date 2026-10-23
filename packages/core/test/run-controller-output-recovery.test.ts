import type { ModelTurnExecutionResult } from "@caelush/agent";
import { RunExecutionConflictError } from "@caelush/agent";
import {
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type ContextBudgetPolicySnapshot,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { RunBudgetPort } from "../src/budget-ports.js";
import { RunController } from "../src/run-controller.js";
import type { RunExecutionCommit } from "../src/run-execution-store.js";
import { RunRetryRegistry, type RunRetryTimerPort } from "../src/run-retry-registry.js";
import { completionStoreOver } from "./support/completion-store.js";
import { modelTurnResult } from "./support/fake-model-turn-executor.js";
import { MemoryRunStore } from "./support/phase-3d-tool-turn.js";
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

function recoveryEnabledRun(maxSteps = 8) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "recover one truncated model response",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps, maxToolCalls: 8, timeoutMs: 100_000, maxTokens: 100_000 },
    contextBudgetPolicy: outputRecoveryPolicy,
    createdAt: createTimestampMs(1),
  });
}

class RecoveryCommitTraceStore extends MemoryRunStore {
  readonly trace: string[] = [];
  rejectRecoveryCommit = false;
  cancelBeforeRecoveryCommit = false;

  override async commit(command: RunExecutionCommit) {
    const isRecoverySchedule = command.events.some(
      (event) => event.type === "retry.scheduled" && event.schemaVersion === 2,
    );
    if (isRecoverySchedule) {
      this.trace.push("commit:start");
      if (this.rejectRecoveryCommit) throw new Error("fixture rejects recovery schedule commit");
      if (this.cancelBeforeRecoveryCommit) {
        await this.requestCancellation(command.run.id, {
          runId: command.run.id,
          cause: "USER_REQUESTED",
          requestedAt: createTimestampMs(20),
        });
        if (command.failIfCancellationRequested) {
          throw new RunExecutionConflictError(
            "cancellation intent appeared before execution commit",
          );
        }
      }
      const result = await super.commit(command);
      this.trace.push("commit:done");
      return result;
    }
    return super.commit(command);
  }
}

function createHarness(
  options: {
    readonly rejectRecoveryCommit?: boolean;
    readonly cancelBeforeRecoveryCommit?: boolean;
    readonly cancelDuringBudgetSettlement?: boolean;
    readonly maxSteps?: number;
  } = {},
) {
  const run = recoveryEnabledRun(options.maxSteps);
  const store = new RecoveryCommitTraceStore({ run, conversationRecords: [] });
  store.rejectRecoveryCommit = options.rejectRecoveryCommit ?? false;
  store.cancelBeforeRecoveryCommit = options.cancelBeforeRecoveryCommit ?? false;
  const executor = fakeFrozenModelTurnExecutor((): ModelTurnExecutionResult => ({
    kind: "COMPLETED",
    result: modelTurnResult({
      text: "partial reasoning only",
      finishReason: "LENGTH",
      usage: { inputTokens: 12, outputTokens: PREVIOUS_OUTPUT_TOKENS, totalTokens: 112 },
    }),
  }));
  const execution = testRunAgentExecution({ executor }).factory;
  const trace = store.trace;
  const notified: string[] = [];
  const settlements: Parameters<NonNullable<RunBudgetPort["settleLLM"]>>[0][] = [];
  const scheduledDelays: number[] = [];
  const retryTimer: RunRetryTimerPort = {
    schedule(delayMs) {
      trace.push("timer:schedule");
      scheduledDelays.push(delayMs);
      return { cancel: () => undefined };
    },
  };
  const budget: RunBudgetPort = {
    async admitLLM() {
      return { kind: "ALLOWED", effectiveMaxOutputTokens: PREVIOUS_OUTPUT_TOKENS };
    },
    async admitLLMRecovery() {
      return { kind: "ALLOWED", effectiveMaxOutputTokens: PREVIOUS_OUTPUT_TOKENS * 2 };
    },
    async settleLLM(input) {
      settlements.push(input);
      if (options.cancelDuringBudgetSettlement) {
        await store.requestCancellation(run.id, {
          runId: run.id,
          cause: "USER_REQUESTED",
          requestedAt: createTimestampMs(20),
        });
      }
      return { kind: "SETTLED" };
    },
  };
  const controller = new RunController({
    agentExecution: execution,
    executionStore: store,
    completionStore: completionStoreOver(store),
    messages: testRunMessageAuthority({ snapshot: () => store.snapshot }),
    events: {
      notifyCommitted(events) {
        if (events.some((event) => event.type === "retry.scheduled" && event.schemaVersion === 2)) {
          trace.push("notify:recovery");
        }
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
    clock: { now: () => createTimestampMs(20) },
    eventIdFactory: { create: createEventId },
    retryRegistry: new RunRetryRegistry({
      clock: { now: () => createTimestampMs(20) },
      timer: retryTimer,
    }),
    budget,
  });
  return { controller, run, store, executor, notified, settlements, scheduledDelays, trace };
}

describe("RunController output recovery scheduling transaction", () => {
  it("atomically settles LENGTH and commits one RESERVED output recovery before notifying or waking", async () => {
    const harness = createHarness();

    const result = await harness.controller.start(harness.run.id);

    expect(result.status).toBe("WAITING_RETRY");
    expect(harness.executor.callCount()).toBe(1);
    expect(harness.settlements).toHaveLength(1);
    expect(harness.settlements[0]).toMatchObject({
      runId: harness.run.id,
      usage: { inputTokens: 12, outputTokens: PREVIOUS_OUTPUT_TOKENS },
    });

    const commit = harness.store.commits.find((candidate) =>
      candidate.events.some(
        (event) => event.type === "retry.scheduled" && event.schemaVersion === 2,
      ),
    );
    expect(commit).toBeDefined();
    expect(commit?.run.status).toBe("RUNNING");
    expect(commit?.run.currentStepId).toBeUndefined();
    expect(commit?.stepWrites).toHaveLength(1);
    expect(commit?.stepWrites[0]?.step.status).toBe("FAILED");
    expect(commit?.state?.usage).toMatchObject({ steps: 1, inputTokens: 12, outputTokens: 100 });
    expect(commit?.state?.modelOutputRecovery).toEqual({
      version: 1,
      sourceStepId: commit?.stepWrites[0]?.step.id,
      previousOutputTokens: PREVIOUS_OUTPUT_TOKENS,
      targetOutputTokens: PREVIOUS_OUTPUT_TOKENS * 2,
      phase: "RESERVED",
    });
    expect(commit?.continuation).toMatchObject({
      operation: "SET",
      checkpoint: {
        type: "WAITING_RETRY",
        runId: harness.run.id,
        failedStepId: commit?.stepWrites[0]?.step.id,
        attempt: 2,
        maxAttempts: 2,
        nextAttemptAt: createTimestampMs(20),
        errorCode: "LLM_OUTPUT_TRUNCATED",
        mode: "START",
      },
    });
    if (commit?.continuation?.operation !== "SET") throw new Error("missing recovery checkpoint");
    expect(Object.keys(commit.continuation.checkpoint).sort()).toEqual(
      [
        "attempt",
        "errorCode",
        "failedStepId",
        "maxAttempts",
        "mode",
        "nextAttemptAt",
        "runId",
        "type",
      ].sort(),
    );
    expect(commit?.messagesToAppend).toEqual([]);
    expect(commit?.events).toHaveLength(2);
    expect(commit?.events.map((event) => event.type)).toEqual(["llm.failed", "retry.scheduled"]);
    expect(commit?.events[1]).toMatchObject({
      schemaVersion: 2,
      type: "retry.scheduled",
      payload: {
        attempt: 2,
        maxAttempts: 2,
        delayMs: 0,
        nextAttemptAt: createTimestampMs(20),
        errorCode: "LLM_OUTPUT_TRUNCATED",
      },
    });
    expect(harness.trace).toEqual([
      "commit:start",
      "commit:done",
      "notify:recovery",
      "timer:schedule",
    ]);
    expect(harness.scheduledDelays).toEqual([0]);
    expect(harness.notified.slice(-2)).toEqual(["llm.failed", "retry.scheduled"]);
  });

  it("does not notify or wake when the atomic recovery schedule commit is rejected", async () => {
    const harness = createHarness({ rejectRecoveryCommit: true });

    await expect(harness.controller.start(harness.run.id)).rejects.toMatchObject({
      message: "Unable to persist Run execution",
      cause: expect.objectContaining({ message: "fixture rejects recovery schedule commit" }),
    });

    expect(
      harness.store.commits.some((commit) =>
        commit.events.some(
          (event) => event.type === "retry.scheduled" && event.schemaVersion === 2,
        ),
      ),
    ).toBe(false);
    expect(harness.store.snapshot.continuation).toBeUndefined();
    expect(harness.store.snapshot.state?.modelOutputRecovery).toBeUndefined();
    expect(harness.store.snapshot.activeStep?.status).toBe("RUNNING");
    expect(harness.settlements).toHaveLength(1);
    expect(harness.trace).toEqual(["commit:start"]);
    expect(harness.scheduledDelays).toEqual([]);
    expect(harness.notified).not.toContain("retry.scheduled");
  });

  it("settles the failed Step as MAX_STEPS_REACHED without publishing a recovery schedule", async () => {
    const harness = createHarness({ maxSteps: 1 });

    const result = await harness.controller.start(harness.run.id);

    expect(result.status).toBe("MAX_STEPS_REACHED");
    expect(harness.executor.callCount()).toBe(1);
    expect(harness.settlements).toHaveLength(1);
    expect(harness.store.snapshot.run.status).toBe("MAX_STEPS_REACHED");
    expect(harness.store.snapshot.state?.usage).toMatchObject({
      steps: 1,
      inputTokens: 12,
      outputTokens: PREVIOUS_OUTPUT_TOKENS,
    });
    expect(harness.store.snapshot.state?.modelOutputRecovery).toBeUndefined();
    expect(harness.store.snapshot.continuation).toBeUndefined();
    expect(
      harness.store.commits.some((commit) =>
        commit.events.some(
          (event) => event.type === "retry.scheduled" && event.schemaVersion === 2,
        ),
      ),
    ).toBe(false);
    expect(harness.trace).toEqual([]);
    expect(harness.scheduledDelays).toEqual([]);
  });

  it("honors cancellation committed during asynchronous usage settlement", async () => {
    const harness = createHarness({ cancelDuringBudgetSettlement: true });

    const result = await harness.controller.start(harness.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("CANCELLED");
    expect(harness.store.snapshot.run.status).toBe("CANCELLED");
    expect(harness.store.snapshot.continuation).toBeUndefined();
    expect(harness.store.snapshot.state?.modelOutputRecovery).toBeUndefined();
    expect(
      harness.store.commits.some((commit) =>
        commit.events.some(
          (event) => event.type === "retry.scheduled" && event.schemaVersion === 2,
        ),
      ),
    ).toBe(false);
    expect(harness.scheduledDelays).toEqual([]);
    expect(harness.notified).not.toContain("retry.scheduled");
  });

  it("honors cancellation that wins the atomic schedule commit race", async () => {
    const harness = createHarness({ cancelBeforeRecoveryCommit: true });

    const result = await harness.controller.start(harness.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("CANCELLED");
    expect(harness.store.snapshot.run.status).toBe("CANCELLED");
    expect(harness.store.snapshot.continuation).toBeUndefined();
    expect(harness.store.snapshot.state?.modelOutputRecovery).toBeUndefined();
    expect(
      harness.store.commits.some((commit) =>
        commit.events.some(
          (event) => event.type === "retry.scheduled" && event.schemaVersion === 2,
        ),
      ),
    ).toBe(false);
    expect(harness.trace).toEqual(["commit:start"]);
    expect(harness.scheduledDelays).toEqual([]);
    expect(harness.notified).not.toContain("retry.scheduled");
  });
});
