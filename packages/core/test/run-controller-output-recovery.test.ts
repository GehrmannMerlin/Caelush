import type { ModelTurnExecutionResult } from "@caelush/agent";
import { RunExecutionConflictError } from "@caelush/agent";
import {
  AgentRunSchema,
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type ContextBudgetPolicySnapshot,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { AgentToolCallsDecision } from "../src/agent-decision.js";
import type { RunContinuationCheckpoint } from "../src/agent-continuation.js";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import type { RunBudgetPort } from "../src/budget-ports.js";
import { RunControllerInfrastructureError } from "../src/run-controller-errors.js";
import {
  createAssistantMessageAppend,
  createExternalToolResultMessageAppend,
  createSteeringMessageAppend,
  createUserMessageAppend,
} from "../src/run-message-materializer.js";
import { RunController } from "../src/run-controller.js";
import { RunExecutionInvariantError, type RunExecutionCommit } from "../src/run-execution-store.js";
import { RunRetryRegistry, type RunRetryTimerPort } from "../src/run-retry-registry.js";
import { completionStoreOver } from "./support/completion-store.js";
import { modelTurnResult } from "./support/fake-model-turn-executor.js";
import { MemoryRunStore } from "./support/phase-3d-tool-turn.js";
import {
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
} from "./support/run-agent-execution.js";
import { testRunMessageAuthority } from "./support/run-message-authority.js";
import { aiError } from "./support/fake-model-turn-executor.js";

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

function recoveryEnabledRun(maxSteps = 8, timeoutMs = 100_000) {
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
    limits: { maxSteps, maxToolCalls: 8, timeoutMs, maxTokens: 100_000 },
    completionContract: "NATURAL_V1",
    contextBudgetPolicy: outputRecoveryPolicy,
    createdAt: createTimestampMs(1),
  });
}

class RecoveryCommitTraceStore extends MemoryRunStore {
  readonly trace: string[] = [];
  readonly providerCallsAtRecoveryOpenCommit: number[] = [];
  readonly recoveryOpenCancellationGuards: boolean[] = [];
  readonly recoveryFailureCancellationGuards: boolean[] = [];
  providerCallCount: () => number = () => 0;
  rejectRecoveryCommit = false;
  cancelBeforeRecoveryCommit = false;
  cancelBeforeRecoveryFailureCommit = false;
  beforeRecoveryOpenCommit: (() => Promise<void>) | undefined;

