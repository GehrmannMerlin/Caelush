import {
  AgentRunSchema,
  createEventId,
  createLLMCallId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  createVerificationCheckId,
  createVerificationPlanId,
  type StepId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { AgentTurnInput, ContextPrepareInput } from "@caelush/agent";
import { AgentLoop } from "../src/agent-loop.js";
import type { AgentLoopCommonInput, AgentLoopContinuationInput } from "../src/agent-loop-input.js";
import type { AgentLoopExecutionResult } from "../src/agent-loop-input.js";
import type { AgentLoop as LoopContract } from "../src/agent-loop.js";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { RunController } from "../src/run-controller.js";
import type {
  RunExecutionCommit,
  RunExecutionSnapshot,
  RunExecutionStorePort,
} from "../src/run-execution-store.js";
import { fakeModelTurnExecutor, testModelCatalog } from "./support/fake-model-turn-executor.js";

/**
 * Verification repair is a `CONTINUATION`, not a fabricated user turn.
 *
 * The legacy loop drove a repair by calling `run()` again, which re-appended the Run's goal as a
 * fresh user message and then relied on the Context adapter's repair block to explain itself. The
 * frozen contract has a better answer: the Run continues, the model sees the repair context, and
 * the durable ledger records no message the user never sent.
 *
 * What is asserted here, in production code paths:
 *
 * ```text
 * the frozen turn input is CONTINUATION with reason VERIFICATION_REPAIR
 * the identity is the same Run and Session; only the AgentTurnRef is new
 * the repair context still reaches the legacy ContextBuildInput
 * no duplicate durable user message is appended
 * STEERING passes the frozen validator without pretending to be implemented
 * ```
 */

const REPAIR_TEXT = "the lint check failed: unused variable";

function makeRun() {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "make the build pass",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 6, maxToolCalls: 8, timeoutMs: 10_000 },
    createdAt: createTimestampMs(1),
  });
}

/** The CommonInput shape the facade accepts, with the Run already RUNNING. */
function commonInput(run: ReturnType<typeof makeRun>): AgentLoopCommonInput {
  const pending = AgentRunSchema.parse({ ...run, startedAt: undefined });
  const started = AgentRunSchema.parse({
    ...run,
    status: "RUNNING",
    startedAt: createTimestampMs(1),
  });
  return {
    run: started,
    state: startAgentState(
      createInitialAgentState(pending, createTimestampMs(1)),
      createTimestampMs(1),
    ),
    history: [],
    baseSystemPrompt: "base",
    contextLimits: { maxInputTokens: 1000 },
    signal: new AbortController().signal,
  };
}

/**
 * A production `AgentLoop` over the real legacy Context adapter.
 *
 * `observeFrozenTurn` swaps in a Context Engine that records the frozen `ContextPrepareInput`.
 * That is the first thing `advance()` calls, so whatever it sees is exactly what the kernel
 * received — before any admission, commit or provider work. With the flag off, the facade builds
 * its own legacy adapter, which is what the repair-context wiring assertion needs.
 */
function productionLoop(
  options: {
    readonly builtInputs?: unknown[];
    readonly observeFrozenTurn?: boolean;
  } = {},
): { readonly loop: AgentLoop; prepares(): readonly ContextPrepareInput[] } {
  const prepares: ContextPrepareInput[] = [];
  const loop = new AgentLoop({
    inspector: { inspect: async () => ({}) as never },
    planner: { plan: async () => ({}) as never },
    contextBuilder: {
      build: (input) => {
        options.builtInputs?.push(input);
        return {
          messages:
            input.mode === "TOOL_CONTINUATION"
              ? input.currentTurnMessages
              : [input.currentUserMessage],
          report: {} as never,
        };
      },
    },
    models: testModelCatalog(),
    modelTurns: fakeModelTurnExecutor(async () => ({
      callId: createLLMCallId(),
      providerId: "fixture",
      model: { provider: "fixture", model: "fixture-model" },
      text: "repaired",
      toolCalls: [],
      finishReason: "STOP" as const,
    })),
    clock: { now: () => createTimestampMs(10) },
    stepIdFactory: { create: () => createStepId() },
    ...(options.observeFrozenTurn !== true
      ? {}
      : {
          createContextEngine: () => ({
            prepare: async (input: ContextPrepareInput) => {
              prepares.push(input);
              return {
                messages: [{ role: "user", content: "prepared" }],
                report: {
                  estimatedInputTokens: 1,
                  effectiveInputLimitTokens: 100,
                  remainingTokens: 99,
                  pressure: "NORMAL" as const,
                  compactionCount: 0,
                  contributions: [],
                },
                observationPolicy: {
                  maxSingleObservationTokens: 10,
                  maxObservationBatchTokens: 20,
                },
              };
            },
          }),
        }),
  });
  return { loop, prepares: () => prepares };
}

