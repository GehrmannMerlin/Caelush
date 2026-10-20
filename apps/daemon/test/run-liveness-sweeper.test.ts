import {
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type AgentRun,
  type RunId,
  type RunStatus,
} from "@caelush/protocol";
import type { RunRepository } from "@caelush/storage";
import { describe, expect, it, vi } from "vitest";

import {
  RunLivenessSweeper,
  type RunLivenessPolicy,
  type RunLivenessSweeperOptions,
} from "../src/execution/run-liveness-sweeper.js";
import type { RunExecutionSupervisor } from "../src/execution/run-execution-supervisor.js";

function run(id: RunId, status: RunStatus): AgentRun {
  return {
    id,
    sessionId: createSessionId(),
    goal: "liveness",
    status,
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 60_000 },
    createdAt: createTimestampMs(1),
  };
}

interface Harness {
  readonly sweeper: RunLivenessSweeper;
  readonly recovered: RunId[];
  readonly advance: (ms: number) => void;
  readonly setRuns: (runs: readonly AgentRun[]) => void;
  readonly setActive: (ids: readonly RunId[]) => void;
}

function harness(options: {
  readonly runs: readonly AgentRun[];
  readonly active?: readonly RunId[];
  readonly policy?: Partial<RunLivenessPolicy>;
}): Harness {
  let now = 0;
  let current = [...options.runs];
  let active = [...(options.active ?? [])];
  const recovered: RunId[] = [];

  const supervisor: Pick<RunExecutionSupervisor, "recover" | "activeRunIds"> = {
    recover: async (runId) => {
      recovered.push(runId);
      return {
        runId,
        action: "RECOVER",
        disposition: "SCHEDULED",
        run: run(runId, "RUNNING"),
      };
    },
    activeRunIds: () => active,
  };

  const runs: Pick<RunRepository, "listRecoverable"> = {
    listRecoverable: async () => current,
  };

  const sweeper = new RunLivenessSweeper({
    runs,
    supervisor,
    now: () => now,
    policy: {
      intervalMs: 1_000,
      runningIdleMs: 60_000,
      verifyingIdleMs: 60_000,
      approvalIdleMs: 120_000,
      cooldownMs: 30_000,
      maxAttemptsPerRun: 3,
      limit: 50,
      ...options.policy,
    },
  } satisfies RunLivenessSweeperOptions);

  return {
    sweeper,
    recovered,
    advance: (ms) => {
      now += ms;
    },
    setRuns: (next) => {
      current = [...next];
    },
    setActive: (ids) => {
      active = [...ids];
    },
  };
}

