import { createRunId, createTimestampMs } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((storage) => storage.close()));
});

describe("SQLite cancellation intents", () => {
  it("persists the first user cancellation intent and is idempotent", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const session = makeSession();
    const run = makeRun(session.id);
    await storage.sessions.insert(session);
    await storage.runs.insert(run);

    const first = {
      runId: run.id,
      cause: "USER_REQUESTED" as const,
      requestedAt: createTimestampMs(200),
    };
    const later = { ...first, requestedAt: createTimestampMs(300) };

    expect(await storage.cancellations.request(first)).toEqual(first);
    expect(await storage.cancellations.request(later)).toEqual(first);
    expect(await storage.cancellations.get(run.id)).toEqual(first);
  });

  it("rejects an intent for a missing run", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);

    await expect(
      storage.cancellations.request({
        runId: createRunId(),
        cause: "USER_REQUESTED",
        requestedAt: createTimestampMs(200),
      }),
    ).rejects.toBeTruthy();
  });
});