describe("AgentLoop.continueRun", () => {
  it("reaches the frozen loop as a VERIFICATION_REPAIR continuation of the same Run", async () => {
    const run = makeRun();
    const base = commonInput(run);
    const observer = productionLoop({ observeFrozenTurn: true });

    const result = await observer.loop.continueRun({
      ...base,
      reason: "VERIFICATION_REPAIR",
    } satisfies AgentLoopContinuationInput);

    expect(result.status).toBe("OUTCOME");
    expect(observer.prepares()).toHaveLength(1);
    const frozen: AgentTurnInput = observer.prepares()[0]!.input;
    expect(frozen).toEqual({ kind: "CONTINUATION", reason: "VERIFICATION_REPAIR" });
    // Same Run, same Session: a repair is the next epoch of one Run, never a new one.
    expect(observer.prepares()[0]!.identity).toEqual({
      runId: run.id,
      sessionId: run.sessionId,
      goal: run.goal,
    });
    expect(observer.prepares()[0]!.turn.sequence).toBe(1);
    // No caller-visible message is re-appended: the previous epoch's messages are already durable.
    expect(result.status === "OUTCOME" && result.messagesToAppend.map((m) => m.role)).toEqual([
      "assistant",
    ]);
  });

  it("does not re-append the Run goal as a durable user message", async () => {
    const run = makeRun();
    const observer = productionLoop({ observeFrozenTurn: true });

    const result = await observer.loop.continueRun({
      ...commonInput(run),
      reason: "VERIFICATION_REPAIR",
    });

    if (result.status !== "OUTCOME") throw new Error("expected outcome");
    // Contrast with `run()`, which appends the goal because the user really did just speak.
    expect(result.messagesToAppend.some((message) => message.role === "user")).toBe(false);
    expect(result.messagesToAppend).toHaveLength(1);
  });

  it("still hands the repair context to the legacy context build", async () => {
    const run = makeRun();
    const built: unknown[] = [];
    const observer = productionLoop({ builtInputs: built });

    const result = await observer.loop.continueRun({
      ...commonInput(run),
      reason: "VERIFICATION_REPAIR",
      verificationRepairContext: { text: REPAIR_TEXT },
    });

    expect(result.status).toBe("OUTCOME");
    // The adapter is the only component that knows a continuation needs the repair block, and it
    // asks the facade for it at the moment it builds one. The wiring is what this asserts.
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ verificationRepairContext: { text: REPAIR_TEXT } });
  });

  it("omits the repair context for an ordinary continuation", async () => {
    const run = makeRun();
    const built: unknown[] = [];
    const observer = productionLoop({ builtInputs: built });

    await observer.loop.continueRun({
      ...commonInput(run),
      reason: "VERIFICATION_REPAIR",
    });

    expect(built).toHaveLength(1);
    expect(built[0]).not.toHaveProperty("verificationRepairContext");
  });

  it("accepts STEERING as a contract with no wired behaviour", async () => {
    const run = makeRun();
    const observer = productionLoop({ observeFrozenTurn: true });

    const result = await observer.loop.continueRun({
      ...commonInput(run),
      reason: "STEERING",
      messages: [{ role: "user", content: "steer left" }],
    });

    expect(result.status).toBe("OUTCOME");
    expect(observer.prepares()[0]!.input).toEqual({
      kind: "CONTINUATION",
      reason: "STEERING",
      messages: [{ role: "user", content: "steer left" }],
    });
    // A supplied steering message is the caller's message, so it is appended; nothing is invented.
    if (result.status !== "OUTCOME") throw new Error("expected outcome");
    expect(result.messagesToAppend.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});

/* --------------------------------------------------------- controller route */

class SeededStore implements RunExecutionStorePort {
  constructor(public snapshot: RunExecutionSnapshot) {}

  async load(): Promise<RunExecutionSnapshot> {
    return this.snapshot;
  }

  async requestCancellation(): Promise<RunExecutionSnapshot> {
    return this.snapshot;
  }

  async commit(command: RunExecutionCommit) {
    this.snapshot = { ...this.snapshot, run: command.run };
    return { snapshot: this.snapshot, events: [] };
  }
}

describe("RunController verification repair route", () => {
  it("recovers a repair boundary through the continuation path, not through a new user turn", async () => {
    const run = makeRun();
    const sourceStepId = "stp_0195f3a0-0000-7000-8000-000000000d04" as StepId;
    const planId = createVerificationPlanId();
    const started = AgentRunSchema.parse({
      ...run,
      status: "RUNNING",
      startedAt: createTimestampMs(1),
    });
    const store = new SeededStore({
      run: started,
      state: startAgentState(
        createInitialAgentState(
          AgentRunSchema.parse({ ...run, startedAt: undefined }),
          createTimestampMs(1),
        ),
        createTimestampMs(1),
      ),
      conversation: [],
      continuation: {
        type: "WAITING_VERIFICATION_REPAIR",
        runId: run.id,
        failedPlanId: planId,
        sourceStepId,
        failedCheckIds: [createVerificationCheckId()],
        evidenceIds: [],
        repairCycle: 1,
      } as never,
      continuationRevision: 1,
    } as never);

    const continuations: AgentLoopContinuationInput[] = [];
    const runs: AgentLoopCommonInput[] = [];
    const settled = (state: AgentLoopCommonInput["state"]): AgentLoopExecutionResult =>
      ({
        status: "FAILED",
        error: { code: "MODEL_ERROR", message: "spy", retryable: false, phase: "LLM" },
        state,
        messagesToAppend: [],
        providerTurnState: "NOT_STARTED",
      }) as never;
    const loop = {
      withLifecycleHooks: () => loop,
      async run(input: AgentLoopCommonInput) {
        runs.push(input);
        return settled(input.state);
      },
      async continueRun(input: AgentLoopContinuationInput) {
        continuations.push(input);
        return settled(input.state);
      },
      async resumeWithToolResults() {
        throw new Error("a verification repair must never resume Tool results");
      },
    } as unknown as LoopContract;

    const controller = new RunController({
      agentLoop: loop,
      execution: store,
      events: { notifyCommitted: () => undefined },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "base",
          contextLimits: { maxInputTokens: 1000 },
        }),
      },
      clock: { now: () => createTimestampMs(10) },
      eventIdFactory: { create: createEventId },
      verificationPlanner: {
        plan: ({ runId, sourceStepId }: { runId: never; sourceStepId: never }) =>
          ({
            runId,
            sourceStepId,
            plannerVersion: "phase-11a.v1",
            planHash: "a".repeat(64),
            checks: [
              {
                ordinal: 0,
                stage: "ACCEPTANCE",
                requirement: "REQUIRED",
                spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
              },
            ],
          }) as never,
      },
      verificationExecutionRecovery: {
        getPlanExecutionSnapshot: async () => ({
          plan: {
            id: planId,
            runId: run.id,
            sourceStepId,
            plannerVersion: "phase-11a.v1",
            planHash: "a".repeat(64),
            checks: [],
            createdAt: createTimestampMs(1),
          },
          checks: [],
          evidence: [],
        }),
      },
    } as never);

    await controller.recover(run.id);

    // The repair boundary went through `continueRun` with the frozen reason, and `run()` — the
    // path that would fabricate a user turn — was never called.
    expect(continuations).toHaveLength(1);
    expect(continuations[0]?.reason).toBe("VERIFICATION_REPAIR");
    expect(continuations[0]?.run.id).toBe(run.id);
    expect(runs).toHaveLength(0);
    // Same Run: no new Run was created for the repair.
    expect(store.snapshot.run.id).toBe(run.id);
  });
});