describe("RunLivenessSweeper", () => {
  it("waits out the silence window before recovering a VERIFYING Run", async () => {
    const id = createRunId();
    const h = harness({ runs: [run(id, "VERIFYING")] });

    expect((await h.sweeper.sweepOnce()).recovered).toEqual([]);
    h.advance(59_000);
    expect((await h.sweeper.sweepOnce()).recovered).toEqual([]);
    h.advance(2_000);
    const summary = await h.sweeper.sweepOnce();

    expect(summary.recovered).toEqual([id]);
    expect(h.recovered).toEqual([id]);
  });

  it("never re-drives a Run this daemon already owns", async () => {
    const id = createRunId();
    const h = harness({ runs: [run(id, "RUNNING")], active: [id] });
    await h.sweeper.sweepOnce();
    h.advance(10 * 60_000);

    const summary = await h.sweeper.sweepOnce();

    expect(summary.active).toBe(1);
    expect(h.recovered).toEqual([]);
  });

  it("leaves PENDING, WAITING_RESOURCE and terminal Runs alone", async () => {
    const pending = createRunId();
    const resource = createRunId();
    const completed = createRunId();
    const h = harness({
      runs: [
        run(pending, "PENDING"),
        run(resource, "WAITING_RESOURCE"),
        run(completed, "COMPLETED"),
      ],
    });
    await h.sweeper.sweepOnce();
    h.advance(60 * 60_000);

    const summary = await h.sweeper.sweepOnce();

    expect(summary.ineligible).toBe(3);
    expect(h.recovered).toEqual([]);
  });

  it("uses a longer silence window for a legitimately pending approval", async () => {
    const id = createRunId();
    const h = harness({
      runs: [run(id, "WAITING_APPROVAL")],
      policy: { approvalIdleMs: 15 * 60_000 },
    });

    await h.sweeper.sweepOnce();
    h.advance(10 * 60_000);
    expect((await h.sweeper.sweepOnce()).recovered).toEqual([]);
    h.advance(6 * 60_000);
    expect((await h.sweeper.sweepOnce()).recovered).toEqual([id]);
  });

  it("respects the cooldown between two attempts", async () => {
    const id = createRunId();
    const h = harness({
      runs: [run(id, "VERIFYING")],
      policy: { verifyingIdleMs: 1_000, cooldownMs: 10_000 },
    });

    await h.sweeper.sweepOnce();
    h.advance(1_001);
    expect((await h.sweeper.sweepOnce()).recovered).toEqual([id]);
    h.advance(1_000);
    expect((await h.sweeper.sweepOnce()).recovered).toEqual([]);
    h.advance(10_000);
    expect((await h.sweeper.sweepOnce()).recovered).toEqual([id]);
  });

  it("stops attempting once the per-status budget is exhausted", async () => {
    const id = createRunId();
    const h = harness({
      runs: [run(id, "VERIFYING")],
      policy: { verifyingIdleMs: 1_000, cooldownMs: 1_000, maxAttemptsPerRun: 2 },
    });
    await h.sweeper.sweepOnce();

    for (let index = 0; index < 6; index += 1) {
      h.advance(1_500);
      await h.sweeper.sweepOnce();
    }

    expect(h.recovered).toEqual([id, id]);
    const summary = await h.sweeper.sweepOnce();
    expect(summary.exhausted).toEqual([id]);
  });

  it("restarts the silence clock and the budget when the status changes", async () => {
    const id = createRunId();
    const h = harness({
      runs: [run(id, "VERIFYING")],
      policy: { verifyingIdleMs: 1_000, runningIdleMs: 1_000, maxAttemptsPerRun: 1 },
    });
    await h.sweeper.sweepOnce();
    h.advance(1_500);
    await h.sweeper.sweepOnce();
    expect(h.recovered).toEqual([id]);

    h.setRuns([run(id, "RUNNING")]);
    expect((await h.sweeper.sweepOnce()).recovered).toEqual([]);
    h.advance(1_500);
    expect((await h.sweeper.sweepOnce()).recovered).toEqual([id]);
    expect(h.recovered).toEqual([id, id]);
  });

  it("isolates one failing Run from the rest of the sweep", async () => {
    const first = createRunId();
    const second = createRunId();
    const logger = { error: vi.fn() };
    let now = 0;
    const sweeper = new RunLivenessSweeper({
      runs: { listRecoverable: async () => [run(first, "VERIFYING"), run(second, "VERIFYING")] },
      supervisor: {
        recover: async (runId) => {
          if (runId === first) throw new Error("scheduler refused");
          return { runId, action: "RECOVER", disposition: "SCHEDULED", run: run(runId, "RUNNING") };
        },
        activeRunIds: () => [],
      },
      now: () => now,
      logger,
    });

    await sweeper.sweepOnce();
    now = 10 * 60_000;
    const summary = await sweeper.sweepOnce();

    expect(summary.failed).toEqual([first]);
    expect(summary.recovered).toEqual([second]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("refuses further sweeps after stop()", async () => {
    const id = createRunId();
    const h = harness({ runs: [run(id, "VERIFYING")] });
    h.sweeper.stop();
    h.advance(10 * 60_000);

    const summary = await h.sweeper.sweepOnce();

    expect(summary.examined).toBe(0);
    expect(h.recovered).toEqual([]);
  });
});
