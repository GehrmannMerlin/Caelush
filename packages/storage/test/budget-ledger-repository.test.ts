import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const settlement = {
      actualInputTokens: 80,
      actualOutputTokens: 20,
      actualCostMicros: 100,
      cachedInputTokens: 60,
      cacheMissInputTokens: 20,
      cacheWriteInputTokens: 5,
      reasoningTokens: 7,
      providerCallId: "llm_fixture_call_1",
      settledAt: createTimestampMs(103),
    };
    await ledger.settle(run.id, "LLM_ATTEMPT", "step-1", settlement);
    await expect(ledger.get(run.id, "LLM_ATTEMPT", "step-1")).resolves.toMatchObject({
      cacheHitInputTokens: 60,
      cacheMissInputTokens: 20,
      cacheWriteInputTokens: 5,
      reasoningTokens: 7,
      providerCallId: "llm_fixture_call_1",
    });
    await expect(
      ledger.settle(run.id, "LLM_ATTEMPT", "step-1", settlement),
    ).resolves.toBeUndefined();
    await expect(
      ledger.settle(run.id, "LLM_ATTEMPT", "step-1", {
        ...settlement,
        cacheMissInputTokens: 19,
      }),
    ).rejects.toThrow("cannot be overwritten");
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

  it("lists every request reservation for one Run in stable creation order", async () => {
    const database = await openCaelushDatabase({ path: ":memory:" });
    databases.push(database);
    await migrateCaelushDatabase(database);
    const session = makeSession();
    const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(100) });
    await new SqliteSessionRepository(database).insert(session);
    await new SqliteRunRepository(database).insert(run);
    const ledger = new SqliteBudgetLedgerRepository(database);
    await ledger.reserve({
      id: "budget-late",
      runId: run.id,
      kind: "CONTEXT_COMPACTION",
      ownerId: "compaction-owner",
      createdAt: createTimestampMs(103),
    });
    await ledger.reserve({
      id: "budget-early",
      runId: run.id,
      kind: "LLM_ATTEMPT",
      ownerId: "step-owner",
      createdAt: createTimestampMs(101),
    });

    await expect(ledger.listByRun(run.id)).resolves.toMatchObject([
      { id: "budget-early", kind: "LLM_ATTEMPT" },
      { id: "budget-late", kind: "CONTEXT_COMPACTION" },
    ]);
  });

  it("persists provider cache counters and call identity across a SQLite reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caelush-cache-accounting-"));
    const databasePath = join(directory, "cache-accounting.db");
    try {
      const first = await openCaelushDatabase({ path: databasePath });
      await migrateCaelushDatabase(first);
      const session = makeSession();
      const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(100) });
      await new SqliteSessionRepository(first).insert(session);
      await new SqliteRunRepository(first).insert(run);
      const ledger = new SqliteBudgetLedgerRepository(first);
      await ledger.reserve({
        id: "budget-verification",
        runId: run.id,
        kind: "VERIFICATION_LLM",
        ownerId: "verify-owner",
        createdAt: createTimestampMs(101),
      });
      await ledger.markInFlight(run.id, "VERIFICATION_LLM", "verify-owner", createTimestampMs(102));
      await ledger.settle(run.id, "VERIFICATION_LLM", "verify-owner", {
        actualInputTokens: 16_017,
        actualOutputTokens: 1_311,
        actualCostMicros: 0,
        cachedInputTokens: 12_000,
        cacheMissInputTokens: 4_017,
        cacheWriteInputTokens: 100,
        reasoningTokens: 500,
        providerCallId: "llm_verification_fixture",
        settledAt: createTimestampMs(103),
      });
      first.close();

      const reopened = await openCaelushDatabase({ path: databasePath });
      try {
        const restored = await new SqliteBudgetLedgerRepository(reopened).get(
          run.id,
          "VERIFICATION_LLM",
          "verify-owner",
        );
        expect(restored).toMatchObject({
          actualInputTokens: 16_017,
          actualOutputTokens: 1_311,
          cacheHitInputTokens: 12_000,
          cacheMissInputTokens: 4_017,
          cacheWriteInputTokens: 100,
          reasoningTokens: 500,
          providerCallId: "llm_verification_fixture",
        });
        const legacyNulls = reopened.client
          .prepare(
            "SELECT cache_hit_input_tokens, cache_miss_input_tokens, cache_write_input_tokens FROM run_budget_entries WHERE kind = 'LLM_ATTEMPT'",
          )
          .all();
        expect(legacyNulls).toEqual([]);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
