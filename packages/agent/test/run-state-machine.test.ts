import { RunStatusSchema, type RunStatus } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  assertRunStatusTransition,
  assertRunStatusTransitionsAreTotal,
  canTransitionRunStatus,
  InvalidRunStatusTransitionError,
  isTerminalRunStatus,
  RUN_STATUS_TRANSITIONS,
  RUN_STATUSES,
} from "../src/index.js";

/**
 * The canonical Run state machine, asserted against the matrix it replaced.
 *
 * Phase 3C moved the state machine from Core into the kernel. A move that changed the matrix would
 * be a lifecycle migration wearing a refactor's clothes, so the table below is written out from the
 * pre-migration Core source and compared row by row. The restatement is deliberate: deriving it
 * from the implementation would agree with any drift by construction.
 */

const FROZEN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  PENDING: ["RUNNING", "CANCELLED"],
  RUNNING: [
    "WAITING_APPROVAL",
    "WAITING_RESOURCE",
    "VERIFYING",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ],
  WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED", "TIMEOUT"],
  WAITING_RESOURCE: ["RUNNING", "FAILED", "CANCELLED", "TIMEOUT"],
  VERIFYING: ["COMPLETED", "RUNNING", "FAILED", "CANCELLED", "TIMEOUT", "BUDGET_EXCEEDED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMEOUT: [],
  MAX_STEPS_REACHED: [],
  BUDGET_EXCEEDED: [],
};

const FROZEN_TERMINAL: readonly RunStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
];

/** The Protocol status vocabulary, which the matrix must cover exactly. */
const PROTOCOL_STATUSES: readonly RunStatus[] = RunStatusSchema.options;

describe("canonical Run state machine", () => {
  it("covers exactly the Protocol status set", () => {
    expect([...RUN_STATUSES].sort()).toEqual([...PROTOCOL_STATUSES].sort());
    expect(Object.keys(RUN_STATUS_TRANSITIONS).sort()).toEqual([...PROTOCOL_STATUSES].sort());
  });

  it("preserves the pre-migration transition matrix row by row", () => {
    for (const status of RUN_STATUSES) {
      expect(RUN_STATUS_TRANSITIONS[status], status).toEqual(FROZEN_TRANSITIONS[status]);
    }
  });

  it("agrees with the frozen matrix on every status pair", () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        const expected = FROZEN_TRANSITIONS[from].includes(to);
        expect(canTransitionRunStatus(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("keeps the terminal predicate and the matrix in agreement", () => {
    // Two declarations of one fact: the settled set, and the rows with nothing in them.
    expect(() => assertRunStatusTransitionsAreTotal()).not.toThrow();
    for (const status of RUN_STATUSES) {
      expect(isTerminalRunStatus(status), status).toBe(FROZEN_TERMINAL.includes(status));
      expect(RUN_STATUS_TRANSITIONS[status].length === 0, status).toBe(
        FROZEN_TERMINAL.includes(status),
      );
    }
  });

  it("refuses a transition the matrix does not allow, with the canonical error", () => {
    expect(() => assertRunStatusTransition("COMPLETED", "RUNNING")).toThrow(
      InvalidRunStatusTransitionError,
    );
    expect(() => assertRunStatusTransition("RUNNING", "COMPLETED")).toThrow(
      InvalidRunStatusTransitionError,
    );
    expect(() => assertRunStatusTransition("PENDING", "VERIFYING")).toThrow(
      InvalidRunStatusTransitionError,
    );
    expect(() => assertRunStatusTransition("PENDING", "RUNNING")).not.toThrow();
    expect(() => assertRunStatusTransition("VERIFYING", "COMPLETED")).not.toThrow();

    try {
      assertRunStatusTransition("FAILED", "RUNNING");
      expect.unreachable("a settled Run must not reopen");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRunStatusTransitionError);
      expect((error as InvalidRunStatusTransitionError).from).toBe("FAILED");
      expect((error as InvalidRunStatusTransitionError).to).toBe("RUNNING");
    }
  });
});