  override async commit(command: RunExecutionCommit) {
    const isRecoverySchedule = command.events.some(
      (event) => event.type === "retry.scheduled" && event.schemaVersion === 2,
    );
    const isRecoveryOpen = isRecoveryOpenCommit(command);
    const isRecoveryFailure =
      command.run.status === "FAILED" &&
      command.state?.modelOutputRecovery?.phase === "OPENED" &&
      command.stepWrites.some(
        (write) => write.operation === "UPDATE" && write.step.status === "FAILED",
      );
    if (isRecoveryFailure) {
      this.recoveryFailureCancellationGuards.push(command.failIfCancellationRequested === true);
      if (this.cancelBeforeRecoveryFailureCommit) {
        await this.requestCancellation(command.run.id, {
          runId: command.run.id,
          cause: "USER_REQUESTED",
          requestedAt: createTimestampMs(20),
        });
        if (command.failIfCancellationRequested === true) {
          throw new RunExecutionConflictError(
            "cancellation intent appeared before output recovery failure commit",
          );
        }
      }
    }
    if (isRecoverySchedule || isRecoveryOpen) {
      this.trace.push(isRecoverySchedule ? "commit:start" : "open:commit:start");
      if (isRecoveryOpen) {
        this.providerCallsAtRecoveryOpenCommit.push(this.providerCallCount());
        this.recoveryOpenCancellationGuards.push(command.failIfCancellationRequested === true);
      }
      if (this.rejectRecoveryCommit) throw new Error("fixture rejects recovery schedule commit");
      if (isRecoverySchedule && this.cancelBeforeRecoveryCommit) {
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
      if (isRecoveryOpen) await this.beforeRecoveryOpenCommit?.();
      if (
        isRecoveryOpen &&
        command.failIfCancellationRequested === true &&
        this.snapshot.cancellationIntent !== undefined
      ) {
        throw new RunExecutionConflictError("cancellation intent appeared before execution commit");
      }
      const result = await super.commit(command);
      this.trace.push(isRecoverySchedule ? "commit:done" : "open:commit:done");
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
    readonly recoveryAdmittedOutputTokens?: number;
    readonly recoveryAdmissionExceeded?: boolean;
    readonly onRecoveryAdmission?: () => void | Promise<void>;
    readonly cancelDuringRecoverySettlement?: boolean;
    readonly cancelBeforeRecoveryFailureCommit?: boolean;
    readonly now?: () => ReturnType<typeof createTimestampMs>;
    readonly timeoutMs?: number;
  } = {},
) {
  const run = recoveryEnabledRun(options.maxSteps, options.timeoutMs);
  const store = new RecoveryCommitTraceStore({ run, conversationRecords: [] });
  store.rejectRecoveryCommit = options.rejectRecoveryCommit ?? false;
  store.cancelBeforeRecoveryCommit = options.cancelBeforeRecoveryCommit ?? false;
  store.cancelBeforeRecoveryFailureCommit = options.cancelBeforeRecoveryFailureCommit ?? false;
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
      if (executor.callCount() > 0) await options.onRecoveryAdmission?.();
      if (executor.callCount() > 0 && options.recoveryAdmissionExceeded) {
        return {
          kind: "EXCEEDED" as const,
          dimension: "TOKENS" as const,
          accounted: 100,
          limit: 100,
        };
      }
      const outputTokens =
        executor.callCount() === 0
          ? PREVIOUS_OUTPUT_TOKENS
          : (options.recoveryAdmittedOutputTokens ?? PREVIOUS_OUTPUT_TOKENS * 2);
      return { kind: "ALLOWED", effectiveMaxOutputTokens: outputTokens };
    },
    async admitLLMRecovery() {
      return {
        kind: "ALLOWED",
        effectiveMaxOutputTokens:
          options.recoveryAdmittedOutputTokens ?? PREVIOUS_OUTPUT_TOKENS * 2,
      };
    },
    async settleLLM(input) {
      settlements.push(input);
      if (
        options.cancelDuringBudgetSettlement ||
        (options.cancelDuringRecoverySettlement && settlements.length > 1)
      ) {
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
        if (events.some((event) => event.type === "retry.started")) {
          trace.push("notify:retry-started");
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
    clock: { now: options.now ?? (() => createTimestampMs(20)) },
    eventIdFactory: { create: createEventId },
    retryRegistry: new RunRetryRegistry({
      clock: { now: () => createTimestampMs(20) },
      timer: retryTimer,
    }),
    budget,
  });
  store.providerCallCount = () => executor.callCount();
  return { controller, run, store, executor, notified, settlements, scheduledDelays, trace };
}

const TOOL_RESUME_DECISION = {
  type: "TOOL_CALLS_REQUESTED",
  modelTurn: {
    callId: "llm_0195f3a0-0000-7000-8000-000000000b02",
    model: { provider: "fixture", model: "fixture-model" },
    finishReason: "TOOL_CALLS",
    assistantMessage: {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_a",
          toolName: "read_file",
          input: { path: "src/index.ts" },
        },
      ],
    },
  },
  toolRequests: [
    { externalCallId: "call_a", toolName: "read_file", args: { path: "src/index.ts" } },
  ],
} as AgentToolCallsDecision;

const TOOL_RESUME_RESULTS = [
  {
    role: "tool" as const,
    toolCallId: "call_a",
    toolName: "read_file",
    content: "export const value = 1;",
    isError: false,
  },
];

