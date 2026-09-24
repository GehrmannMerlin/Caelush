import { describe, expect, it } from "vitest";
import {
  createEventId,
  createRunId,
  createSessionId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type RunId,
  type SessionId,
} from "@caelush/protocol";
import type { DurableRunEventDraft } from "@caelush/agent";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteDurableEventStore } from "../src/events/sqlite-durable-event-store.js";
import { appendDurableEventsInTransaction } from "../src/events/sqlite-durable-event-store.js";

async function createStore() {
  const database = await openCaelushDatabase({ path: ":memory:" });
  await migrateCaelushDatabase(database);
  return { database, store: new SqliteDurableEventStore(database) };
}

function makeDraft(runId: RunId, sessionId: SessionId, timestamp: number): DurableRunEventDraft {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    runId,
    sessionId,
    timestamp: createTimestampMs(timestamp),
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1 },
    type: "shell.output",
    payload: {
      invocationId: createToolInvocationId(),
      stream: "stdout",
      chunk: `event-${timestamp}`,
    },
  };
}

function appendInAuthoritativeTestTransaction(
  database: Awaited<ReturnType<typeof openCaelushDatabase>>,
  draft: DurableRunEventDraft,
) {
  const client = database.client;
  client.exec("BEGIN IMMEDIATE");
  try {
    const [event] = appendDurableEventsInTransaction(client, [draft]);
    if (event === undefined) throw new Error("test event append returned no event");
    client.exec("COMMIT");
    return event;
  } catch (error) {
    client.exec("ROLLBACK");
    throw error;
  }
}

async function createParents(
  database: Awaited<ReturnType<typeof openCaelushDatabase>>,
  runId: RunId,
  sessionId: SessionId,
) {
  database.client
    .prepare(
      `INSERT INTO agent_sessions (id, protocol_version, created_at_ms, updated_at_ms, data_json)
       VALUES (?, 1, 1, 1, ?)`,
    )
    .run(sessionId, JSON.stringify({ id: sessionId, createdAt: 1, updatedAt: 1, metadata: {} }));
  database.client
    .prepare(
      `INSERT INTO agent_runs
        (id, session_id, protocol_version, status, created_at_ms, data_json)
       VALUES (?, ?, 1, 'PENDING', 1, ?)`,
    )
    .run(
      runId,
      sessionId,
      JSON.stringify({
        id: runId,
        sessionId,
        goal: "event test",
        status: "PENDING",
        workspace: { id: createWorkspaceId(), path: "C:/workspace" },
        model: { provider: "test", model: "test" },
        runtime: { id: "local", kind: "test" },
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ALWAYS_ASK",
        limits: { maxSteps: 1, maxToolCalls: 1, timeoutMs: 1 },
        createdAt: 1,
      }),
    );
}

describe("SqliteDurableEventStore reader and internal appender", () => {
  it("allocates independent per-run sequences and replays exclusively after a cursor", async () => {
    const { database, store } = await createStore();
    const sessionId = createSessionId();
    const runA = createRunId();
    const runB = createRunId();
    await createParents(database, runA, sessionId);
    const sessionB = createSessionId();
    await createParents(database, runB, sessionB);

    const first = appendInAuthoritativeTestTransaction(database, makeDraft(runA, sessionId, 3));
    const second = appendInAuthoritativeTestTransaction(database, makeDraft(runA, sessionId, 1));
    const other = appendInAuthoritativeTestTransaction(database, makeDraft(runB, sessionB, 2));

    expect(first.durability).toMatchObject({ kind: "DURABLE", sequence: 1 });
    expect(second.durability).toMatchObject({ kind: "DURABLE", sequence: 2 });
    expect(other.durability).toMatchObject({ kind: "DURABLE", sequence: 1 });
    expect((await store.replay(runA, { afterSequence: 1 })).map((event) => event.eventId)).toEqual([
      second.eventId,
    ]);
    expect(await store.latestSequence(runA)).toBe(2);

    await database.close();
  });

  it("uses a bounded sequence allocation transaction and rolls it back on duplicate IDs", async () => {
    const { database, store } = await createStore();
    const sessionId = createSessionId();
    const runId = createRunId();
    await createParents(database, runId, sessionId);
    const draft = makeDraft(runId, sessionId, 1);
    appendInAuthoritativeTestTransaction(database, draft);
    expect(() => appendInAuthoritativeTestTransaction(database, draft)).toThrow();
    expect(await store.latestSequence(runId)).toBe(1);

    const sequences = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        appendInAuthoritativeTestTransaction(database, makeDraft(runId, sessionId, index + 10)),
      ),
    );
    expect(new Set(sequences.map((event) => event.durability.sequence)).size).toBe(50);
    expect(sequences.map((event) => event.durability.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 2),
    );

    await database.close();
  });

  it("replays through an inclusive upper sequence bound", async () => {
    const { database, store } = await createStore();
    const sessionId = createSessionId();
    const runId = createRunId();
    await createParents(database, runId, sessionId);

    appendInAuthoritativeTestTransaction(database, makeDraft(runId, sessionId, 1));
    appendInAuthoritativeTestTransaction(database, makeDraft(runId, sessionId, 2));
    appendInAuthoritativeTestTransaction(database, makeDraft(runId, sessionId, 3));

    expect(
      (await store.replay(runId, { afterSequence: 0, throughSequence: 2, limit: 10 })).map(
        (event) => event.durability.sequence,
      ),
    ).toEqual([1, 2]);
    expect(await store.replay(runId, { afterSequence: 2, throughSequence: 1, limit: 10 })).toEqual(
      [],
    );

    expect("append" in store).toBe(false);
    await database.close();
  });

  it("rejects an invalid replay limit", async () => {
    const { database, store } = await createStore();
    await expect(store.replay(createRunId(), { limit: 0 })).rejects.toThrow(/limit/);
    await expect(store.replay(createRunId(), { limit: 1001 })).rejects.toThrow(/limit/);
    await database.close();
  });
});
