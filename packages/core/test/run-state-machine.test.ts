import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import type { RunStatus } from "@caelush/protocol";

const api = core as Record<string, unknown>;
type TransitionPredicate = (from: RunStatus, to: RunStatus) => boolean;
type TerminalPredicate = (status: RunStatus) => boolean;
type TransitionAssertion = (from: RunStatus, to: RunStatus) => void;

function getFunction<T extends (...args: never[]) => unknown>(name: string): T | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "function") {
    return undefined;
  }

  return value as T;
}

describe("Core Run State Machine", () => {
  it("allows only the canonical lifecycle transitions", () => {
    const canTransition = getFunction<TransitionPredicate>("canTransitionRunStatus");
    if (canTransition === undefined) {
      return;
    }

    const allowed: Array<[RunStatus, RunStatus]> = [
      ["PENDING", "RUNNING"],
      ["RUNNING", "WAITING_APPROVAL"],
      ["WAITING_APPROVAL", "RUNNING"],
      ["RUNNING", "VERIFYING"],
      ["VERIFYING", "RUNNING"],
      ["VERIFYING", "COMPLETED"],
    ];

    for (const [from, to] of allowed) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("requires verification before completion and rejects terminal reactivation", () => {
    const canTransition = getFunction<TransitionPredicate>("canTransitionRunStatus");
    if (canTransition === undefined) {
      return;
    }

    expect(canTransition("RUNNING", "COMPLETED")).toBe(false);
    expect(canTransition("COMPLETED", "RUNNING")).toBe(false);
    expect(canTransition("FAILED", "RUNNING")).toBe(false);
    expect(canTransition("CANCELLED", "RUNNING")).toBe(false);
    expect(canTransition("TIMEOUT", "RUNNING")).toBe(false);
  });

  it("marks every terminal status terminal and reports invalid transitions with context", () => {
    const isTerminal = getFunction<TerminalPredicate>("isTerminalRunStatus");
    const assertTransition = getFunction<TransitionAssertion>("assertRunStatusTransition");
    if (isTerminal === undefined || assertTransition === undefined) {
      return;
    }

    const terminalStatuses: RunStatus[] = [
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "MAX_STEPS_REACHED",
      "BUDGET_EXCEEDED",
    ];
    for (const status of terminalStatuses) {
      expect(isTerminal(status), status).toBe(true);
      expect(() => assertTransition(status, "RUNNING")).toThrow(`${status} -> RUNNING`);
    }
  });
});