function seedRetryMode(
  harness: ReturnType<typeof createHarness>,
  mode: "START" | "TOOL_RESULTS" | "STEERING",
) {
  const messages = testRunMessageAuthority();
  const runningRun = AgentRunSchema.parse({
    ...harness.run,
    status: "RUNNING",
    startedAt: createTimestampMs(1),
  });
  const state = startAgentState(
    createInitialAgentState(harness.run, createTimestampMs(1)),
    createTimestampMs(1),
  );
  const sourceStepId = createStepId();
  const records = [
    {
      runId: runningRun.id,
      sequence: 1,
      ...createUserMessageAppend(messages, runningRun, "GOAL").draft,
    },
  ];
  let modeFields: Record<string, unknown> = { mode: "START" };
  let steeringMessageIds: readonly string[] | undefined;
  if (mode === "TOOL_RESULTS") {
    const assistant = createAssistantMessageAppend(
      messages,
      runningRun,
      sourceStepId,
      TOOL_RESUME_DECISION.modelTurn,
      "COMMENTARY",
    );
    const result = createExternalToolResultMessageAppend(
      messages,
      runningRun,
      sourceStepId,
      TOOL_RESUME_RESULTS[0]!,
      { maxSingleObservationTokens: 100, maxObservationBatchTokens: 200 },
    );
    records.push(
      { runId: runningRun.id, sequence: 2, ...assistant.draft },
      { runId: runningRun.id, sequence: 3, ...result.draft },
    );
    modeFields = {
      mode: "TOOL_RESULTS",
      pendingDecision: TOOL_RESUME_DECISION,
      receivedResults: TOOL_RESUME_RESULTS,
      sourceStepId,
    };
  } else if (mode === "STEERING") {
    const steering = createSteeringMessageAppend(messages, runningRun, "keep the existing parser");
    records.push({ runId: runningRun.id, sequence: 2, ...steering.append.draft });
    steeringMessageIds = [steering.messageId];
    modeFields = {
      mode: "STEERING",
      messageIds: steeringMessageIds,
      sourceStepId,
    };
  }
  const continuation: RunContinuationCheckpoint = {
    type: "WAITING_RETRY",
    runId: runningRun.id,
    failedStepId: createStepId(),
    attempt: 1,
    maxAttempts: 2,
    episode: 1,
    totalAttempts: 1,
    nextAttemptAt: createTimestampMs(2),
    errorCode: "LLM_NETWORK",
    ...modeFields,
  } as RunContinuationCheckpoint;
  harness.store.stateRevision = 1;
  harness.store.continuationRevision = 1;
  harness.store.snapshot = {
    ...harness.store.snapshot,
    run: runningRun,
    state,
    stateRevision: 1,
    continuation,
    continuationRevision: 1,
    conversationRecords: records,
  };
  return { run: runningRun, sourceStepId, records, steeringMessageIds };
}

function isRecoveryOpenCommit(command: RunExecutionCommit): boolean {
  const recovery = command.state?.modelOutputRecovery;
  if (recovery?.phase !== "OPENED") return false;
  return command.stepWrites.some(
    (write) => write.operation === "INSERT" && write.step.id === recovery.recoveryStepId,
  );
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

  it("opens the reserved recovery and consumes its continuation before the recovery Provider call", async () => {
    const harness = createHarness();
    await harness.controller.start(harness.run.id);
    harness.trace.length = 0;
    harness.executor.resetScript((_request, _signal, callIndex) => {
      if (callIndex === 1) {
        harness.trace.push("provider:recovery");
        throw new Error("stop after observing the recovery request");
      }
      throw new Error("unexpected Provider call count");
    });

    const result = await harness.controller.recover(harness.run.id);

    const openingCommit = harness.store.commits.find((candidate) =>
      isRecoveryOpenCommit(candidate),
    );
    const reservationCommit = harness.store.commits.find(
      (candidate) => candidate.state?.modelOutputRecovery?.phase === "RESERVED",
    );
    expect(openingCommit).toBeDefined();
    expect(openingCommit?.run.currentStepId).toBe(openingCommit?.stepWrites[0]?.step.id);
    expect(openingCommit?.state?.currentStepId).toBe(openingCommit?.stepWrites[0]?.step.id);
    expect(openingCommit?.stepWrites).toHaveLength(1);
    expect(openingCommit?.stepWrites[0]).toMatchObject({
      operation: "INSERT",
      step: { status: "RUNNING" },
    });
    expect(openingCommit?.state?.modelOutputRecovery).toMatchObject({
      version: 1,
      sourceStepId: reservationCommit?.stepWrites[0]?.step.id,
      previousOutputTokens: PREVIOUS_OUTPUT_TOKENS,
      targetOutputTokens: PREVIOUS_OUTPUT_TOKENS * 2,
      phase: "OPENED",
      recoveryStepId: openingCommit?.stepWrites[0]?.step.id,
    });
    expect(openingCommit?.continuation).toEqual({ operation: "CLEAR" });
    expect(openingCommit?.events.map((event) => event.type)).toEqual([
      "retry.started",
      "llm.started",
    ]);
    expect(openingCommit?.events[0]).toMatchObject({ schemaVersion: 1, type: "retry.started" });
    expect(harness.store.providerCallsAtRecoveryOpenCommit).toEqual([1]);
    expect(result.status).toBe("FAILED");
    expect(harness.trace.filter((entry) => entry !== "timer:schedule")).toEqual([
      "open:commit:start",
      "open:commit:done",
      "notify:retry-started",
      "provider:recovery",
    ]);
    expect(harness.executor.callCount()).toBe(2);
    expect(harness.executor.requests[1]?.settings?.maxOutputTokens).toBe(
      PREVIOUS_OUTPUT_TOKENS * 2,
    );
  });

  it("fails closed when the durable recovery fact says the one recovery was already opened", async () => {
    const harness = createHarness();
    await harness.controller.start(harness.run.id);
    const reserved = harness.store.snapshot.state?.modelOutputRecovery;
    if (reserved?.phase !== "RESERVED") throw new Error("missing RESERVED recovery fact");
    harness.store.snapshot = {
      ...harness.store.snapshot,
      state: {
        ...harness.store.snapshot.state!,
        modelOutputRecovery: {
          ...reserved,
          phase: "OPENED",
          recoveryStepId: createStepId(),
        },
      },
    };

    await expect(harness.controller.recover(harness.run.id)).rejects.toBeInstanceOf(
      RunExecutionInvariantError,
    );

    expect(harness.executor.callCount()).toBe(1);
    expect(harness.store.providerCallsAtRecoveryOpenCommit).toEqual([]);
  });

  it("does not open or send when the recovery admission grants no output increment", async () => {
    const harness = createHarness({ recoveryAdmittedOutputTokens: PREVIOUS_OUTPUT_TOKENS });
    await harness.controller.start(harness.run.id);

    await harness.controller.recover(harness.run.id);

    expect(harness.executor.callCount()).toBe(1);
    expect(harness.store.providerCallsAtRecoveryOpenCommit).toEqual([]);
    expect(harness.store.commits.some((candidate) => isRecoveryOpenCommit(candidate))).toBe(false);
    expect(harness.store.snapshot.state?.modelOutputRecovery?.phase).toBe("RESERVED");
  });
});

