import { createLLMCallId, createTimestampMs, type RunResourcePolicy } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteBudgetLedgerRepository } from "../src/budget-ledger-repository.js";
import { SqliteRunBudgetPort } from "../src/run-budget-port.js";
import { SqliteProviderInvocationUsageStore } from "../src/provider-invocation-usage-store.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { makeRun, makeSession, makeStep, makeState } from "./support/fixtures.js";

const databases: Array<{ close(): void }> = [];

const adaptivePolicy: RunResourcePolicy = {
  mode: "ADAPTIVE",
  operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
  batch: { maxToolCallsPerTurn: 16 },
  progress: {
    windowTurns: 8,
    identicalCallNudgeThreshold: 3,
    noProgressTurnsBeforeReplan: 4,
    replansBeforePause: 2,
  },
  hardLimits: {},
  inactivity: {},
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("SqliteRunBudgetPort", () => {
  it("does not apply the legacy lifetime Tool ceiling to an Adaptive Run", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(100),
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
      resourcePolicy: adaptivePolicy,
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const budget = new SqliteRunBudgetPort(database);

    for (const invocationId of ["invocation-a", "invocation-b", "invocation-c", "invocation-d"]) {
      await budget.admit({ runId: run.id, requested: 1, invocationId });
    }
    await expect(budget.admit({ runId: run.id, requested: 5 })).resolves.toEqual({
      kind: "ALLOWED",
    });
  });

  it("reserves, settles, and projects a provider attempt through the ledger", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(100),
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000, maxTokens: 20 },
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const budget = new SqliteRunBudgetPort(database, {
      tokenEstimator: { estimate: () => 8 },
      pricing: {
        resolve: () => ({
          id: "fixture-v1",
          currency: "USD",
          inputMicrosPerMillionTokens: 1_000,
          outputMicrosPerMillionTokens: 2_000,
        }),
      },
      clock: { now: () => createTimestampMs(101) },
    });
    const step = makeStep(run.id);
    // The budget port is AI-agnostic: Core computes the estimate from the request it
    // owns and hands the durable layer plain numbers.
    const admission = {
      estimatedInputTokens: 8,
      configuredMaxOutputTokens: 20,
    };

    const admitted = await budget.admitLLM({ run, step, admission });
    expect(admitted.kind).toBe("ALLOWED");
    if (admitted.kind !== "ALLOWED") throw new Error("expected admission");
    expect(admitted.effectiveMaxOutputTokens).toBe(12);
    expect((await budgetLedger(database, run.id, "LLM_ATTEMPT", step.id))?.state).toBe("IN_FLIGHT");

    await budget.settleLLM({
      runId: run.id,
      stepId: step.id,
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
      settledAt: createTimestampMs(102),
    });
    const projected = await budget.reconcileState(makeState(run));
    expect(projected.usage).toMatchObject({
      inputTokens: 6,
      outputTokens: 4,
      toolCalls: 0,
      cost: 0.000002,
    });
  });

  it("admits one known-billed overflow recovery under the original token and cost reservation", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(100),
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000, maxTokens: 20_000, maxCost: 0.02 },
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const pricing = {
      id: "fixture-v1",
      currency: "USD" as const,
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 1_000_000,
    };
    const budget = new SqliteRunBudgetPort(database, {
      pricing: { resolve: () => pricing },
      clock: { now: () => createTimestampMs(101) },
    });
    const step = makeStep(run.id);
    const admitted = await budget.admitLLM({
      run,
      step,
      admission: { estimatedInputTokens: 100, configuredMaxOutputTokens: 18_900 },
    });
    expect(admitted).toMatchObject({ kind: "ALLOWED", effectiveMaxOutputTokens: 18_900 });

    const usage = new SqliteProviderInvocationUsageStore(database);
    const firstCallId = createLLMCallId();
    await usage.observe(
      providerObservation({ callId: firstCallId, runId: run.id, stepId: step.id }),
    );
    await usage.settle({
      callId: firstCallId,
      status: "FAILED",
      settledAt: createTimestampMs(102),
      totalTokens: 1_100,
      inputTokens: 500,
      outputTokens: 600,
      cacheHitInputTokens: 100,
      cacheMissInputTokens: 400,
    });

    const recovery = await budget.admitLLMRecovery({
      run,
      step,
      initialOutputCeiling: 18_900,
      admission: { estimatedInputTokens: 500, configuredMaxOutputTokens: 50_000 },
    });
    expect(recovery).toMatchObject({ kind: "ALLOWED", effectiveMaxOutputTokens: 18_400 });
    const entryAfterRecoveryAdmission = await budgetLedger(
      database,
      run.id,
      "LLM_ATTEMPT",
      step.id,
    );
    expect(entryAfterRecoveryAdmission).toMatchObject({
      state: "IN_FLIGHT",
      reservedInputTokens: 1_000,
      reservedOutputTokens: 19_000,
      reservedCostMicros: 20_000,
      pricingSnapshotId: "fixture-v1",
    });
    expect(await new SqliteBudgetLedgerRepository(database).listByRun(run.id)).toHaveLength(1);

    const recoveryCallId = createLLMCallId();
    await usage.observe(
      providerObservation({ callId: recoveryCallId, runId: run.id, stepId: step.id }),
    );
    await usage.settle({
      callId: recoveryCallId,
      status: "COMPLETE",
      settledAt: createTimestampMs(103),
      totalTokens: 8_500,
      inputTokens: 500,
      outputTokens: 8_000,
      cacheHitInputTokens: 200,
      cacheMissInputTokens: 300,
    });
    await expect(
      budget.admitLLMRecovery({
        run,
        step,
        initialOutputCeiling: 18_900,
        admission: { estimatedInputTokens: 500, configuredMaxOutputTokens: 50_000 },
      }),
    ).resolves.toMatchObject({ kind: "UNAVAILABLE" });

    await budget.settleLLM({ runId: run.id, stepId: step.id, settledAt: createTimestampMs(104) });
    expect(await budgetLedger(database, run.id, "LLM_ATTEMPT", step.id)).toMatchObject({
      state: "SETTLED",
      actualInputTokens: 1_000,
      actualOutputTokens: 8_600,
      actualCostMicros: 9_600,
      cacheHitInputTokens: 300,
      cacheMissInputTokens: 700,
    });
    await expect(
      budget.settleLLM({ runId: run.id, stepId: step.id, settledAt: createTimestampMs(105) }),
    ).resolves.toMatchObject({ kind: "SETTLED" });
    expect(await new SqliteBudgetLedgerRepository(database).listByRun(run.id)).toHaveLength(1);
  });

  it("allows recovery when Gateway facts prove the first provider attempt never began", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(100),
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000, maxTokens: 1_000 },
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const budget = new SqliteRunBudgetPort(database);
    const step = makeStep(run.id);
    await budget.admitLLM({
      run,
      step,
      admission: { estimatedInputTokens: 100, configuredMaxOutputTokens: 800 },
    });

    await expect(
      budget.admitLLMRecovery({
        run,
        step,
        initialOutputCeiling: 800,
        admission: { estimatedInputTokens: 200, configuredMaxOutputTokens: 800 },
      }),
    ).resolves.toMatchObject({ kind: "ALLOWED", effectiveMaxOutputTokens: 800 });
    expect(await budgetLedger(database, run.id, "LLM_ATTEMPT", step.id)).toMatchObject({
      state: "IN_FLIGHT",
      reservedInputTokens: 200,
      reservedOutputTokens: 800,
    });
  });

  it("blocks recovery when a started provider attempt has unknown billing and keeps it conservative", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(100),
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000, maxTokens: 1_000 },
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const budget = new SqliteRunBudgetPort(database);
    const step = makeStep(run.id);
    await budget.admitLLM({
      run,
      step,
      admission: { estimatedInputTokens: 100, configuredMaxOutputTokens: 800 },
    });
    const callId = createLLMCallId();
    const usage = new SqliteProviderInvocationUsageStore(database);
    await usage.observe(providerObservation({ callId, runId: run.id, stepId: step.id }));
    await usage.settle({ callId, status: "FAILED", settledAt: createTimestampMs(102) });

    await expect(
      budget.admitLLMRecovery({
        run,
        step,
        initialOutputCeiling: 800,
        admission: { estimatedInputTokens: 200, configuredMaxOutputTokens: 800 },
      }),
    ).resolves.toMatchObject({ kind: "UNAVAILABLE" });
    await budget.settleLLM({ runId: run.id, stepId: step.id, settledAt: createTimestampMs(103) });
    expect(await budgetLedger(database, run.id, "LLM_ATTEMPT", step.id)).toMatchObject({
      state: "CONSERVATIVE",
      reservedInputTokens: 100,
      reservedOutputTokens: 800,
    });
  });

  it("fails closed when constrained token admission has no safe estimate", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(100),
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000, maxTokens: 20 },
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const budget = new SqliteRunBudgetPort(database, {
      tokenEstimator: { estimate: () => undefined },
    });
    const result = await budget.admitLLM({
      run,
      step: makeStep(run.id),
      // A constrained Run with no safe estimate must fail closed, not guess.
      admission: { configuredMaxOutputTokens: 20 },
    });
    expect(result).toEqual({ kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" });
  });

  it("accounts a verification reviewer through the same ledger without creating a Step", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "VERIFYING",
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000, maxTokens: 100 },
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const budget = new SqliteRunBudgetPort(database, {
      tokenEstimator: { estimate: () => 8 },
      clock: { now: () => createTimestampMs(101) },
    });
    const admitted = await budget.admitVerificationLLM({
      run,
      ownerId: "verify:task",
      admission: { estimatedInputTokens: 8, configuredMaxOutputTokens: 1_024 },
    });
    expect(admitted.kind).toBe("ALLOWED");
    expect((await budgetLedger(database, run.id, "VERIFICATION_LLM", "verify:task"))?.state).toBe(
      "IN_FLIGHT",
    );
    await budget.settleVerificationLLM({
      runId: run.id,
      ownerId: "verify:task",
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
      settledAt: createTimestampMs(102),
    });
    const projected = await budget.reconcileState(makeState(run));
    expect(projected.usage).toMatchObject({
      inputTokens: 8,
      outputTokens: 4,
      steps: 0,
      toolCalls: 0,
    });
  });

  it("accounts context compaction auxiliary work without consuming Steps or Tools", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(100),
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000, maxTokens: 100 },
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const budget = new SqliteRunBudgetPort(database, {
      tokenEstimator: { estimate: () => 8 },
      clock: { now: () => createTimestampMs(101) },
    });

    const admitted = await budget.admitContextCompactionLLM({
      run,
      ownerId: "context-compaction:run-1",
      admission: { estimatedInputTokens: 8, configuredMaxOutputTokens: 20 },
    });
    expect(admitted.kind).toBe("ALLOWED");
    expect(
      (await budgetLedger(database, run.id, "CONTEXT_COMPACTION", "context-compaction:run-1"))
        ?.state,
    ).toBe("IN_FLIGHT");

    await budget.settleContextCompactionLLM({
      runId: run.id,
      ownerId: "context-compaction:run-1",
      usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      settledAt: createTimestampMs(102),
    });
    const projected = await budget.reconcileState(makeState(run));
    expect(projected.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 5,
      steps: 0,
      toolCalls: 0,
    });
  });

  it("does not reopen a conservative context compaction owner", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(100),
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000, maxTokens: 100 },
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const budget = new SqliteRunBudgetPort(database, {
      tokenEstimator: { estimate: () => 8 },
    });
    const ownerId = "context-compaction:conservative-owner";
    await expect(
      budget.admitContextCompactionLLM({
        run,
        ownerId,
        admission: { estimatedInputTokens: 8, configuredMaxOutputTokens: 20 },
      }),
    ).resolves.toMatchObject({ kind: "ALLOWED" });
    await budget.markContextCompactionLLMConservative({
      runId: run.id,
      ownerId,
      settledAt: createTimestampMs(101),
    });
    await expect(
      budget.admitContextCompactionLLM({
        run,
        ownerId,
        admission: { estimatedInputTokens: 8, configuredMaxOutputTokens: 20 },
      }),
    ).resolves.toEqual({ kind: "UNAVAILABLE", reason: "TOKEN_ESTIMATE" });
  });

  it("marks missing context compaction usage conservative instead of settling zero", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, {
      status: "RUNNING",
      startedAt: createTimestampMs(100),
      limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000, maxTokens: 100 },
    });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const budget = new SqliteRunBudgetPort(database, {
      tokenEstimator: { estimate: () => 8 },
    });
    const ownerId = "context-compaction:missing-usage";
    await budget.admitContextCompactionLLM({
      run,
      ownerId,
      admission: { estimatedInputTokens: 8, configuredMaxOutputTokens: 20 },
    });
    await budget.settleContextCompactionLLM({
      runId: run.id,
      ownerId,
      settledAt: createTimestampMs(101),
    });
    expect((await budgetLedger(database, run.id, "CONTEXT_COMPACTION", ownerId))?.state).toBe(
      "CONSERVATIVE",
    );
  });
});

async function budgetLedger(
  database: Awaited<ReturnType<typeof openCaelushDatabase>>,
  runId: ReturnType<typeof makeRun>["id"],
  kind: "LLM_ATTEMPT" | "VERIFICATION_LLM" | "CONTEXT_COMPACTION" | "TOOL_INVOCATION",
  ownerId: string,
) {
  return new (await import("../src/budget-ledger-repository.js")).SqliteBudgetLedgerRepository(
    database,
  ).get(runId, kind, ownerId);
}

function providerObservation(input: {
  readonly callId: ReturnType<typeof createLLMCallId>;
  readonly runId: ReturnType<typeof makeRun>["id"];
  readonly stepId: ReturnType<typeof makeStep>["id"];
}) {
  return {
    ...input,
    purpose: "MAIN_AGENT" as const,
    providerId: "deepseek",
    modelId: "deepseek-chat",
    api: "openai-compatible",
    continuityGroup: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
    observedAt: createTimestampMs(101),
  };
}
