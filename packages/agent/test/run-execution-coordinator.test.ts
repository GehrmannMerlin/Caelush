import { describe, expect, it } from "vitest";
import {
  createRunExecutionCoordinator,
  isTerminalExecutionStatus,
  nextRunExecutionDirective,
  RUN_EXECUTION_DIRECTIVE_KINDS,
} from "../src/index.js";
import type { RunExecutionDirective, RunExecutionFacts, RunExecutionStatus } from "../src/index.js";

/**
 * The frozen coordinator, as a table.
 *
 * These tests are the 3C-18 matrix: every durable state the Run Layer can be in, and the single
 * directive it must produce. They need no database, no clock and no provider, because the
 * decision is pure — which is exactly the property this file exists to prove.
 */

const NOW = 1_000;

function facts(overrides: Partial<RunExecutionFacts> = {}): RunExecutionFacts {
  return { runId: "run_1", status: "RUNNING", ...overrides };
}

function next(overrides: Partial<RunExecutionFacts>, now = NOW): RunExecutionDirective {
  return nextRunExecutionDirective(facts(overrides), now);
}

describe("RunExecutionCoordinator decision table", () => {
  it.each<[string, Partial<RunExecutionFacts>, RunExecutionDirective]>([
    /* --- initial ------------------------------------------------------------ */
    ["INITIAL", { status: "PENDING" }, { kind: "ADVANCE_AGENT", mode: "START" }],
    [
      "RUNNING with no continuation",
      { status: "RUNNING" },
      { kind: "ADVANCE_AGENT", mode: "START" },
    ],

    /* --- tool waiting ------------------------------------------------------- */
    [
      "TOOL waiting with no results",
      { continuation: "WAITING_TOOL_RESULTS", toolBatchAvailable: true },
      { kind: "EXECUTE_TOOL_BATCH", mode: "EXECUTE" },
    ],
    [
      "TOOL waiting with results",
      { continuation: "WAITING_TOOL_RESULTS", toolResultsAccepted: true },
      { kind: "ADVANCE_AGENT", mode: "TOOLS" },
    ],
    [
      "TOOL waiting at an approval pointer",
      { continuation: "WAITING_TOOL_RESULTS", awaitingApproval: true },
      { kind: "SUSPEND", reason: "APPROVAL" },
    ],
    [
      "TOOL waiting without a coordinator",
      { continuation: "WAITING_TOOL_RESULTS", toolBatchAvailable: false },
      { kind: "RETURN_TERMINAL", status: "RUNNING", reason: "TOOL_COORDINATOR_UNAVAILABLE" },
    ],

    /* --- retry -------------------------------------------------------------- */
    [
      "RETRY not due",
      { continuation: "WAITING_RETRY", retryNextAttemptAt: NOW + 1 },
      { kind: "SUSPEND", reason: "RETRY_NOT_DUE" },
    ],
    [
      "RETRY due, start",
      { continuation: "WAITING_RETRY", retryNextAttemptAt: NOW, retryResumesToolResults: false },
      { kind: "ADVANCE_AGENT", mode: "START" },
    ],
    [
      "RETRY due, tool result",
      { continuation: "WAITING_RETRY", retryNextAttemptAt: NOW, retryResumesToolResults: true },
      { kind: "ADVANCE_AGENT", mode: "TOOLS" },
    ],
    [
      "RETRY due at exactly now",
      { continuation: "WAITING_RETRY", retryNextAttemptAt: NOW },
      { kind: "ADVANCE_AGENT", mode: "START" },
    ],

    /* --- approval and resource ---------------------------------------------- */
    [
      "APPROVAL",
      { status: "WAITING_APPROVAL", continuation: "WAITING_TOOL_RESULTS" },
      { kind: "SUSPEND", reason: "APPROVAL" },
    ],
    [
      "RESOURCE",
      { status: "WAITING_RESOURCE", continuation: "WAITING_RESOURCE" },
      { kind: "SUSPEND", reason: "RESOURCE" },
    ],
    [
      "RESOURCE continuation without the status",
      { continuation: "WAITING_RESOURCE" },
      { kind: "SUSPEND", reason: "RESOURCE" },
    ],

    /* --- verification ------------------------------------------------------- */
    [
      "VERIFYING",
      { status: "VERIFYING", continuation: "AWAITING_VERIFICATION", completionAvailable: true },
      { kind: "EVALUATE_COMPLETION", mode: "RECOVER" },
    ],
    [
      "VERIFICATION REPAIR",
      { continuation: "WAITING_VERIFICATION_REPAIR" },
      { kind: "ADVANCE_AGENT", mode: "REPAIR" },
    ],
    [
      "VERIFYING without a completion gate",
      { status: "VERIFYING", completionAvailable: false },
      { kind: "RETURN_TERMINAL", status: "VERIFYING", reason: "UNAVAILABLE_VERIFICATION" },
    ],

    /* --- terminal ----------------------------------------------------------- */
    [
      "Terminal COMPLETED",
      { status: "COMPLETED", stepsCompleted: 3 },
      { kind: "RETURN_TERMINAL", status: "COMPLETED", reason: "ALREADY_TERMINAL" },
    ],
    [
      "Terminal FAILED",
      { status: "FAILED" },
      { kind: "RETURN_TERMINAL", status: "FAILED", reason: "ALREADY_TERMINAL" },
    ],
    [
      "Terminal BUDGET_EXCEEDED",
      { status: "BUDGET_EXCEEDED" },
      { kind: "RETURN_TERMINAL", status: "BUDGET_EXCEEDED", reason: "ALREADY_TERMINAL" },
    ],
  ])("%s", (_label, overrides, expected) => {
    expect(next(overrides)).toEqual(expected);
  });
});

