import type { AIModelRequest, AIModelTurnResult, JsonObject } from "@caelush/ai";
import type { AgentTurnRef, ModelTurnExecutionResult } from "@caelush/agent";
import { createModelToolFeedbackProjector, createToolResultBatchNormalizer } from "@caelush/agent";
import { toContextObservationProjection } from "../src/agent-tool-batch.js";
import { createUserMessageAppend } from "../src/run-message-materializer.js";
import {
  AgentRunSchema,
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

function makeRun(overrides: Record<string, unknown> = {}) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "inspect project",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 100_000 },
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
    },
    configResolver: options.configResolver ?? {
      resolve: async () => ({ baseSystemPrompt: "base", contextLimits: { maxInputTokens: 1000 } }),
    },
    clock,
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
    // The FinalCandidate compatibility bridge is Phase 3E's authority to keep: a candidate moves the
    // Run to VERIFYING with a real plan, and never to COMPLETED from here. The planner is the one
    // production composition supplies; this fixture mirrors it so the bridge runs for real.
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
function toolCoordinatorFixture(): {
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
            content: "the file body",
            isError: false,
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
function toolThenAnswer(): FakeFrozenModelTurnExecutor {
  let calls = 0;
  return fakeFrozenModelTurnExecutor(async () => {
    calls += 1;
    if (calls > 1) return turn({ text: "done" });
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
    // The second turn's answer is the candidate the verification bridge bound to a real plan; the
    // Run is VERIFYING and has never completed.
    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(h.store.snapshot.run.status).toBe("VERIFYING");
    expect(types).toContain("verification.planned");
    expect(types).not.toContain("run.completed");
  });

  it("settles FINAL_CANDIDATE through the verification bridge, never to COMPLETED", async () => {
    const h = harness({ executor: fakeFrozenModelTurnExecutor(async () => turn()) });

    const result = await h.controller.start(h.store.snapshot.run.id);

    expect(result.status).toBe("AWAITING_VERIFICATION");
    expect(h.store.snapshot.run.status).toBe("VERIFYING");
    expect(h.store.snapshot.run.finalResult).toBeUndefined();
    // The candidate's Step settled exactly once, with the candidate text bound to a real plan.
    expect(h.store.steps.get(h.allocatedSteps[0]!)).toMatchObject({ status: "COMPLETED" });
    expect(h.store.snapshot.state?.usage.steps).toBe(1);
    const continuation = h.store.snapshot.continuation;
    expect(continuation?.type).toBe("AWAITING_VERIFICATION");
    expect(
      continuation?.type === "AWAITING_VERIFICATION" ? continuation.sourceStepId : undefined,
    ).toBe(h.allocatedSteps[0]);
    expect(
      continuation?.type === "AWAITING_VERIFICATION"
        ? continuation.finalDecision.candidateText
        : undefined,
    ).toBe("candidate");
    const types = h.notifications.map((event) => event.type);
    expect(types).toContain("verification.planned");
    expect(types).toContain("status.changed");
    // Completion authority is Phase 3E: this bridge never completes a Run.
    expect(types).not.toContain("run.completed");
    expect(types.filter((type) => type === "llm.completed")).toHaveLength(1);
    expect(types.filter((type) => type === "reasoning.summary")).toHaveLength(1);
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
      "llm.started",
      "llm.failed",
      "error",
      "status.changed",
      "run.failed",
    ]);
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
