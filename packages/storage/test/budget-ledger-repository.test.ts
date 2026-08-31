import { createTimestampMs } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteBudgetLedgerRepository } from "../src/budget-ledger-repository.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const databases: Array<{ close(): void }> = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("SqliteBudgetLedgerRepository", () => {
  it("keeps reservations unique, aggregates reserved capacity, and settles actual usage", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(100) });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const ledger = new SqliteBudgetLedgerRepository(database);
    const entry = await ledger.reserve({
      id: "budget-1",
      runId: run.id,
      kind: "LLM_ATTEMPT",
      ownerId: "step-1",
      reservedInputTokens: 100,
      reservedOutputTokens: 50,
      reservedCostMicros: 200,
      createdAt: createTimestampMs(101),
    });
    expect(await ledger.reserve(entry)).toEqual(entry);
    expect(await ledger.snapshot(run.id)).toEqual({
      toolCallsConsumed: 0,
      toolCallsReserved: 0,
      inputTokensConsumed: 0,
      inputTokensReserved: 100,
      outputTokensConsumed: 0,
      outputTokensReserved: 50,
      tokensConsumed: 0,
      tokensReserved: 150,
      costMicrosConsumed: 0,
      costMicrosReserved: 200,
    });
    await ledger.markInFlight(run.id, "LLM_ATTEMPT", "step-1", createTimestampMs(102));
    await ledger.settle(run.id, "LLM_ATTEMPT", "step-1", {
      actualInputTokens: 80,
      actualOutputTokens: 20,
      actualCostMicros: 100,
      settledAt: createTimestampMs(103),
    });
    expect(await ledger.snapshot(run.id)).toEqual({
      toolCallsConsumed: 0,
      toolCallsReserved: 0,
      inputTokensConsumed: 80,
      inputTokensReserved: 0,
      outputTokensConsumed: 20,
      outputTokensReserved: 0,
      tokensConsumed: 100,
      tokensReserved: 0,
      costMicrosConsumed: 100,
      costMicrosReserved: 0,
    });
  });

  it("never releases an in-flight reservation and conservatively recovers it", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(100) });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const ledger = new SqliteBudgetLedgerRepository(database);
    await ledger.reserve({
      id: "budget-2",
      runId: run.id,
      kind: "TOOL_INVOCATION",
      ownerId: "invocation-1",
      reservedToolCalls: 1,
      createdAt: createTimestampMs(101),
    });
    await ledger.markInFlight(run.id, "TOOL_INVOCATION", "invocation-1", createTimestampMs(102));
    await expect(ledger.release(run.id, "TOOL_INVOCATION", "invocation-1")).rejects.toThrow();
    await ledger.recoverInFlight(run.id);
    expect((await ledger.get(run.id, "TOOL_INVOCATION", "invocation-1"))?.state).toBe(
      "CONSERVATIVE",
    );
    expect((await ledger.snapshot(run.id)).toolCallsConsumed).toBe(1);
  });
});
