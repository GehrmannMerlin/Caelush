import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEventId, createTimestampMs, createToolInvocationId } from "@caelush/protocol";
import type { DurableRunEventDraft } from "@caelush/agent";
import { openCaelushStorage } from "../src/index.js";
import { appendDurableEventsInTransaction } from "../src/events/sqlite-durable-event-store.js";
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";

describe("storage restart recovery", () => {
  it("recovers entities, snapshots, event history, and the next sequence from a file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-recovery-"));
    const databasePath = path.join(directory, "caelush.db");
    const session = makeSession();
    const run = makeRun(session.id);
    const step = makeStep(run.id);
    const draft: DurableRunEventDraft = {
      eventId: createEventId(),
      schemaVersion: 1,
      runId: run.id,
      sessionId: session.id,
      timestamp: createTimestampMs(1),
      visibility: "USER_VISIBLE",
      durability: { kind: "DURABLE", version: 1 },
      type: "shell.output",
      payload: { invocationId: createToolInvocationId(), stream: "stdout", chunk: "ready" },
    };

    try {
      const first = await openCaelushStorage({ path: databasePath });
      await first.sessions.insert(session);
      await first.runs.insert(run);
      await first.steps.insert(step);
      await first.runStates.save(makeState(run));
      const firstClient = first.messageRecords.database.client;
      firstClient.exec("BEGIN IMMEDIATE");
      const [event] = appendDurableEventsInTransaction(firstClient, [draft]);
      if (event === undefined) throw new Error("first event append returned no event");
      firstClient.exec("COMMIT");
      expect(event.durability).toMatchObject({ sequence: 1 });
      await first.close();

      const second = await openCaelushStorage({ path: databasePath });
      expect(await second.sessions.get(session.id)).toEqual(session);
      expect(await second.runs.get(run.id)).toEqual(run);
      expect(await second.steps.get(step.id)).toEqual(step);
      expect(await second.runStates.get(run.id)).toEqual(makeState(run));
      expect(
        (
          await second.eventReader.replay(run.id, {
            afterSequence: 0,
            throughSequence: Number.MAX_SAFE_INTEGER,
            limit: 100,
          })
        ).map((item) => item.eventId),
      ).toEqual([event.eventId]);
      const secondClient = second.messageRecords.database.client;
      secondClient.exec("BEGIN IMMEDIATE");
      const [next] = appendDurableEventsInTransaction(secondClient, [
        {
          ...draft,
          eventId: createEventId(),
          timestamp: createTimestampMs(2),
        },
      ]);
      if (next === undefined) throw new Error("second event append returned no event");
      secondClient.exec("COMMIT");
      expect(next.durability).toMatchObject({ sequence: 2 });
      await second.close();

      const sqlite = new DatabaseSync(databasePath);
      expect(sqlite.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      sqlite.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
