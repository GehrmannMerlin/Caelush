import type {
  AIModelRequest,
  AIModelTurnResult,
  AIPrivateCompletion,
  JsonObject,
} from "@caelush/ai";
import type {
  AgentTurnRef,
  ModelTurnExecutionResult,
  PrivateReplayStorePort,
} from "@caelush/agent";
import { createModelToolFeedbackProjector, createToolResultBatchNormalizer } from "@caelush/agent";
import { toContextObservationProjection } from "../src/agent-tool-batch.js";
import { createUserMessageAppend } from "../src/run-message-materializer.js";
import {
  AgentRunSchema,
  computeSecurityPolicyDigest,
  createEventId,
  createLLMCallId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type AgentStep,
  type StepId,
  type ToolName,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { completionStoreOver } from "./support/completion-store.js";
import { RunController } from "../src/run-controller.js";
import { RunExecutionConflictError } from "../src/run-execution-store.js";
import type {
  DurableAgentEvent,
  RunExecutionCommit,
  RunExecutionSnapshot,
  RunExecutionStore,
} from "../src/run-execution-store.js";
import type { RunExecutionConfigResolver } from "../src/run-controller-ports.js";
import type { RunAgentExecutionContextFactory } from "../src/run-agent-execution.js";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { aiError } from "./support/fake-model-turn-executor.js";
import {
  fakeContextEngine,
  fakeFrozenModelTurnExecutor,
  testRunAgentExecution,
  type FakeContextEngine,
  type FakeFrozenModelTurnExecutor,
} from "./support/run-agent-execution.js";
import { testRunMessageAuthority } from "./support/run-message-authority.js";

/**
 * The production direct Run execution path.
 *
 * ```text
 * RunController
 *   → RunExecutionCoordinator.next()
 *   → Run Layer Step allocation
 *   → createRunExecutionDriver(...)
 *   → frozen AgentLoop.advance()
 *   → Context → Admission → durable ModelTurnBoundary → Provider
 *   → canonical settlement
 * ```
 *
 * Phase 3C checkpoint 6 retired the legacy Core `AgentLoop` facade from this path, so these tests
 * assert the properties the cutover exists for: the Run Layer — not a facade — allocates the Step,
 * the driver executes the coordinator's exact directive, the durable boundary is what makes the Step
 * durable, and a failure before that boundary costs no Step and no provider call.
 */

const clock = {
  now: () => createTimestampMs(10),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  const securityPolicy = {
    schemaVersion: 1 as const,
    preset: { id: "VIEW_ONLY" as const, version: 1 },
    permissionProfile: "READ_ONLY" as const,
    approvalPolicy: "ON_BOUNDARY" as const,
    filesystemBoundary: "WORKSPACE_READ_ONLY" as const,
    processBoundary: "READ_ONLY" as const,
    requiredEnforcement: "OS_RESTRICTED" as const,
    hardSafetyPolicyVersion: "hard-safety@1",
    commandPolicyVersion: "command-policy@1",
    secretPolicyVersion: "secret-policy@1",
    createdAt: new Date(1).toISOString(),
  };
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect project",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ON_BOUNDARY",
    securityPolicy: {
      ...securityPolicy,
      policyDigest: computeSecurityPolicyDigest(securityPolicy),
    },
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 100_000 },
    completionContract: "NATURAL_V1",
    createdAt: createTimestampMs(1),
    ...overrides,
  });
}

/**
 * A store that commits the way the production store does.
 *
 * Every load is checked by the controller's own invariant, and the boundary CAS compares the two
 * revisions, so a fixture that dropped either would be testing a shape production cannot produce.
 */
class MemoryExecutionStore implements RunExecutionStore {
  stateRevision: number | undefined;
  continuationRevision: number | undefined;
  readonly commits: RunExecutionCommit[] = [];
  readonly steps = new Map<StepId, AgentStep>();
  private sequence = 0;
  failNextCommit: Error | undefined;

  constructor(public snapshot: RunExecutionSnapshot) {
    this.stateRevision = snapshot.stateRevision;
    this.continuationRevision = snapshot.continuationRevision;
  }

  async load(): Promise<RunExecutionSnapshot> {
    return this.snapshot;
  }

  async requestCancellation(
    runId: ReturnType<typeof createRunId>,
    intent: RunExecutionSnapshot["cancellationIntent"],
  ): Promise<RunExecutionSnapshot> {
    if (intent === undefined || intent.runId !== runId) throw new Error("invalid cancellation");
    this.snapshot = { ...this.snapshot, cancellationIntent: intent };
    return this.snapshot;
  }

  async commit(command: RunExecutionCommit) {
    if (this.failNextCommit !== undefined) {
      const error = this.failNextCommit;
      this.failNextCommit = undefined;
      throw error;
    }
    this.commits.push(command);
    if (command.state !== undefined) this.stateRevision = (this.stateRevision ?? 0) + 1;
    for (const write of command.stepWrites) this.steps.set(write.step.id, write.step);
    const activeStep = command.stepWrites.find((write) => write.step.status === "RUNNING")?.step;
    const nextContinuation =
      command.continuation === undefined
        ? this.snapshot.continuation
        : command.continuation.operation === "CLEAR"
          ? undefined
          : command.continuation.checkpoint;
    if (command.continuation?.operation === "SET") {
      this.continuationRevision = (this.continuationRevision ?? 0) + 1;
    }
    if (command.continuation?.operation === "CLEAR") this.continuationRevision = undefined;

    const conversationRecords = [
      ...this.snapshot.conversationRecords,
      ...command.messagesToAppend.map((entry, index) => ({
        runId: command.run.id,
        sequence: this.snapshot.conversationRecords.length + index + 1,
        ...entry.draft,
      })),
    ];
    this.snapshot = {
      run: command.run,
      conversationRecords,
      // An absent `state` means "this transition leaves it alone", which is what the canonical
      // commit contract says and what the production store does. A continuation-only transition —
      // which is exactly what accepting a Tool batch is — therefore keeps the AgentState it was
      // already holding instead of dropping it.
      ...(command.state === undefined
        ? this.snapshot.state === undefined
          ? {}
          : { state: this.snapshot.state }
        : { state: command.state }),
      ...(this.stateRevision === undefined ? {} : { stateRevision: this.stateRevision }),
      ...(activeStep === undefined ? {} : { activeStep }),
      ...(nextContinuation === undefined ? {} : { continuation: nextContinuation }),
      ...(nextContinuation === undefined || this.continuationRevision === undefined
        ? {}
        : { continuationRevision: this.continuationRevision }),
    };
    const events: DurableAgentEvent[] = command.events.map((draft) => ({
      ...draft,
      durability: { ...draft.durability, sequence: ++this.sequence },
    }));
    return { snapshot: this.snapshot, events };
  }
}

