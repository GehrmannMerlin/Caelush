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
import type { RunBudgetPort } from "../src/budget-ports.js";
import { RunController } from "../src/run-controller.js";
import { createRunAgentExecutionContext } from "../src/run-agent-execution.js";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import { createUserMessageAppend } from "../src/run-message-materializer.js";
import { completionStoreOver } from "./support/completion-store.js";
import { fakeContextEngine, fakeFrozenModelTurnExecutor } from "./support/run-agent-execution.js";
import { testModelCatalog } from "./support/fake-model-turn-executor.js";
import { MemoryRunStore } from "./support/phase-3d-tool-turn.js";
import { testRunMessageAuthority } from "./support/run-message-authority.js";

const recoveryPolicy = {
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
const RECOVERY_OUTPUT_TOKENS = 200;

function recoverySnapshot() {
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
    contextBudgetPolicy: recoveryPolicy,
    createdAt,
  });
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
    targetOutputTokens: RECOVERY_OUTPUT_TOKENS,
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
      type: "WAITING_RETRY" as const,
      runId,
      failedStepId,
      attempt: 2 as const,
      maxAttempts: 2 as const,
      nextAttemptAt: createTimestampMs(10),
      errorCode: "LLM_OUTPUT_TRUNCATED" as const,
      mode: "START" as const,
    },
  };
}

function createHarness(admittedOutputTokens: number) {
  const snapshot = recoverySnapshot();
  const store = new MemoryRunStore(snapshot);
  const executor = fakeFrozenModelTurnExecutor((): ModelTurnExecutionResult => ({
    kind: "FAILED",
    error: {
      code: "PROVIDER_ERROR",
      message: "Stop after checking the admitted output ceiling.",
      retryable: false,
    },
  }));
  const contextInputs: Parameters<
    NonNullable<Parameters<typeof createRunAgentExecutionContext>[0]["createContextEngine"]>
  >[0][] = [];
  const contextAllowances: number[] = [];
  const contextFactory = createRunAgentExecutionContext({
    config: { baseSystemPrompt: "base", tools: [], modelSettings: { temperature: 0.2 } },
    models: testModelCatalog(),
    modelTurnExecutor: executor,
    stepIds: { create: createStepId },
    createContextEngine(input) {
      contextInputs.push(input);
      const baseEngine = fakeContextEngine();
      const outputAllowanceTokens = input.modelSettings?.maxOutputTokens ?? 128;
      return {
        preparations: baseEngine.preparations,
        async prepare(prepareInput) {
          contextAllowances.push(outputAllowanceTokens);
          const prepared = await baseEngine.prepare(prepareInput);
          const safetyReserveTokens = 1;
          return {
            ...prepared,
            requestBudget: {
              version: "TURN_BUDGET_V3" as const,
              algorithm: "HEADROOM_V1" as const,
              outputAllowanceTokens,
              safetyReserveTokens,
              expectedGrowthTokens: 1,
            },
            report: {
              ...prepared.report,
              effectiveInputLimitTokens:
                prepareInput.model.limits.contextWindowTokens -
                outputAllowanceTokens -
                safetyReserveTokens -
                prepared.report.requestOverheadTokens,
            },
          };
        },
      };
    },
  });
  const admissions: Parameters<NonNullable<RunBudgetPort["admitLLM"]>>[0][] = [];
  const settlements: Parameters<NonNullable<RunBudgetPort["settleLLM"]>>[0][] = [];
  const budget: RunBudgetPort = {
    async admitLLM(input) {
      admissions.push(input);
      return { kind: "ALLOWED", effectiveMaxOutputTokens: admittedOutputTokens };
    },
    async admitLLMRecovery() {
      return { kind: "ALLOWED", effectiveMaxOutputTokens: admittedOutputTokens };
    },
    async settleLLM(input) {
      settlements.push(input);
      return { kind: "SETTLED" };
    },
  };
  const controller = new RunController({
    agentExecution: { resolve: async () => contextFactory },
    executionStore: store,
    completionStore: completionStoreOver(store),
    messages: testRunMessageAuthority({ snapshot: () => store.snapshot }),
    events: { notifyCommitted: () => undefined, emitTransient: () => undefined },
    configResolver: {
      resolve: async () => ({
        baseSystemPrompt: "base",
        contextLimits: { maxInputTokens: 1_000 },
      }),
    },
    clock: { now: () => createTimestampMs(20) },
    eventIdFactory: { create: createEventId },
    budget,
  });
  return {
    controller,
    snapshot,
    contextInputs,
    contextAllowances,
    executor,
    admissions,
    settlements,
    store,
  };
}

describe("Run Agent output allowance", () => {
  it("uses the reserved per-turn target for Context and sends the same admitted cap", async () => {
    const harness = createHarness(RECOVERY_OUTPUT_TOKENS);

    await harness.controller.recover(harness.snapshot.run.id);

    expect(harness.contextInputs[0]?.modelSettings).toMatchObject({
      maxOutputTokens: RECOVERY_OUTPUT_TOKENS,
      temperature: 0.2,
    });
    expect(harness.admissions[0]?.admission.configuredMaxOutputTokens).toBe(RECOVERY_OUTPUT_TOKENS);
    expect(harness.executor.requests[0]?.settings?.maxOutputTokens).toBe(RECOVERY_OUTPUT_TOKENS);
  });

  it("keeps the Context reservation while sending a lower budget-admitted cap", async () => {
    const harness = createHarness(150);

    await harness.controller.recover(harness.snapshot.run.id);

    expect(harness.contextInputs[0]?.modelSettings?.maxOutputTokens).toBe(RECOVERY_OUTPUT_TOKENS);
    expect(harness.contextAllowances).toEqual([RECOVERY_OUTPUT_TOKENS]);
    expect(harness.admissions[0]?.admission.configuredMaxOutputTokens).toBe(RECOVERY_OUTPUT_TOKENS);
    expect(harness.executor.requests[0]?.settings?.maxOutputTokens).toBe(150);
    expect(harness.executor.callCount()).toBe(1);
  });

  it("stops before Provider I/O when the final admitted cap does not exceed the previous cap", async () => {
    const harness = createHarness(PREVIOUS_OUTPUT_TOKENS);

    const result = await harness.controller.recover(harness.snapshot.run.id);

    expect(harness.contextInputs[0]?.modelSettings?.maxOutputTokens).toBe(RECOVERY_OUTPUT_TOKENS);
    expect(result.status).toBe("FAILED");
    expect(harness.executor.callCount()).toBe(0);
    expect(harness.store.snapshot.state?.errors.at(-1)).toMatchObject({
      code: "MODEL_ERROR",
      phase: "LLM",
      retryable: false,
      details: { modelOutputFailure: "OUTPUT_TRUNCATED" },
    });
    expect(harness.settlements).toEqual([
      {
        runId: harness.snapshot.run.id,
        stepId: expect.any(String),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        settledAt: createTimestampMs(20),
      },
    ]);
  });
});