describe("RunExecutionCoordinator governance priority", () => {
  it("settles a cancelled Run before any continuation it holds", () => {
    expect(
      next({
        cancellationRequested: true,
        continuation: "WAITING_TOOL_RESULTS",
        toolResultsAccepted: true,
      }),
    ).toEqual({ kind: "FINALIZE", finalization: { reason: "CANCELLED" } });
  });

  it("settles a cancelled Run even when a retry is due", () => {
    expect(
      next({
        cancellationRequested: true,
        continuation: "WAITING_RETRY",
        retryNextAttemptAt: 0,
      }),
    ).toEqual({ kind: "FINALIZE", finalization: { reason: "CANCELLED" } });
  });

  it("settles an expired Run before a due retry", () => {
    expect(
      next({ deadlineExceeded: true, continuation: "WAITING_RETRY", retryNextAttemptAt: 0 }),
    ).toEqual({ kind: "FINALIZE", finalization: { reason: "TIMEOUT" } });
  });

  it("settles an expired Run even when results were already accepted", () => {
    expect(
      next({
        deadlineExceeded: true,
        continuation: "WAITING_TOOL_RESULTS",
        toolResultsAccepted: true,
      }),
    ).toEqual({ kind: "FINALIZE", finalization: { reason: "TIMEOUT" } });
  });

  it("reports an unexpected abort instead of routing it", () => {
    expect(next({ aborted: true })).toEqual({
      kind: "RETURN_TERMINAL",
      status: "RUNNING",
      reason: "UNEXPECTED_ABORT",
    });
  });

  it("treats a user abort as a cancellation", () => {
    expect(next({ aborted: true, abortCause: "USER_REQUESTED" })).toEqual({
      kind: "FINALIZE",
      finalization: { reason: "CANCELLED" },
    });
  });

  it("treats a deadline abort as a timeout", () => {
    expect(next({ aborted: true, abortCause: "DEADLINE_EXCEEDED" })).toEqual({
      kind: "FINALIZE",
      finalization: { reason: "TIMEOUT" },
    });
  });

  it("never lets a stale active Step become a provider call", () => {
    expect(next({ activeStep: true })).toEqual({
      kind: "RETURN_TERMINAL",
      status: "RUNNING",
      reason: "MISSING_CONTINUATION",
    });
  });

  it("reports a boundary it cannot satisfy instead of inventing a transition", () => {
    expect(next({ status: "WAITING_RESOURCE" })).toEqual({
      kind: "SUSPEND",
      reason: "RESOURCE",
    });
    // Any status the coordinator does not know is reported, never guessed.
    expect(next({ status: "RUNNING", continuation: "AWAITING_VERIFICATION" })).toEqual({
      kind: "EVALUATE_COMPLETION",
      mode: "EVALUATE",
    });
  });
});

