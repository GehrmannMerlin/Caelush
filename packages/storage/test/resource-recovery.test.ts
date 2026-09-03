import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTimestampMs } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import {
  SqliteResourceGovernanceRepository,
  type ResourceGovernanceState,
} from "../src/resource-governance-repository.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { makeRun, makeSession } from "./support/fixtures.js";

let directory: string | undefined;
let database: { close(): void } | undefined;

afterEach(async () => {
  database?.close();
  database = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("resource governance recovery", () => {
  it("reloads lease, progress, and guard state after a storage restart", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "caelush-resource-recovery-"));
    database = await openCaelushDatabase({ path: path.join(directory, "resource.db") });
    await migrateCaelushDatabase(database as never);
    const session = makeSession();
    const storedRun = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(100) });
    await new SqliteSessionRepository(database as never).insert(session);
    await new SqliteRunRepository(database as never).insert(storedRun);
    const persistedRun = storedRun;
    const repository = new SqliteResourceGovernanceRepository(database as never);
    const initial = await repository.createOrGet(persistedRun.id, {
      policyVersion: "adaptive-resource-governance.v1",
      mode: "ADAPTIVE",
      now: createTimestampMs(101),
    });
    const next: ResourceGovernanceState = {
      ...initial,
      leaseEpoch: 3,
      consecutiveNoProgressTurns: 4,
      replanCount: 2,
      resourceGuardState: "WAITING_RESOURCE",
      recentFingerprints: [{ request: "v1:request", result: "v1:result" }],
      revision: 1,
      updatedAt: createTimestampMs(102),
    };
    await repository.compareAndSwap(persistedRun.id, initial.revision, next);
    database.close();
    database = undefined;

    database = await openCaelushDatabase({ path: path.join(directory, "resource.db") });
    await migrateCaelushDatabase(database as never);
    const recovered = await new SqliteResourceGovernanceRepository(database as never).get(
      persistedRun.id,
    );
    expect(recovered).toMatchObject({
      leaseEpoch: 3,
      consecutiveNoProgressTurns: 4,
      replanCount: 2,
      resourceGuardState: "WAITING_RESOURCE",
    });
  });
});
