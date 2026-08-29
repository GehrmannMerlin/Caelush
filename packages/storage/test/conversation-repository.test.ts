import { describe, expect, it } from "vitest";
import { createStepId, createTimestampMs } from "@caelush/protocol";
import { openCaelushStorage } from "../src/index.js";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { SqliteConversationRepository } from "../src/repositories/conversation-repository.js";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";

describe("ConversationRepository", () => {
  it("appends real messages with contiguous run-local sequences and source steps", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const run = makeRun(session.id);
    const otherRun = makeRun(session.id);
    const stepId = createStepId();
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    await storage.runs.insert(otherRun);
    await storage.steps.insert(makeStep(run.id, { id: stepId }));

    await storage.messages.append(run.id, [
      { message: { role: "user", content: "goal" }, createdAt: createTimestampMs(100) },
      {
        message: {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: {} }],
        },
        sourceStepId: stepId,
        createdAt: createTimestampMs(100),
      },
    ]);
    await storage.messages.append(otherRun.id, [
      { message: { role: "user", content: "other" }, createdAt: createTimestampMs(100) },
    ]);

    expect(await storage.messages.listByRun(run.id)).toEqual([
      {
        runId: run.id,
        sequence: 1,
        createdAt: createTimestampMs(100),
        message: { role: "user", content: "goal" },
      },
      {
        runId: run.id,
        sequence: 2,
        sourceStepId: stepId,
        createdAt: createTimestampMs(100),
        message: {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: {} }],
        },
      },
    ]);
    expect((await storage.messages.listByRun(otherRun.id))[0]?.sequence).toBe(1);
    await storage.close();
  });

  it("rejects system messages and corrupted ledger rows", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    const session = makeSession();
    const run = makeRun(session.id);
    await storage.sessions.insert(session);
    await storage.runs.insert(run);

    await expect(
      storage.messages.append(run.id, [
        {
          message: { role: "system", content: "synthetic" } as never,
          createdAt: createTimestampMs(100),
        },
      ]),
    ).rejects.toThrow();
    await storage.close();

    const database = await openCaelushDatabase({ path: ":memory:" });
    await migrateCaelushDatabase(database);
    const corrupted = new SqliteConversationRepository(database);
    const corruptedSession = makeSession();
    const corruptedRun = makeRun(corruptedSession.id);
    database.client
      .prepare(
        "INSERT INTO agent_sessions (id, protocol_version, created_at_ms, updated_at_ms, data_json) VALUES (?, 1, ?, ?, ?)",
      )
      .run(
        corruptedSession.id,
        corruptedSession.createdAt,
        corruptedSession.updatedAt,
        JSON.stringify(corruptedSession),
      );
    database.client
      .prepare(
        "INSERT INTO agent_runs (id, session_id, protocol_version, status, created_at_ms, data_json) VALUES (?, ?, 1, ?, ?, ?)",
      )
      .run(
        corruptedRun.id,
        corruptedRun.sessionId,
        corruptedRun.status,
        corruptedRun.createdAt,
        JSON.stringify(corruptedRun),
      );
    database.client
      .prepare(
        "INSERT INTO agent_messages (run_id, sequence, role, source_step_id, protocol_version, created_at_ms, data_json) VALUES (?, 1, 'system', NULL, 1, 100, ?)",
      )
      .run(corruptedRun.id, JSON.stringify({ role: "system", content: "synthetic" }));
    await expect(corrupted.listByRun(corruptedRun.id)).rejects.toThrow();
    await database.close();
  });
});