/** One recorded provider turn. */
interface ObservedTurn {
  readonly turn: AgentTurnRef;
  readonly request: AIModelRequest;
}

interface Harness {
  readonly controller: RunController;
  readonly store: MemoryExecutionStore;
  readonly notifications: DurableAgentEvent[];
  /** Every Step id the Run Layer allocated, in allocation order. */
  readonly allocatedSteps: StepId[];
  readonly observed: ObservedTurn[];
  readonly executor: FakeFrozenModelTurnExecutor;
  readonly contextEngine: FakeContextEngine;
}

function harness(options: {
  readonly run?: ReturnType<typeof makeRun>;
  readonly snapshot?: Partial<RunExecutionSnapshot>;
  readonly executor: FakeFrozenModelTurnExecutor;
  readonly contextEngine?: FakeContextEngine;
  readonly configResolver?: RunExecutionConfigResolver;
  readonly clock?: { now(): ReturnType<typeof createTimestampMs> };
  readonly extra?: Record<string, unknown>;
}): Harness {
  const run = options.run ?? makeRun();
  const store = new MemoryExecutionStore({
    run,
    conversationRecords: [],
    ...options.snapshot,
  });
  const notifications: DurableAgentEvent[] = [];
  const allocatedSteps: StepId[] = [];
  const observed: ObservedTurn[] = [];
  let ordinal = 0;
  const execution: RunAgentExecutionContextFactory = testRunAgentExecution({
    executor: options.executor,
    ...(options.contextEngine === undefined ? {} : { contextEngine: options.contextEngine }),
    createStepId: () => {
      ordinal += 1;
      const id = `stp_0195f3a0-0000-7000-8000-${String(ordinal).padStart(12, "0")}` as StepId;
      allocatedSteps.push(id);
      return id;
    },
    onTurn: (turn, request) => observed.push({ turn, request }),
  }).factory;

  const controller = new RunController({
    agentExecution: execution,
    executionStore: store,
    messages: testRunMessageAuthority({ snapshot: () => store.snapshot }),
    completionStore: completionStoreOver(store),
    events: {
      notifyCommitted: (events: readonly DurableAgentEvent[]) => notifications.push(...events),
      emitTransient: () => undefined,
    },
    configResolver: options.configResolver ?? {
      resolve: async () => ({ baseSystemPrompt: "base", contextLimits: { maxInputTokens: 1000 } }),
    },
    clock: options.clock ?? clock,
    eventIdFactory: { create: createEventId },
    // Phase 3D owns the real Tool boundary; this stands in for the one production composition
    // supplies so the Run round trip (`TOOL_REQUESTS → batch → accepted results → resume`) is
    // exercised end to end rather than stopping at the boundary. Phase 4D: the scheduler is the
    // canonical `ToolBatchCoordinator`, and the projector and normalizer beside it are the real
    // canonical ones.
    toolTurn: {
      batches: toolCoordinatorFixture(),
      feedback: createModelToolFeedbackProjector({
        projection: toContextObservationProjection(),
      }),
      normalizer: createToolResultBatchNormalizer(),
    },
    // The FinalCandidate compatibility bridge opens the durable plan. This fixture deliberately omits
    // verification execution, so Core must fail the Run after the boundary instead of parking it.
    verificationPlanner: {
      plan: ({
        runId,
        sourceStepId,
      }: {
        runId: ReturnType<typeof createRunId>;
        sourceStepId: StepId;
      }) => ({
        runId,
        sourceStepId,
        plannerVersion: "phase-11a.v1",
        planHash: "b".repeat(64),
        checks: [
          {
            ordinal: 0,
            stage: "ACCEPTANCE",
            requirement: "REQUIRED",
            spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
          },
        ],
      }),
    },
    ...options.extra,
  } as never);
  return {
    controller,
    store,
    notifications,
    allocatedSteps,
    observed,
    executor: options.executor,
    contextEngine: options.contextEngine ?? fakeContextEngine(),
  };
}

/**
 * The Tool batch fixture.
 *
 * It answers each requested call with a canonical `OBSERVATION` item, in the assistant's own source
 * order, which is the contract the Run Layer's conversion depends on. The observation is a durable one:
 * the canonical batch carries the settled ToolObservation, not a flat content string. What reaches the
 * model is still only `toolCallId`, `toolName`, `content` and `isError` — the invocation id and the
 * observation id stay in the Tool Layer.
 */
