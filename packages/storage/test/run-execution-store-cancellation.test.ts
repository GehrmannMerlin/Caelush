import { createTimestampMs } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((storage) => storage.close()));
});

describe("RunExecutionStore cancellation visibility", () => {
  it("returns a durable cancellation intent in the execution snapshot", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const session = makeSession();
    const run = makeRun(session.id);
    await storage.sessions.insert(session);
    await storage.runs.insert(run);
    const requestedAt = createTimestampMs(200);

    await storage.execution.requestCancellation!(run.id, {
      runId: run.id,
      cause: "USER_REQUESTED",
      requestedAt,
    });

    const snapshot = await storage.execution.load(run.id);
    expect(snapshot?.cancellationIntent).toEqual({
      runId: run.id,
      cause: "USER_REQUESTED",
      requestedAt,
    });
  });
});