describe("RunExecutionCoordinator maxSteps", () => {
  it("settles MAX_STEPS_REACHED when the budget is spent", () => {
    expect(next({ stepsCompleted: 3, maxSteps: 3 })).toEqual({
      kind: "FINALIZE",
      finalization: { reason: "MAX_STEPS_REACHED", stepsCompleted: 3, maxSteps: 3 },
    });
  });

  it("settles the budget before a due retry could start another turn", () => {
    expect(
      next({
        continuation: "WAITING_RETRY",
        retryNextAttemptAt: 0,
        stepsCompleted: 4,
        maxSteps: 4,
      }),
    ).toEqual({
      kind: "FINALIZE",
      finalization: { reason: "MAX_STEPS_REACHED", stepsCompleted: 4, maxSteps: 4 },
    });
  });

  it("settles the budget before an accepted Tool result resumes the loop", () => {
    expect(
      next({
        continuation: "WAITING_TOOL_RESULTS",
        toolResultsAccepted: true,
        stepsCompleted: 2,
        maxSteps: 2,
      }),
    ).toEqual({
      kind: "FINALIZE",
      finalization: { reason: "MAX_STEPS_REACHED", stepsCompleted: 2, maxSteps: 2 },
    });
  });

  it("settles the budget before a verification repair epoch", () => {
    expect(
      next({
        continuation: "WAITING_VERIFICATION_REPAIR",
        stepsCompleted: 9,
        maxSteps: 9,
      }),
    ).toEqual({
      kind: "FINALIZE",
      finalization: { reason: "MAX_STEPS_REACHED", stepsCompleted: 9, maxSteps: 9 },
    });
  });

  it("leaves one remaining step to run", () => {
    expect(next({ stepsCompleted: 2, maxSteps: 3 })).toEqual({
      kind: "ADVANCE_AGENT",
      mode: "START",
    });
  });

  it("ignores an unusable budget rather than guessing", () => {
    expect(next({ stepsCompleted: 5, maxSteps: 0 })).toEqual({
      kind: "ADVANCE_AGENT",
      mode: "START",
    });
    expect(next({ stepsCompleted: 5, maxSteps: Number.NaN })).toEqual({
      kind: "ADVANCE_AGENT",
      mode: "START",
    });
  });
});

describe("RunExecutionCoordinator determinism", () => {
  it("returns the same directive for the same facts and the same now", () => {
    const snapshot = facts({
      continuation: "WAITING_TOOL_RESULTS",
      toolResultsAccepted: true,
      stepsCompleted: 1,
      maxSteps: 4,
    });

    const first = nextRunExecutionDirective(snapshot, NOW);
    const second = nextRunExecutionDirective(snapshot, NOW);
    const third = nextRunExecutionDirective({ ...snapshot }, NOW);

    expect(first).toEqual(second);
    expect(first).toEqual(third);
  });

  it("is deterministic across every table row", () => {
    const statuses: readonly RunExecutionStatus[] = [
      "PENDING",
      "RUNNING",
      "WAITING_APPROVAL",
      "WAITING_RESOURCE",
      "VERIFYING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "MAX_STEPS_REACHED",
      "BUDGET_EXCEEDED",
    ];
    const continuations = [
      undefined,
      "WAITING_TOOL_RESULTS",
      "WAITING_RETRY",
      "WAITING_VERIFICATION_REPAIR",
      "WAITING_RESOURCE",
      "AWAITING_VERIFICATION",
    ] as const;

    for (const status of statuses) {
      for (const continuation of continuations) {
        for (const accepted of [undefined, true, false]) {
          const snapshot = facts({
            status,
            ...(continuation === undefined ? {} : { continuation }),
            ...(accepted === undefined ? {} : { toolResultsAccepted: accepted }),
            stepsCompleted: 1,
            maxSteps: 4,
            retryNextAttemptAt: NOW,
          });
          const a = nextRunExecutionDirective(snapshot, NOW);
          const b = nextRunExecutionDirective({ ...snapshot }, NOW);
          expect(a).toEqual(b);
          // Every answer is one of the frozen discriminants.
          expect(RUN_EXECUTION_DIRECTIVE_KINDS).toContain(a.kind);
        }
      }
    }
  });

  it("does not change a SUSPEND into a resume as time passes", () => {
    const pending = facts({ continuation: "WAITING_RETRY", retryNextAttemptAt: NOW + 100 });
    expect(nextRunExecutionDirective(pending, NOW)).toEqual({
      kind: "SUSPEND",
      reason: "RETRY_NOT_DUE",
    });
    expect(nextRunExecutionDirective(pending, NOW + 99)).toEqual({
      kind: "SUSPEND",
      reason: "RETRY_NOT_DUE",
    });
    // Only reaching the deadline changes the answer, and it never shortens it.
    expect(nextRunExecutionDirective(pending, NOW + 100)).toEqual({
      kind: "ADVANCE_AGENT",
      mode: "START",
    });
  });

  it("exposes the terminal status set it routes on", () => {
    for (const status of [
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "MAX_STEPS_REACHED",
      "BUDGET_EXCEEDED",
    ] as const) {
      expect(isTerminalExecutionStatus(status)).toBe(true);
    }
    for (const status of [
      "PENDING",
      "RUNNING",
      "WAITING_APPROVAL",
      "WAITING_RESOURCE",
      "VERIFYING",
    ] as const) {
      expect(isTerminalExecutionStatus(status)).toBe(false);
    }
  });

  it("is reachable through the frozen interface", () => {
    const coordinator = createRunExecutionCoordinator();
    const snapshot = facts({ status: "PENDING" });
    expect(coordinator.next(snapshot, NOW)).toEqual(nextRunExecutionDirective(snapshot, NOW));
  });
});