describe("RunController output recovery exits and provenance", () => {
  it.each(["START", "TOOL_RESULTS", "STEERING"] as const)(
    "preserves %s provenance and does not repeat history after the one recovery also truncates",
    async (mode) => {
      const harness = createHarness();
      const seeded = seedRetryMode(harness, mode);

      const first = await harness.controller.recover(harness.run.id);

      expect(first.status).toBe("WAITING_RETRY");
      const recoveryContinuation = harness.store.snapshot.continuation;
      expect(recoveryContinuation).toMatchObject({
        type: "WAITING_RETRY",
        attempt: 2,
        maxAttempts: 2,
        errorCode: "LLM_OUTPUT_TRUNCATED",
        mode,
      });
      if (mode === "TOOL_RESULTS") {
        expect(recoveryContinuation).toMatchObject({
          pendingDecision: TOOL_RESUME_DECISION,
          receivedResults: TOOL_RESUME_RESULTS,
          sourceStepId: seeded.sourceStepId,
        });
      } else if (mode === "STEERING") {
        expect(recoveryContinuation).toMatchObject({
          messageIds: seeded.steeringMessageIds,
          sourceStepId: seeded.sourceStepId,
        });
      }

      const second = await harness.controller.recover(harness.run.id);

      expect(second.run.status).toBe("FAILED");
      expect(harness.store.snapshot.state?.modelOutputRecovery).toMatchObject({ phase: "OPENED" });
      expect(harness.store.snapshot.continuation).toBeUndefined();
      expect(
        harness.store.commits
          .flatMap((commit) => commit.events)
          .filter((event) => event.type === "retry.scheduled"),
      ).toHaveLength(1);
      expect(
        harness.store.commits
          .flatMap((commit) => commit.events)
          .filter((event) => event.type === "retry.scheduled" && event.schemaVersion === 2),
      ).toHaveLength(1);
      expect(harness.executor.callCount()).toBe(2);
      expect(harness.executor.requests[0]?.messages.map(({ role }) => role)).toEqual(
        harness.executor.requests[1]?.messages.map(({ role }) => role),
      );
      expect(harness.store.snapshot.conversationRecords).toHaveLength(seeded.records.length);
      expect(
        harness.store.snapshot.conversationRecords.filter(
          (record) => record.messageType === "USER",
        ),
      ).toHaveLength(mode === "STEERING" ? 2 : 1);
      expect(
        harness.store.commits
          .flatMap((commit) => commit.events)
          .some((event) => event.type.startsWith("tool.")),
      ).toBe(false);
    },
  );

  it("fails a network error from the opened recovery without creating a normal retry episode", async () => {
    const harness = createHarness();
    await harness.controller.start(harness.run.id);
    harness.executor.resetScript(() => {
      throw aiError("AI_NETWORK", { message: "recovery socket closed" });
    });

    const result = await harness.controller.recover(harness.run.id);

    expect(result.run.status).toBe("FAILED");
    expect(harness.store.snapshot.state?.modelOutputRecovery).toMatchObject({ phase: "OPENED" });
    expect(harness.store.snapshot.continuation).toBeUndefined();
    const eventTypes = harness.store.commits.flatMap((commit) =>
      commit.events.map((event) => event.type),
    );
    expect(eventTypes.filter((type) => type === "retry.scheduled")).toHaveLength(1);
    expect(eventTypes).not.toContain("retry.exhausted");
    expect(harness.executor.callCount()).toBe(2);
  });

  it("lets cancellation during recovery usage settlement win over the network failure", async () => {
    const harness = createHarness({ cancelDuringRecoverySettlement: true });
    await harness.controller.start(harness.run.id);
    harness.executor.resetScript(() => {
      throw aiError("AI_NETWORK", { message: "recovery socket closed" });
    });

    const result = await harness.controller.recover(harness.run.id);

    expect(result.run.status).toBe("CANCELLED");
    expect(harness.store.snapshot.state?.modelOutputRecovery).toMatchObject({ phase: "OPENED" });
    expect(harness.store.snapshot.state?.currentStepId).toBeUndefined();
    expect(harness.store.snapshot.continuation).toBeUndefined();
    const retrySchedules = harness.store.commits
      .flatMap((commit) => commit.events)
      .filter((event) => event.type === "retry.scheduled");
    expect(retrySchedules).toHaveLength(1);
    expect(retrySchedules[0]).toMatchObject({ schemaVersion: 2 });
  });

  it("lets cancellation at the opened recovery failure commit win over FAILED", async () => {
    const harness = createHarness({ cancelBeforeRecoveryFailureCommit: true });
    await harness.controller.start(harness.run.id);
    harness.executor.resetScript(() => {
      throw aiError("AI_NETWORK", { message: "recovery socket closed" });
    });

    const result = await harness.controller.recover(harness.run.id);

    expect(result.run.status).toBe("CANCELLED");
    expect(harness.store.snapshot.state?.modelOutputRecovery).toMatchObject({ phase: "OPENED" });
    expect(harness.store.snapshot.state?.currentStepId).toBeUndefined();
    expect(harness.store.snapshot.continuation).toBeUndefined();
    expect(harness.store.recoveryFailureCancellationGuards).toEqual([true]);
    expect(
      harness.store.commits.flatMap((commit) => commit.events.map((event) => event.type)),
    ).not.toContain("run.failed");
    expect(harness.executor.callCount()).toBe(2);
  });

  it("fails an opened recovery closed on managed restart without creating a retry episode", async () => {
    const harness = createHarness();
    await harness.controller.start(harness.run.id);
    let enteredProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredProvider = resolve;
    });
    harness.executor.resetScript((_request, signal, callIndex) => {
      if (callIndex !== 1) throw new Error("unexpected Provider call count");
      enteredProvider();
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ kind: "CANCELLED" }), { once: true });
      });
    });
    const recovery = harness.controller.recover(harness.run.id);
    await entered;

    const checkpoint = await harness.controller.prepareForShutdown(harness.run.id);
    const result = await recovery;

    expect(checkpoint).toBe("ALREADY_SAFE");
    expect(result.run.status).toBe("FAILED");
    expect(harness.store.snapshot.state?.modelOutputRecovery).toMatchObject({ phase: "OPENED" });
    expect(harness.store.snapshot.continuation).toBeUndefined();
    expect(
      harness.store.commits
        .flatMap((commit) => commit.events)
        .filter((event) => event.type === "retry.scheduled"),
    ).toHaveLength(1);
    expect(harness.executor.callCount()).toBe(2);
  });

  it("retains OPENED after the recovery model turn returns a complete answer", async () => {
    const harness = createHarness();
    await harness.controller.start(harness.run.id);
    harness.executor.resetScript(() => ({
      text: "the recovered complete answer",
      finishReason: "STOP",
      usage: { inputTokens: 14, outputTokens: 60, totalTokens: 74 },
    }));

    const result = await harness.controller.recover(harness.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(result.run.status).toBe("COMPLETED");
    expect(result.run.finalResult).toMatchObject({
      type: "NORMAL_COMPLETION",
      text: "the recovered complete answer",
    });
    expect(harness.store.snapshot.state?.modelOutputRecovery).toMatchObject({ phase: "OPENED" });
    expect(harness.store.snapshot.conversationRecords).toHaveLength(2);
    expect(harness.store.snapshot.conversationRecords.at(-1)).toMatchObject({
      messageType: "ASSISTANT",
      source: { kind: "MODEL" },
      data: { phase: "FINAL_ANSWER" },
    });
    expect(harness.store.snapshot.continuation).toBeUndefined();
    expect(harness.executor.requests[1]?.settings?.maxOutputTokens).toBe(
      PREVIOUS_OUTPUT_TOKENS * 2,
    );
    expect(harness.executor.callCount()).toBe(2);
  });

  it("keeps a genuine recovery budget refusal on the existing budget authority path", async () => {
    const harness = createHarness({ recoveryAdmissionExceeded: true });
    await harness.controller.start(harness.run.id);

    const result = await harness.controller.recover(harness.run.id);

    expect(result.run.status).toBe("BUDGET_EXCEEDED");
    expect(harness.executor.callCount()).toBe(1);
    expect(harness.store.snapshot.state?.modelOutputRecovery).toMatchObject({ phase: "RESERVED" });
    expect(
      harness.store.commits
        .flatMap((commit) => commit.stepWrites)
        .filter((write) => write.operation === "INSERT"),
    ).toHaveLength(1);
    expect(harness.store.providerCallsAtRecoveryOpenCommit).toEqual([]);
    const eventTypes = harness.store.commits.flatMap((commit) =>
      commit.events.map((event) => event.type),
    );
    expect(eventTypes).toContain("budget.exceeded");
    expect(eventTypes).not.toContain("run.failed");
  });

  it("lets a deadline reached during recovery admission win before Provider I/O", async () => {
    let now = createTimestampMs(20);
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      timeoutMs: 1_000,
      now: () => now,
      onRecoveryAdmission: () => {
        if (harness.executor.callCount() === 1) now = createTimestampMs(1_021);
      },
    });
    await harness.controller.start(harness.run.id);
    let providerExecutions = 0;
    harness.executor.resetScript(() => {
      providerExecutions += 1;
      throw aiError("AI_NETWORK", { message: "deadline raced recovery admission" });
    });

    const result = await harness.controller.recover(harness.run.id);

    expect(result.run.status).toBe("TIMEOUT");
    expect(providerExecutions).toBe(0);
    expect(harness.store.snapshot.state?.modelOutputRecovery).toMatchObject({ phase: "RESERVED" });
  });

  it("settles cancellation that arrives during the recovery open boundary before Provider I/O", async () => {
    const harness = createHarness();
    await harness.controller.start(harness.run.id);
    let providerExecutions = 0;
    harness.executor.resetScript(() => {
      providerExecutions += 1;
      return { text: "must not be requested", finishReason: "STOP" };
    });
    let cancellation: Promise<unknown> | undefined;
    harness.store.beforeRecoveryOpenCommit = async () => {
      cancellation ??= harness.controller.cancel(harness.run.id);
      for (
        let attempt = 0;
        attempt < 10 && harness.store.snapshot.cancellationIntent === undefined;
        attempt += 1
      ) {
        await Promise.resolve();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };

    const result = await harness.controller.recover(harness.run.id);
    await cancellation;

    expect(result.run.status).toBe("CANCELLED");
    expect(providerExecutions).toBe(0);
    expect(harness.store.recoveryOpenCancellationGuards).toEqual([true]);
  });

  it("fails closed on an open-boundary CAS conflict without entering Provider I/O", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      onRecoveryAdmission: () => {
        if (harness.executor.callCount() !== 1) return;
        const nextRevision = (harness.store.stateRevision ?? 0) + 1;
        harness.store.stateRevision = nextRevision;
        harness.store.snapshot = { ...harness.store.snapshot, stateRevision: nextRevision };
      },
    });
    await harness.controller.start(harness.run.id);

    await expect(harness.controller.recover(harness.run.id)).rejects.toBeInstanceOf(
      RunControllerInfrastructureError,
    );

    expect(harness.executor.callCount()).toBe(1);
    expect(harness.store.providerCallsAtRecoveryOpenCommit).toEqual([]);
  });
});
