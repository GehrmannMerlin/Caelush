import { createRunId, createTimestampMs, createWorkspaceId, type AgentRun } from "@caelush/protocol";
import { createSessionId } from "@caelush/protocol";
import type { RunRepository } from "@caelush/storage";
import { describe, expect, it, vi } from "vitest";

import {
  reconcileStaleRuns,
  type StartupReconciliationSummary,
} from "../src/execution/run-startup-reconciliation.js";
import type {
  RunExecutionSupervisor,
  RunExecutionSupervisorLogger,
  RunExecutionSupervisorResult,
} from "../src/execution/run-execution-supervisor.js";

function run(status: AgentRun["status"]): AgentRun {
  return {
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "reconcile",
    status,
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
    createdAt: createTimestampMs(1),
  };
}

interface Harness {
  readonly runs: Pick<RunRepository, "listRecoverable">;
  readonly supervisor: Pick<RunExecutionSupervisor, "recover">;
  readonly recovered: string[];
}

function harness(options: {
  readonly stale: readonly AgentRun[];
  readonly disposition?: (
    run: AgentRun,
  ) => RunExecutionSupervisorResult["disposition"] | "THROW";
  readonly seenLimit?: (limit: number | undefined) => void;
}): Harness {
  const recovered: string[] = [];
  const runs: Pick<RunRepository, "listRecoverable"> = {
    listRecoverable: async (query) => {
      options.seenLimit?.(query?.limit);
      return [...options.stale];
    },
  };
  const supervisor: Pick<RunExecutionSupervisor, "recover"> = {
    recover: async (runId) => {
      const target = options.stale.find((candidate) => candidate.id === runId);
      if (target === undefined) throw new Error("unknown run");
      const disposition = options.disposition?.(target) ?? "SCHEDULED";
      if (disposition === "THROW") throw new Error(`cannot recover ${runId}`);
      recovered.push(runId);
      return { runId, action: "RECOVER", disposition, run: target };
    },
  };
  return { runs, supervisor, recovered };
}

function ids(summary: StartupReconciliationSummary): readonly string[] {
  return [
    ...summary.scheduled,
    ...summary.alreadyActive,
    ...summary.noopTerminal,
    ...summary.failed,
  ];
}

describe("reconcileStaleRuns", () => {
  it("hands every non-terminal Run to the existing recovery authority", async () => {
    const stale = [
      run("RUNNING"),
      run("VERIFYING"),
      run("WAITING_APPROVAL"),
      run("WAITING_RESOURCE"),
    ];
    const h = harness({ stale });
    const summary = await reconcileStaleRuns({ runs: h.runs, supervisor: h.supervisor });

    expect(summary.examined).toBe(4);
    expect(summary.scheduled).toEqual(stale.map((candidate) => candidate.id));
    expect(summary.alreadyActive).toEqual([]);
    expect(summary.noopTerminal).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(h.recovered).toEqual(stale.map((candidate) => candidate.id));
  });

  it("never asks recovery to start a PENDING Run", async () => {
    const pending = run("PENDING");
    const live = run("RUNNING");
    const h = harness({ stale: [pending, live] });
    const summary = await reconcileStaleRuns({ runs: h.runs, supervisor: h.supervisor });

    expect(h.recovered).toEqual([live.id]);
    expect(summary.scheduled).toEqual([live.id]);
    expect(ids(summary)).not.toContain(pending.id);
  });

  it("never asks recovery to reopen a terminal Run", async () => {
    for (const status of [
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "MAX_STEPS_REACHED",
      "BUDGET_EXCEEDED",
    ] as const) {
      const terminal = run(status);
      const h = harness({ stale: [terminal] });
      const summary = await reconcileStaleRuns({ runs: h.runs, supervisor: h.supervisor });
      expect(h.recovered).toEqual([]);
      expect(ids(summary)).not.toContain(terminal.id);
    }
  });

  it("maps the supervisor's dispositions without inventing a second state machine", async () => {
    const scheduledRun = run("RUNNING");
    const activeRun = run("VERIFYING");
    const terminalByExam = run("WAITING_RESOURCE");
    const h = harness({
      stale: [scheduledRun, activeRun, terminalByExam],
      disposition: (candidate) =>
        candidate.id === activeRun.id
          ? "ALREADY_ACTIVE"
          : candidate.id === terminalByExam.id
            ? "NOOP_TERMINAL"
            : "SCHEDULED",
    });
    const summary = await reconcileStaleRuns({ runs: h.runs, supervisor: h.supervisor });

    expect(summary.scheduled).toEqual([scheduledRun.id]);
    expect(summary.alreadyActive).toEqual([activeRun.id]);
    expect(summary.noopTerminal).toEqual([terminalByExam.id]);
    expect(summary.failed).toEqual([]);
  });

  it("isolates one Run's failure so the others are still reconciled and the daemon keeps serving", async () => {
    const broken = run("RUNNING");
    const healthy = run("VERIFYING");
    const errors: unknown[] = [];
    const logger: RunExecutionSupervisorLogger = {
      error: (error, context) => {
        expect(context.operation).toBe("STARTUP_RECONCILE");
        errors.push({ error, runId: context.runId });
      },
    };
    const h = harness({
      stale: [broken, healthy],
      disposition: (candidate) => (candidate.id === broken.id ? "THROW" : "SCHEDULED"),
    });

    const summary = await reconcileStaleRuns({
      runs: h.runs,
      supervisor: h.supervisor,
      logger,
    });

    expect(summary.failed).toEqual([broken.id]);
    expect(summary.scheduled).toEqual([healthy.id]);
    expect(h.recovered).toEqual([healthy.id]);
    expect(errors).toEqual([
      { error: expect.any(Error), runId: broken.id },
    ]);
  });

  it("survives a logger that throws, because logging must not become a startup failure", async () => {
    const broken = run("RUNNING");
    const h = harness({ stale: [broken], disposition: () => "THROW" });
    const logger: RunExecutionSupervisorLogger = {
      error: () => {
        throw new Error("logger exploded");
      },
    };

    const summary = await reconcileStaleRuns({ runs: h.runs, supervisor: h.supervisor, logger });
    expect(summary.failed).toEqual([broken.id]);
  });

  it("forwards the bounded enumeration limit to the repository", async () => {
    const seenLimit = vi.fn();
    const h = harness({ stale: [run("RUNNING")], seenLimit });
    await reconcileStaleRuns({ runs: h.runs, supervisor: h.supervisor, limit: 7 });
    expect(seenLimit).toHaveBeenCalledWith(7);

    h.recovered.length = 0;
    const unlimited = harness({ stale: [], seenLimit });
    await reconcileStaleRuns({ runs: unlimited.runs, supervisor: unlimited.supervisor });
    expect(seenLimit).toHaveBeenLastCalledWith(undefined);
  });

  it("reports an empty backlog without touching the recovery authority", async () => {
    const h = harness({ stale: [] });
    const summary = await reconcileStaleRuns({ runs: h.runs, supervisor: h.supervisor });
    expect(summary).toEqual({
      examined: 0,
      scheduled: [],
      alreadyActive: [],
      noopTerminal: [],
      failed: [],
    });
    expect(h.recovered).toEqual([]);
  });
});