function toolCoordinatorFixture(
  options: { readonly content?: string; readonly isError?: boolean } = {},
): {
  execute(request: {
    readonly calls: readonly {
      readonly externalCallId: string;
      readonly toolName: ToolName;
      readonly args: JsonObject;
    }[];
  }): Promise<{ readonly kind: "COMPLETED"; readonly items: readonly unknown[] }>;
} {
  return {
    async execute(request) {
      return {
        kind: "COMPLETED",
        items: request.calls.map((call, index) => ({
          kind: "OBSERVATION",
          call,
          invocationId: `tiv_0195f3a0-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
          finalStatus: "COMPLETED",
          observation: {
            id: `obs_0195f3a0-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
            runId: "run_0195f3a0-0000-7000-8000-000000000001",
            stepId: "stp_0195f3a0-0000-7000-8000-000000000001",
            kind: "TOOL",
            toolInvocationId: `tiv_0195f3a0-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
            content: options.content ?? "the file body",
            isError: options.isError ?? false,
            createdAt: 1,
          },
        })),
      };
    },
  };
}

function turn(partial: Partial<AIModelTurnResult> = {}): AIModelTurnResult {
  return {
    callId: createLLMCallId() as never,
    providerId: "fixture",
    model: { provider: "fixture", model: "fixture-model" },
    text: partial.text ?? "candidate",
    toolCalls: partial.toolCalls ?? [],
    ...(partial.finishReason === undefined
      ? { finishReason: "STOP" as const }
      : { finishReason: partial.finishReason }),
    ...(partial.usage === undefined ? {} : { usage: partial.usage }),
    resolution: {
      api: "test-api",
      reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
      cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
    },
  };
}

const eventTypes = (commit: RunExecutionCommit | undefined): readonly string[] =>
  (commit?.events ?? []).map((event) => event.type);

/** A provider script that asks for one Tool on its first turn and answers on the next. */
function toolThenAnswer(answer = "done"): FakeFrozenModelTurnExecutor {
  let calls = 0;
  return fakeFrozenModelTurnExecutor(async () => {
    calls += 1;
    if (calls > 1) return turn({ text: answer });
    return {
      kind: "COMPLETED",
      result: turn({
        text: "",
        finishReason: "TOOL_CALLS",
        toolCalls: [{ id: "call_a", name: "read_file", input: { path: "a.ts" } }] as never,
      }),
    };
  });
}

describe("production ADVANCE_AGENT settlement", () => {
  it("checkpoints an interrupted model turn before managed shutdown returns", async () => {
    const enteredProvider = deferred<void>();
    const call = fakeFrozenModelTurnExecutor((_request, signal) => {
      enteredProvider.resolve();
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ kind: "CANCELLED" }), { once: true });
      });
    });
    const h = harness({ executor: call, clock: { now: () => createTimestampMs(10) } });
    const running = h.controller.start(h.store.snapshot.run.id);

    await enteredProvider.promise;
    const checkpoint = await h.controller.prepareForShutdown(h.store.snapshot.run.id);
    await running;

    expect(checkpoint).toBe("CHECKPOINTED");
    expect(call.signals[0]?.aborted).toBe(true);
    expect(h.store.snapshot.run.status).toBe("RUNNING");
    expect(h.store.snapshot.continuation).toMatchObject({
      type: "WAITING_RETRY",
      errorCode: "LLM_NETWORK",
      attempt: 2,
    });
    expect(h.store.steps.get(h.allocatedSteps[0]!)).toMatchObject({ status: "FAILED" });
    expect(h.store.commits.at(-1)?.events.map((event) => event.type)).toEqual([
      "llm.failed",
      "retry.scheduled",
    ]);
  });

  it("keeps user cancellation terminal instead of turning it into a managed retry", async () => {
    const enteredProvider = deferred<void>();
    const call = fakeFrozenModelTurnExecutor((_request, signal) => {
      enteredProvider.resolve();
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ kind: "CANCELLED" }), { once: true });
      });
    });
    const h = harness({ executor: call });
    const running = h.controller.start(h.store.snapshot.run.id);

    await enteredProvider.promise;
    await h.controller.cancel(h.store.snapshot.run.id);
    await running;

    expect(h.store.snapshot.run.status).toBe("CANCELLED");
    expect(h.store.snapshot.continuation).toBeUndefined();
    expect(h.notifications.map((event) => event.type)).not.toContain("retry.scheduled");
  });

  it("lets a durable cancellation that wins at the final-candidate boundary prevent natural completion", async () => {
    let store: MemoryExecutionStore | undefined;
    const call = fakeFrozenModelTurnExecutor(async () => {
      if (store === undefined) throw new Error("execution store is not ready");
      const runId = store.snapshot.run.id;
      await store.requestCancellation(runId, {
        runId,
        cause: "USER_REQUESTED",
        requestedAt: createTimestampMs(20),
      });
      return turn({ text: "candidate after cancellation" });
    });
    const h = harness({ executor: call });
    store = h.store;

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(h.store.snapshot.run.status).toBe("CANCELLED");
    expect(h.store.snapshot.run.finalResult).toBeUndefined();
    expect(
      h.store.commits.some(
        (commit) =>
          typeof commit.run.finalResult === "object" &&
          commit.run.finalResult !== null &&
          "type" in commit.run.finalResult &&
          commit.run.finalResult.type === "NORMAL_COMPLETION",
      ),
    ).toBe(false);
  });

  it("does not claim a shutdown checkpoint when its retry transaction fails", async () => {
    const enteredProvider = deferred<void>();
    const call = fakeFrozenModelTurnExecutor((_request, signal) => {
      enteredProvider.resolve();
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ kind: "CANCELLED" }), { once: true });
      });
    });
    const h = harness({ executor: call });
    const running = h.controller.start(h.store.snapshot.run.id);

    await enteredProvider.promise;
    h.store.failNextCommit = new Error("simulated transaction failure");
    const checkpoint = await h.controller.prepareForShutdown(h.store.snapshot.run.id);
    await expect(running).rejects.toThrow("Unable to persist Run execution");

    expect(checkpoint).toBe("UNSAFE_IN_FLIGHT");
    expect(h.store.snapshot.activeStep?.status).toBe("RUNNING");
    expect(h.store.snapshot.continuation).toBeUndefined();
    expect(h.notifications.map((event) => event.type)).not.toContain("retry.scheduled");
  });

  it("does not abort or reclassify an in-flight Tool batch as a model retry", async () => {
    const enteredBatch = deferred<void>();
    const releaseBatch = deferred<void>();
    const batchFixture = toolCoordinatorFixture();
    const executor = toolThenAnswer();
    const h = harness({
      executor,
      extra: {
        toolTurn: {
          batches: {
            async execute(request: Parameters<typeof batchFixture.execute>[0]) {
              enteredBatch.resolve();
              await releaseBatch.promise;
              return batchFixture.execute(request);
            },
          },
          feedback: createModelToolFeedbackProjector({
            projection: toContextObservationProjection(),
          }),
          normalizer: createToolResultBatchNormalizer(),
        },
      },
    });
    const running = h.controller.start(h.store.snapshot.run.id);

    await enteredBatch.promise;
    const checkpoint = await h.controller.prepareForShutdown(h.store.snapshot.run.id);
    expect(checkpoint).toBe("UNSAFE_IN_FLIGHT");
    expect(executor.signals[0]?.aborted).toBe(false);
    releaseBatch.resolve();
    await running;

    expect(h.notifications.map((event) => event.type)).not.toContain("retry.scheduled");
    expect(h.store.snapshot.run.status).toBe("COMPLETED");
    expect(h.store.snapshot.continuation).toBeUndefined();
  });

  it("drives a complete Tool round trip through the driver, the planner and the frozen loop", async () => {
    const executor = toolThenAnswer();
    const h = harness({ executor });

    const result = await h.controller.start(h.store.snapshot.run.id);

    // Turn 1 asked for a Tool, the batch ran, and turn 2 answered it. Two attempts, two Steps, and
    // no Step was reused.
    expect(h.observed).toHaveLength(2);
    expect(h.allocatedSteps).toHaveLength(2);
    expect(new Set(h.allocatedSteps).size).toBe(2);
    expect(h.observed[0]!.turn.stepId).toBe(h.allocatedSteps[0]);
    expect(h.observed[1]!.turn.stepId).toBe(h.allocatedSteps[1]);
    expect(h.observed[0]!.turn.sequence).toBe(1);
    expect(h.observed[1]!.turn.sequence).toBe(2);
    expect(h.store.steps.get(h.allocatedSteps[0]!)).toMatchObject({ status: "COMPLETED" });
    expect(h.store.steps.get(h.allocatedSteps[1]!)).toMatchObject({ status: "COMPLETED" });

    // What the model saw, turn by turn: the goal, then the goal plus the pending assistant tool call
    // and its result — each exactly once, with nothing duplicated and nothing dropped.
    expect(h.observed[0]!.request.messages.map((message) => message.role)).toEqual(["user"]);
    expect(h.observed[1]!.request.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(
      h.observed[1]!.request.messages.find((message) => message.role === "tool"),
    ).toMatchObject({ toolCallId: "call_a", toolName: "read_file", isError: false });

    // The durable ledger holds one user, one assistant, one tool result and the answering assistant
    // message; the tool result is attributed to the Step that requested the batch — never to the
    // resume attempt.
    expect(h.store.snapshot.conversationRecords.map((entry) => entry.messageType)).toEqual([
      "USER",
      "ASSISTANT",
      "TOOL_RESULT",
      "ASSISTANT",
    ]);
    const toolEntry = h.store.snapshot.conversationRecords.find(
      (entry) => entry.messageType === "TOOL_RESULT",
    );
    expect(toolEntry?.sourceStepId).toBe(h.allocatedSteps[0]);
    expect(h.store.snapshot.state?.usage.steps).toBe(2);

    // Both attempts announced themselves exactly once, and each was described exactly once.
    const types = h.notifications.map((event) => event.type);
    expect(types.filter((type) => type === "llm.started")).toHaveLength(2);
    expect(types.filter((type) => type === "llm.completed")).toHaveLength(2);
    // The final candidate settles directly under the Run's persisted natural-completion contract.
    expect(result.status).toBe("TERMINAL");
    expect(h.store.snapshot.run.status).toBe("COMPLETED");
    expect(h.store.snapshot.run.finalResult).toMatchObject({
      type: "NORMAL_COMPLETION",
      text: "done",
      sourceStepId: h.allocatedSteps[1],
    });
    expect(h.store.snapshot.state?.verification).toBe("NOT_RUN");
    expect(types).not.toContain("verification.planned");
    expect(types).toContain("run.completed");
    expect(types).not.toContain("run.failed");
  });

  it("completes execution while preserving a real failed Tool observation in the answer history", async () => {
    const finalText = "pytest exited with code 1; the remaining failure is documented below.";
    const h = harness({
      executor: toolThenAnswer(finalText),
      extra: {
        toolTurn: {
          batches: toolCoordinatorFixture({ content: "pytest: 1 failed", isError: true }),
          feedback: createModelToolFeedbackProjector({
            projection: toContextObservationProjection(),
          }),
          normalizer: createToolResultBatchNormalizer(),
        },
      },
    });

    const result = await h.controller.start(h.store.snapshot.run.id);
    const toolResult = h.store.snapshot.conversationRecords.find(
      (record) => record.messageType === "TOOL_RESULT",
    );

    expect(result.status).toBe("TERMINAL");
    expect(h.store.snapshot.run.status).toBe("COMPLETED");
    expect(h.store.snapshot.run.finalResult).toMatchObject({
      type: "NORMAL_COMPLETION",
      text: finalText,
    });
    expect(h.store.snapshot.state?.verification).toBe("NOT_RUN");
    expect(toolResult?.data.projectedContent).toBe("pytest: 1 failed");
    expect(toolResult?.data.isError).toBe(true);
    expect(JSON.stringify(h.store.snapshot.run.finalResult)).not.toContain("PASSED");
  });

  it("naturally completes without consulting the default Verification planner", async () => {
    let plannerCalls = 0;
    const h = harness({
      executor: fakeFrozenModelTurnExecutor(async () => turn()),
      extra: {
        verificationPlanner: {
          plan() {
            plannerCalls += 1;
            throw new Error("new Run should not plan forced verification");
          },
        },
      },
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("TERMINAL");
    expect(h.store.snapshot.run.status).toBe("COMPLETED");
    expect(h.store.snapshot.run.finalResult).toMatchObject({
      type: "NORMAL_COMPLETION",
      text: "candidate",
      sourceStepId: h.allocatedSteps[0],
    });
    expect(plannerCalls).toBe(0);
    // The final candidate's Step and Assistant message settle in one normal execution commit.
    expect(h.store.steps.get(h.allocatedSteps[0]!)).toMatchObject({ status: "COMPLETED" });
    expect(h.store.snapshot.state?.usage.steps).toBe(1);
    expect(
      h.store.snapshot.conversationRecords.filter((record) => record.messageType === "ASSISTANT"),
    ).toHaveLength(1);
    expect(h.store.snapshot.continuation).toBeUndefined();
    const types = h.notifications.map((event) => event.type);
    expect(types).not.toContain("verification.planned");
    expect(types).not.toContain("verification.finalized");
    expect(types).toContain("run.completed");
    const messageIndex = types.indexOf("conversation.message.committed");
    const statusIndex = types.lastIndexOf("status.changed");
    const completedIndex = types.indexOf("run.completed");
    expect(messageIndex).toBeLessThan(statusIndex);
    expect(statusIndex).toBeLessThan(completedIndex);
    expect(types.filter((type) => type === "llm.completed")).toHaveLength(1);
    expect(types.filter((type) => type === "reasoning.summary")).toHaveLength(1);
  });

  it("commits final-answer replay state with the natural completion message", async () => {
    const executor = fakeFrozenModelTurnExecutor(async () => turn({ text: "replay-safe answer" }));
    const baseExecution = testRunAgentExecution({ executor }).factory;
    const execution: RunAgentExecutionContextFactory = {
      async resolve(run) {
        const resolved = await baseExecution.resolve(run);
        return {
          ...resolved,
          modelTurnExecutor: {
            async execute(input) {
              const outcome = await resolved.modelTurnExecutor.execute(input);
              if (outcome.kind === "COMPLETED") {
                const modelTurn = outcome.result;
                const completion: AIPrivateCompletion = {
                  callId: modelTurn.callId,
                  providerId: modelTurn.model.provider,
                  model: modelTurn.model,
                  api: modelTurn.resolution.api,
                  completeness: "COMPLETE",
                  payload: Buffer.from("private replay for final answer"),
                };
                input.privateCompletionSink?.(completion);
              }
              return outcome;
            },
          },
        };
      },
    };
    const prepared: { readonly runId: string; readonly content: string }[] = [];
    const privateReplayStore: PrivateReplayStorePort = {
      async prepare(identity, content) {
        prepared.push({ runId: identity.runId, content: Buffer.from(content).toString("utf8") });
        return {
          identity,
          envelope: {
            version: 1,
            keyId: "fixture",
            nonce: "fixture-nonce",
            tag: "fixture-tag",
            ciphertext: "fixture-ciphertext",
            contentMac: "fixture-mac",
          },
        };
      },
      forExecution() {
        return {
          async read() {
            throw new Error("unused");
          },
        };
      },
    };
    const h = harness({
      executor,
      extra: { agentExecution: execution, privateReplayStore },
    });

    await h.controller.start(h.store.snapshot.run.id);

    const finalCommit = h.store.commits.at(-1);
    expect(h.store.snapshot.run.finalResult).toMatchObject({ type: "NORMAL_COMPLETION" });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.runId).toBe(h.store.snapshot.run.id);
    expect(prepared[0]?.content).toBe("private replay for final answer");
    expect(finalCommit?.messagesToAppend).toHaveLength(1);
    expect(finalCommit?.messagesToAppend[0]?.draft.data).toMatchObject({
      phase: "FINAL_ANSWER",
      providerState: { payload: { kind: "caelush.private-replay.v1" } },
    });
    expect(finalCommit?.privateReplayWrites).toHaveLength(1);
  });

  it("drives one Reason through the driver and the frozen loop, and never through the legacy facade", async () => {
    const call = fakeFrozenModelTurnExecutor(async () => turn());
    const h = harness({ executor: call });

    await h.controller.start(h.store.snapshot.run.id);

    // The Run Layer allocated exactly one Step before the loop ran, and the driver handed the loop
    // exactly that turn.
    expect(h.allocatedSteps).toHaveLength(1);
    expect(h.observed).toHaveLength(1);
    expect(h.observed[0]!.turn.stepId).toBe(h.allocatedSteps[0]);
    expect(h.observed[0]!.turn.sequence).toBe(1);
    // The Step became durable with the identity the Run Layer allocated — the loop never created one.
    expect(h.store.steps.get(h.allocatedSteps[0]!)).toMatchObject({
      id: h.allocatedSteps[0],
      sequence: 1,
      status: "COMPLETED",
    });
    // Exactly one provider turn.
    expect(call.callCount()).toBe(1);
    // And the attempt was announced exactly once, before the provider was entered.
    expect(eventTypes(h.store.commits.find((c) => c.stepWrites.length > 0))).toEqual([
      "llm.started",
    ]);
  });

  it("costs no durable Step and no provider call when the context cannot be prepared", async () => {
    const call = fakeFrozenModelTurnExecutor(async () => turn());
    const contextEngine = fakeContextEngine();
    contextEngine.prepareFailure = Object.assign(new Error("context exploded"), {
      code: "CONTEXT_PREPARE_FAILED",
    });
    const h = harness({ executor: call, contextEngine });

    await h.controller.start(h.store.snapshot.run.id);

    // The Step object existed in memory only: no row, no provider call, and the attempt is the
    // sanitized context failure rather than a model failure.
    expect(h.store.steps.size).toBe(0);
    expect(call.callCount()).toBe(0);
    expect(h.observed).toHaveLength(0);
    expect(h.store.snapshot.activeStep).toBeUndefined();
    expect(h.store.snapshot.state?.currentStepId).toBeUndefined();
  });

  it("refuses the turn at admission with zero boundary calls and zero durable Steps", async () => {
    const call = fakeFrozenModelTurnExecutor(async () => turn());
    let admissions = 0;
    const h = harness({
      executor: call,
      extra: {
        budget: {
          admitLLM: async () => {
            admissions += 1;
            return {
              kind: "EXCEEDED",
              dimension: "TOKENS",
              accounted: 900,
              limit: 100,
            };
          },
          settleLLM: async () => ({ kind: "SETTLED" }),
        },
      },
    });

    const result = await h.controller.start(h.store.snapshot.run.id);

    // Context ran, admission ran, and the boundary and the provider both cost nothing.
    expect(admissions).toBe(1);
    expect(call.callCount()).toBe(0);
    expect(h.store.steps.size).toBe(0);
    expect(h.store.commits.flatMap((commit) => commit.stepWrites)).toHaveLength(0);
    expect(result.run.status).toBe("BUDGET_EXCEEDED");
    expect(h.store.snapshot.state?.currentStepId).toBeUndefined();
  });

  it("refuses to open a turn whose effect-start snapshot is no longer durable", async () => {
    const call = fakeFrozenModelTurnExecutor(async () => turn());
    const contextEngine = fakeContextEngine();
    let moved = false;
    // The AgentState revision moves *after* the coordinator decided and *before* the boundary is
    // entered, which is exactly the window the CAS exists to catch.
    const original = contextEngine.prepare.bind(contextEngine);
    contextEngine.prepare = async (input) => {
      if (!moved) {
        moved = true;
        const current = h.store.snapshot;
        h.store.snapshot = {
          ...current,
          state: current.state === undefined ? undefined : { ...current.state },
          stateRevision: (current.stateRevision ?? 0) + 1,
        } as RunExecutionSnapshot;
      }
      return original(input);
    };
    const h = harness({ executor: call, contextEngine });

    await expect(h.controller.start(h.store.snapshot.run.id)).rejects.toThrow(
      /Unable to durably open the model turn/,
    );

    // No provider call, no Step row, no `llm.started`, and the Run is *not* falsely failed.
    expect(call.callCount()).toBe(0);
    expect(h.store.steps.size).toBe(0);
    expect(h.notifications.map((event) => event.type)).not.toContain("llm.started");
    expect(h.store.snapshot.run.status).toBe("RUNNING");
  });

  it("settles a non-retryable provider failure as a failed Run with the right event vocabulary", async () => {
    const call = fakeFrozenModelTurnExecutor(async (): Promise<ModelTurnExecutionResult> => ({
      kind: "FAILED",
      error: {
        code: "AUTHENTICATION",
        message: "The model turn failed.",
        retryable: false,
      },
    }));
    const h = harness({ executor: call });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.run.status).toBe("FAILED");
    expect(h.store.steps.get(h.allocatedSteps[0]!)?.status).toBe("FAILED");
    expect(h.store.snapshot.state?.usage.steps).toBe(1);
    expect(h.store.snapshot.continuation).toBeUndefined();
    // The ledger records the user turn the Run failed on. No provider output is appended: the
    // attempt produced none, and inventing one would durably record an answer the model never gave.
    expect(h.store.snapshot.conversationRecords.map((entry) => entry.messageType)).toEqual([
      "USER",
    ]);
    expect(h.notifications.map((event) => event.type)).toEqual([
      "run.started",
      "status.changed",
      "conversation.message.committed",
      "llm.started",
      "llm.failed",
      "error",
      "status.changed",
      "run.failed",
    ]);
    expect(h.notifications.map((event) => event.type)).not.toContain("retry.exhausted");
  });

  it("reports a classifier rejection of a completed provider turn without claiming the provider failed", async () => {
    // The provider answered with a finish reason the classifier refuses: the turn completed and the
    // answer was unusable, which is a different fact from a provider failure.
    const call = fakeFrozenModelTurnExecutor(async () =>
      turn({ text: "", finishReason: "LENGTH" as never, toolCalls: [] }),
    );
    const h = harness({ executor: call });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.run.status).toBe("FAILED");
    const types = h.notifications.map((event) => event.type);
    // A completed provider turn is never recorded as `llm.failed`.
    expect(types).not.toContain("llm.failed");
    expect(types).toContain("llm.completed");
    expect(types).toContain("error");
    expect(types).toContain("status.changed");
    expect(types).toContain("run.failed");
  });

  it("settles a retryable provider failure as a durable retry boundary, and resumes it as a new Step", async () => {
    let calls = 0;
    const call = fakeFrozenModelTurnExecutor(async (): Promise<ModelTurnExecutionResult> => {
      calls += 1;
      if (calls === 1) throw aiError("AI_NETWORK");
      return { kind: "COMPLETED", result: turn({ text: "recovered" }) };
    });
    const h = harness({ executor: call });

    await h.controller.start(h.store.snapshot.run.id);

    // The attempt is settled exactly once, scheduled exactly once, and never routed through the
    // planner's terminal-failure branch.
    expect(h.store.steps.get(h.allocatedSteps[0]!)?.status).toBe("FAILED");
    expect(h.store.snapshot.state?.usage.steps).toBe(1);
    expect(h.store.snapshot.continuation?.type).toBe("WAITING_RETRY");
    expect(h.store.snapshot.run.status).toBe("RUNNING");
    const types = h.notifications.map((event) => event.type);
    expect(types.filter((type) => type === "retry.scheduled")).toHaveLength(1);
    expect(types.filter((type) => type === "llm.failed")).toHaveLength(1);
    expect(types).not.toContain("run.failed");
    // A failed attempt appends no message: the next attempt must not duplicate its own turn input.
    expect(
      h.store.commits
        .filter((commit) => commit.events.some((event) => event.type === "llm.failed"))
        .flatMap((commit) => commit.messagesToAppend),
    ).toHaveLength(0);

    // When the retry becomes due, the resume allocates a *new* Step: the failed Step is never reused.
    h.store.snapshot = {
      ...h.store.snapshot,
      continuation: {
        ...(h.store.snapshot.continuation as { type: "WAITING_RETRY" }),
        nextAttemptAt: createTimestampMs(0),
      } as never,
    };
    await h.controller.recover(h.store.snapshot.run.id);

    expect(h.allocatedSteps).toHaveLength(2);
    expect(h.observed).toHaveLength(2);
    expect(h.observed[1]!.turn.stepId).toBe(h.allocatedSteps[1]);
    expect(h.observed[1]!.turn.stepId).not.toBe(h.allocatedSteps[0]);
    // The retry announced itself before the attempt, and the attempt really ran.
    const retryStart = h.notifications.filter((event) => event.type === "retry.started");
    expect(retryStart).toHaveLength(1);
    expect(h.executor.callCount()).toBe(2);
  });

  it("runs one initial attempt plus five retries before terminal failure", async () => {
    const call = fakeFrozenModelTurnExecutor(async () => {
      throw aiError("AI_NETWORK");
    });
    const h = harness({ executor: call });

    await h.controller.start(h.store.snapshot.run.id);
    for (let retry = 0; retry < 5; retry += 1) {
      const continuation = h.store.snapshot.continuation;
      if (continuation?.type !== "WAITING_RETRY") break;
      h.store.snapshot = {
        ...h.store.snapshot,
        continuation: { ...continuation, nextAttemptAt: createTimestampMs(0) },
      };
      await h.controller.recover(h.store.snapshot.run.id);
    }

    expect(call.callCount()).toBe(6);
    expect(h.allocatedSteps).toHaveLength(6);
    expect(new Set(h.allocatedSteps).size).toBe(6);
    expect(h.allocatedSteps.map((stepId) => h.store.steps.get(stepId)?.status)).toEqual(
      Array.from({ length: 6 }, () => "FAILED"),
    );
    expect(h.store.snapshot.run.status).toBe("FAILED");
    expect(h.store.snapshot.continuation).toBeUndefined();
    expect(h.notifications.filter((event) => event.type === "llm.failed")).toHaveLength(6);
    expect(h.notifications.filter((event) => event.type === "retry.scheduled")).toHaveLength(5);
    expect(h.notifications.filter((event) => event.type === "retry.started")).toHaveLength(5);
    const exhausted = h.notifications.filter((event) => event.type === "retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({
      payload: {
        attempt: 6,
        maxAttempts: 6,
        retriesUsed: 5,
        maxRetries: 5,
        errorCode: "LLM_NETWORK",
        reason: "ATTEMPTS_EXHAUSTED",
      },
    });
    expect(h.store.commits.at(-1)?.events.map((event) => event.type)).toEqual([
      "llm.failed",
      "retry.exhausted",
      "error",
      "status.changed",
      "run.failed",
    ]);
    expect(
      h.store.commits
        .filter((commit) => commit.events.some((event) => event.type === "llm.failed"))
        .flatMap((commit) => commit.messagesToAppend),
    ).toHaveLength(0);
  });

  it("persists and resumes a same-provider transport selection before retry I/O", async () => {
    const call = fakeFrozenModelTurnExecutor(async () => {
      throw aiError("AI_NETWORK");
    });
    const recovery = {
      initial: ({ providerId, modelId }: { providerId: string; modelId: string }) => ({
        providerId,
        modelId,
        transportId: "default",
      }),
      next: ({
        current,
        attemptedTransportIds,
        errorCode,
      }: {
        current: { providerId: string; modelId: string; transportId: string };
        attemptedTransportIds: readonly string[];
        errorCode: string;
      }) =>
        errorCode === "LLM_NETWORK" && !attemptedTransportIds.includes("backup")
          ? { ...current, transportId: "backup" }
          : undefined,
    };
    let now = 10;
    const h = harness({
      executor: call,
      clock: { now: () => createTimestampMs(now) },
      extra: { modelTransportRecovery: recovery },
    });

    const waiting = await h.controller.start(h.store.snapshot.run.id);

    expect(waiting.status).toBe("WAITING_RETRY");
    expect(h.store.snapshot.continuation).toMatchObject({
      type: "WAITING_RETRY",
      transport: {
        currentTransportId: "backup",
        attemptedTransportIds: ["default", "backup"],
      },
    });
    const retryCommit = h.store.commits.find((commit) =>
      commit.events.some((event) => event.type === "retry.scheduled"),
    );
    expect(retryCommit?.events.map((event) => event.type)).toEqual([
      "llm.failed",
      "transport.fallback.selected",
      "retry.scheduled",
    ]);
    expect(call.transportIds).toEqual(["default"]);

    call.resetScript(async () => turn({ text: "recovered" }));
    if (waiting.status !== "WAITING_RETRY") throw new Error("expected retry boundary");
    now = Number(waiting.nextAttemptAt);
    const recovered = await h.controller.recover(h.store.snapshot.run.id);

    expect(recovered.status).not.toBe("WAITING_RETRY");
    expect(call.transportIds).toEqual(["default", "backup"]);
    expect(recovered.status).toBe("TERMINAL");
    expect(h.store.snapshot.run.status).toBe("COMPLETED");
    expect(h.store.snapshot.continuation).toBeUndefined();
  });

  it.each([
    [
      "deadline",
      makeRun({ limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 15 } }),
      () => aiError("AI_NETWORK"),
      "DEADLINE_EXCEEDED",
      "FAILED",
    ],
    [
      "max steps",
      makeRun({ limits: { maxSteps: 1, maxToolCalls: 8, timeoutMs: 100_000 } }),
      () => aiError("AI_NETWORK"),
      "MAX_STEPS_REACHED",
      "MAX_STEPS_REACHED",
    ],
    [
      "Retry-After policy",
      makeRun(),
      () => aiError("AI_RATE_LIMIT", { retryAfterMs: 300_001 }),
      "RETRY_AFTER_EXCEEDS_POLICY",
      "FAILED",
    ],
  ] as const)(
    "records retry exhaustion when %s prevents another attempt",
    async (_name, run, failure, reason, expectedStatus) => {
      const call = fakeFrozenModelTurnExecutor(async () => {
        throw failure();
      });
      const h = harness({ run, executor: call });

      await h.controller.start(h.store.snapshot.run.id);

      expect(h.store.snapshot.run.status).toBe(expectedStatus);
      expect(h.notifications.filter((event) => event.type === "retry.exhausted")).toMatchObject([
        { payload: { attempt: 1, retriesUsed: 0, reason } },
      ]);
      expect(h.notifications.filter((event) => event.type === "retry.scheduled")).toHaveLength(0);
    },
  );

  it("settles CANCELLED through the termination authority, leaving no open Step", async () => {
    const controller = new AbortController();
    const call = fakeFrozenModelTurnExecutor(async (_request, signal) => {
      controller.abort();
      await Promise.resolve();
      if (signal.aborted) throw new Error("aborted");
      return turn();
    });
    const h = harness({ executor: call });
    // Abort the Run before the turn runs, so the kernel reports CANCELLED rather than a failure.
    const original = h.contextEngine.prepare.bind(h.contextEngine);
    h.contextEngine.prepare = async (input) => {
      controller.abort();
      return original(input);
    };
    const started = h.controller.start(h.store.snapshot.run.id);
    await h.controller.cancel(h.store.snapshot.run.id);
    await started.catch(() => undefined);

    expect(h.store.snapshot.run.status).toBe("CANCELLED");
    expect(h.store.snapshot.state?.currentStepId).toBeUndefined();
    expect(h.store.snapshot.continuation).toBeUndefined();
    // A cancelled Run is never recorded as failed, and the provider outcome is never invented.
    expect(h.notifications.map((event) => event.type)).not.toContain("run.failed");
  });

  it("recovers a stale RUNNING Step after a crash without replaying the provider", async () => {
    // Simulate the crash the boundary exists for: the open-Step commit succeeded, then the process
    // stopped before any effect settlement. A fresh controller must find the stale Step, settle it,
    // and never resend the turn.
    const run = makeRun({ status: "RUNNING", startedAt: createTimestampMs(1) });
    const step = {
      id: "stp_0195f3a0-0000-7000-8000-0000000000ff" as StepId,
      runId: run.id,
      sequence: 1,
      status: "RUNNING" as const,
      startedAt: createTimestampMs(2),
    };
    const call = fakeFrozenModelTurnExecutor(async () => turn());
    const messages = testRunMessageAuthority();
    const h = harness({
      executor: call,
      run,
      snapshot: {
        run: { ...run, currentStepId: step.id },
        conversationRecords: [
          {
            runId: run.id,
            sequence: 1,
            ...createUserMessageAppend(messages, run, "GOAL").draft,
          },
        ],
        state: {
          ...startAgentState(
            createInitialAgentState(
              AgentRunSchema.parse({ ...run, status: "PENDING", startedAt: undefined }),
              createTimestampMs(1),
            ),
            createTimestampMs(1),
          ),
          currentStepId: step.id,
        },
        activeStep: step,
        stateRevision: 1,
      },
    });

    const result = await h.controller.recover(run.id);

    expect(result.run.status).toBe("FAILED");
    expect(h.store.steps.get(step.id)).toMatchObject({ status: "FAILED" });
    expect(h.store.snapshot.state?.currentStepId).toBeUndefined();
    // The interrupted attempt is never resent: zero provider calls on the recovery path.
    expect(call.callCount()).toBe(0);
    expect(h.allocatedSteps).toHaveLength(0);
  });

  it("does not resend the provider when the settlement commit loses the revision race", async () => {
    const call = fakeFrozenModelTurnExecutor(async () => turn());
    const h = harness({ executor: call });
    // The first commit is the boundary open; the settlement is the one after it. Losing that CAS —
    // the plan is computed against a revision the store no longer holds — must surface as a durable
    // conflict, and the provider turn that already happened must never be replayed.
    const originalCommit = h.store.commit.bind(h.store);
    let commits = 0;
    h.store.commit = async (command: RunExecutionCommit) => {
      commits += 1;
      if (commits === 3) {
        throw new RunExecutionConflictError("settlement revision conflict");
      }
      return originalCommit(command);
    };

    await expect(h.controller.start(h.store.snapshot.run.id)).rejects.toThrow(
      /Unable to persist Run execution|settlement revision conflict/,
    );

    // The provider ran once and was never replayed, and the durable Step is still the open attempt:
    // the Run stays recoverable rather than being settled on a guess.
    expect(call.callCount()).toBe(1);
    expect(h.allocatedSteps).toHaveLength(1);
    expect(h.store.steps.get(h.allocatedSteps[0]!)).toMatchObject({ status: "RUNNING" });
    expect(h.store.snapshot.run.status).toBe("RUNNING");
  });
});
