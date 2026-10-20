import { createTimestampMs, type RunResourcePolicy } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushDatabase } from "../src/database.js";
import { migrateCaelushDatabase } from "../src/migrate.js";
import { StorageDecodeError } from "../src/errors.js";
import {
  ResourceGovernanceConflictError,
  SqliteResourceGovernanceRepository,
  type ResourceGovernanceState,
} from "../src/resource-governance-repository.js";
import { SqliteRunRepository } from "../src/repositories/run-repository.js";
import { SqliteSessionRepository } from "../src/repositories/session-repository.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const databases: Array<{ close(): void }> = [];
const policy: RunResourcePolicy = {
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

async function openRepository() {
  const database = await openCaelushDatabase({ path: ":memory:" });
  databases.push(database);
  await migrateCaelushDatabase(database);
  const session = makeSession();
  const run = makeRun(session.id, { status: "RUNNING", startedAt: createTimestampMs(100) });
  await new SqliteSessionRepository(database).insert(session);
  await new SqliteRunRepository(database).insert(run);
  return { repository: new SqliteResourceGovernanceRepository(database), run, database };
}

describe("SqliteResourceGovernanceRepository", () => {
  it("creates a durable bounded state and renews its lease with CAS", async () => {
    const { repository, run } = await openRepository();
    const state = await repository.createOrGet(run.id, {
      policyVersion: "v1",
      mode: policy.mode,
      now: createTimestampMs(101),
    });
    expect(state).toMatchObject({
      runId: run.id,
      policyVersion: "v1",
      mode: "ADAPTIVE",
      leaseEpoch: 1,
      leaseStartAgentTurns: 0,
      leaseStartToolCalls: 0,
      consecutiveNoProgressTurns: 0,
      replanCount: 0,
      resourceGuardState: "NONE",
      revision: 0,
    });

    const renewed: ResourceGovernanceState = {
      ...state,
      leaseEpoch: 2,
      leaseStartAgentTurns: 24,
      leaseStartToolCalls: 64,
      revision: 1,
      updatedAt: createTimestampMs(102),
    };
    await repository.compareAndSwap(run.id, state.revision, renewed);
    expect((await repository.get(run.id))?.leaseEpoch).toBe(2);
    await expect(repository.compareAndSwap(run.id, state.revision, renewed)).rejects.toBeInstanceOf(
      ResourceGovernanceConflictError,
    );
  });

  it("bounds persisted fingerprint summaries and survives database reopening", async () => {
    const { repository, run } = await openRepository();
    const state = await repository.createOrGet(run.id, {
      policyVersion: "v1",
      mode: policy.mode,
      now: createTimestampMs(101),
    });
    const bounded = {
      ...state,
      recentFingerprints: Array.from({ length: 64 }, (_, index) => ({
        request: `r${index}`,
        result: `s${index}`,
      })),
      revision: 1,
      updatedAt: createTimestampMs(102),
    };
    await repository.compareAndSwap(run.id, 0, bounded);
    const loaded = await repository.get(run.id);
    expect(loaded?.recentFingerprints).toHaveLength(64);
    expect(JSON.stringify(loaded)).not.toContain("raw Tool output");
    expect(loaded?.recentFingerprints[0]).toEqual({ request: "r0", result: "s0" });
  });

  it("stores the repeated-failure window beside the fingerprint ledger", async () => {
    const { repository, run } = await openRepository();
    const state = await repository.createOrGet(run.id, {
      policyVersion: "v1",
      mode: policy.mode,
      now: createTimestampMs(101),
    });
    const progress = {
      version: 1 as const,
      turns: [
        {
          turnId: "step-1",
          patterns: [
            {
              key: "a".repeat(64),
              toolName: "apply_patch",
              code: "TOOL_ARGUMENT_ERROR",
              fields: [{ keyword: "required", name: "patch" }],
            },
          ],
          succeededTools: [],
          classified: true,
        },
      ],
      active: {
        key: "a".repeat(64),
        toolName: "apply_patch",
        code: "TOOL_ARGUMENT_ERROR",
        replans: 0,
        nudged: false,
      },
    };
    await repository.compareAndSwap(run.id, state.revision, {
      ...state,
      semanticProgress: progress,
      revision: state.revision + 1,
      updatedAt: createTimestampMs(102),
    });

    const loaded = await repository.get(run.id);
    expect(loaded?.semanticProgress).toEqual(progress);
    // Nothing raw travels with it: the window holds declared names only.
    expect(JSON.stringify(loaded?.semanticProgress)).not.toContain("*** Begin Patch");
  });

  it("keeps reading a legacy fingerprint array and refuses an unknown ledger version", async () => {
    const { repository, run, database } = await openRepository();
    await repository.createOrGet(run.id, {
      policyVersion: "v1",
      mode: policy.mode,
      now: createTimestampMs(101),
    });
    database.client
      .prepare("UPDATE run_resource_states SET recent_fingerprints_json = ? WHERE run_id = ?")
      .run(JSON.stringify([{ request: "r0", result: "s0" }]), run.id);
    const legacy = await repository.get(run.id);
    expect(legacy?.recentFingerprints).toEqual([{ request: "r0", result: "s0" }]);
    expect(legacy?.semanticProgress).toBeUndefined();

    database.client
      .prepare("UPDATE run_resource_states SET recent_fingerprints_json = ? WHERE run_id = ?")
      .run(JSON.stringify({ version: 99, fingerprints: [] }), run.id);
    await expect(repository.get(run.id)).rejects.toBeInstanceOf(StorageDecodeError);
  });
});
