import { createTimestampMs } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteRunBudgetPort } from "../src/run-budget-port.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { makeRun, makeSession, makeStep, makeState } from "./support/fixtures.js";

const databases: Array<{ close(): void }> = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("SqliteRunBudgetPort", () => {
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
    const request = {
      model: run.model,
      messages: [{ role: "user" as const, content: "hello" }],
      maxOutputTokens: 20,
    };

    const admitted = await budget.admitLLM({ run, step, request });
    expect(admitted.kind).toBe("ALLOWED");
    if (admitted.kind !== "ALLOWED") throw new Error("expected admission");
    expect(admitted.request.maxOutputTokens).toBe(12);
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
      request: { model: run.model, messages: [{ role: "user", content: "hello" }] },
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
    const request = { model: run.model, messages: [{ role: "user" as const, content: "review" }] };
    const admitted = await budget.admitVerificationLLM({ run, ownerId: "verify:task", request });
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
});

async function budgetLedger(
  database: Awaited<ReturnType<typeof openCaelushDatabase>>,
  runId: ReturnType<typeof makeRun>["id"],
  kind: "LLM_ATTEMPT" | "VERIFICATION_LLM" | "TOOL_INVOCATION",
  ownerId: string,
) {
  return new (await import("../src/budget-ledger-repository.js")).SqliteBudgetLedgerRepository(
    database,
  ).get(runId, kind, ownerId);
}
