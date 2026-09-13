import { describe, expect, it } from "vitest";
import {
  createRunExecutionCoordinator,
  createRunTransitionPlanner,
  planRunTransition,
} from "@caelush/agent";
import type {
  RunExecutionFacts,
  RunExecutionEffectResult,
  RunTransitionDraft,
} from "@caelush/agent";
import { toExecutionStatus } from "../src/run-execution-facts.js";

/**
 * The frozen coordinator and transition planner, as the Run Layer uses them.
 *
 * The coordinator's own table is tested in `packages/agent/test/run-execution-coordinator.test.ts`.
 * This file proves the other half of the 3C contract: that a directive leads to the right *plan*,
 * and that a plan is a pure description rather than a write.
 */

const NOW = 1_000;

function facts(overrides: Partial<RunExecutionFacts> = {}): RunExecutionFacts {
  return { runId: "run_1", status: "RUNNING", ...overrides };
}

function plan(effect: RunExecutionEffectResult, overrides: Partial<RunExecutionFacts> = {}) {
  return planRunTransition({ facts: facts(overrides), effect, now: NOW });
}

describe("RunTransitionPlanner effect to commit planning", () => {
  it("moves a final candidate to verification and never to completion", () => {
    const draft = plan({
      kind: "AGENT",
      mode: "START",
      outcome: {
        status: "DECIDED",
        decision: {
          type: "FINAL_CANDIDATE",
          candidateText: "answer",
          modelTurn: {
            callId: "llm_1",
            model: { provider: "p", model: "m" },
            finishReason: "STOP",
            assistantMessage: { role: "assistant", content: [{ type: "text", text: "answer" }] },
          },
        },
      },
    });

    expect(draft.status).toBe("VERIFYING");
    expect(draft.continuation).toBe("AWAITING_VERIFICATION");
    expect(draft.stepSettlement).toBe("COMPLETED");
    // A final candidate is not a completion: the plan can produce VERIFYING and nothing further.
    expect(draft.status).not.toBe("COMPLETED");
    expect(JSON.stringify(draft.events)).not.toContain("run.completed");
  });

  it("opens a Tool boundary for requested tools", () => {
    const draft = plan({
      kind: "AGENT",
      mode: "START",
      outcome: {
        status: "DECIDED",
        decision: {
          type: "TOOL_CALLS_REQUESTED",
          toolRequests: [{ externalCallId: "c1", toolName: "read_file", args: {} }],
          modelTurn: {
            callId: "llm_1",
            model: { provider: "p", model: "m" },
            finishReason: "TOOL_CALLS",
            assistantMessage: {
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: {} }],
            },
          },
        },
      },
    });

    expect(draft.continuation).toBe("WAITING_TOOL_RESULTS");
    expect(draft.stepSettlement).toBe("COMPLETED");
    expect(draft.status).toBeUndefined();
  });

  it("settles a failed Step only when the provider was really attempted", () => {
    const modelFailure = plan({
      kind: "AGENT",
      mode: "START",
      outcome: {
        status: "FAILED",
        stage: "MODEL",
        error: { code: "MODEL_ERROR", message: "failed", retryable: true },
        retryable: true,
      },
    });
    expect(modelFailure.stepSettlement).toBe("FAILED");
    expect(modelFailure.status).toBeUndefined();

    const preBoundary = plan({
      kind: "AGENT",
      mode: "START",
      outcome: {
        status: "FAILED",
        stage: "BOUNDARY",
        error: { code: "INTERNAL_ERROR", message: "commit failed", retryable: false },
        retryable: false,
      },
    });
    // A failure before the durable boundary created no Step attempt, so nothing may be settled.
    expect(preBoundary.stepSettlement).toBeUndefined();
    expect(preBoundary.events).toEqual([]);
  });

  it("settles cancellation as cancelled rather than failed", () => {
    const draft = plan({ kind: "AGENT", mode: "START", outcome: { status: "CANCELLED" } });
    expect(draft.stepSettlement).toBe("CANCELLED");
    expect(draft.finalization).toEqual({ reason: "CANCELLED" });
  });

  it.each<[string, RunExecutionEffectResult, Partial<RunTransitionDraft>]>([
    [
      "TOOLS COMPLETED",
      { kind: "TOOLS", result: { kind: "COMPLETED" } },
      { continuation: "WAITING_TOOL_RESULTS" },
    ],
    [
      "TOOLS WAITING_APPROVAL",
      { kind: "TOOLS", result: { kind: "WAITING_APPROVAL" } },
      { status: "WAITING_APPROVAL", continuation: "WAITING_TOOL_RESULTS" },
    ],
    [
      "TOOLS RESOURCE_WAIT",
      { kind: "TOOLS", result: { kind: "RESOURCE_WAIT" } },
      { status: "WAITING_RESOURCE", continuation: "WAITING_RESOURCE" },
    ],
    [
      "TOOLS REPLAN",
      { kind: "TOOLS", result: { kind: "REPLAN" } },
      { continuation: "WAITING_TOOL_RESULTS" },
    ],
  ])("plans %s", (_label, effect, expected) => {
    expect(plan(effect)).toMatchObject(expected);
  });

  it("finalizes an exceeded Tool budget", () => {
    const draft = plan({
      kind: "TOOLS",
      result: {
        kind: "BUDGET_EXCEEDED",
        block: { kind: "EXCEEDED", dimension: "TOOL_CALLS", accounted: 9, limit: 8 },
      },
    });
    expect(draft.finalization).toEqual({
      reason: "BUDGET_EXCEEDED",
      block: { kind: "EXCEEDED", dimension: "TOOL_CALLS", accounted: 9, limit: 8 },
    });
  });

  it("completes only on ACCEPT and repairs on the same Run", () => {
    const accepted = plan({ kind: "COMPLETION", decision: { outcome: "ACCEPT" } });
    expect(accepted.status).toBe("COMPLETED");
    expect(accepted.continuation).toBeNull();

    const repair = plan({
      kind: "COMPLETION",
      decision: { outcome: "REPAIR", repairRef: "vplan_1", cycle: 1 },
    });
    expect(repair.continuation).toBe("WAITING_VERIFICATION_REPAIR");
    // A repair is a new loop epoch on the same Run, never a new Run.
    expect(repair.status).toBeUndefined();
    expect(repair.finalization).toBeUndefined();

    const rejected = plan({
      kind: "COMPLETION",
      decision: { outcome: "REJECT", reason: "checks failed" },
    });
    expect(rejected.finalization).toMatchObject({
      reason: "FAILED",
      error: { code: "VERIFICATION_FAILED" },
    });

    const errored = plan({
      kind: "COMPLETION",
      decision: {
        outcome: "ERROR",
        error: { code: "INTERNAL_ERROR", message: "gate unavailable", retryable: false },
      },
    });
    // An infrastructure error must leave the Run recoverable at its boundary.
    expect(errored.events).toEqual([]);
    expect(errored.status).toBeUndefined();
    expect(errored.finalization).toBeUndefined();
  });

  it("plans no write at all for a NONE effect", () => {
    expect(plan({ kind: "NONE", reason: "nothing happened" })).toEqual({ events: [] });
  });
});

describe("RunTransitionPlanner purity", () => {
  it("is deterministic for the same effect and now", () => {
    const effect: RunExecutionEffectResult = {
      kind: "AGENT",
      mode: "START",
      outcome: { status: "CANCELLED" },
    };
    const a = planRunTransition({ facts: facts(), effect, now: NOW });
    const b = planRunTransition({ facts: { ...facts() }, effect, now: NOW });
    expect(a).toEqual(b);
  });

  it("carries no storage row, service or database handle", () => {
    const draft = plan({
      kind: "COMPLETION",
      decision: { outcome: "ACCEPT" },
    });
    // The plan names only durable vocabulary: status, continuation, events, summary.
    expect(Object.keys(draft).sort()).toEqual([
      "clearActiveStep",
      "continuation",
      "events",
      "status",
      "summary",
    ]);
    expect(JSON.stringify(draft)).not.toMatch(/sqlite|DatabaseSync|drizzle|repository/i);
  });

  it("is reachable through the frozen interface", () => {
    const planner = createRunTransitionPlanner();
    const effect: RunExecutionEffectResult = { kind: "NONE", reason: "x" };
    expect(planner.plan({ facts: facts(), effect, now: NOW })).toEqual(
      planRunTransition({ facts: facts(), effect, now: NOW }),
    );
  });
});

describe("RunExecutionDirective routing facts", () => {
  it("rejects a Run status it cannot route instead of widening", () => {
    expect(toExecutionStatus("RUNNING")).toBe("RUNNING");
    expect(() => toExecutionStatus("NOT_A_STATUS" as never)).toThrow(
      /is not a frozen execution status/,
    );
  });

  it("routes a WAITING_APPROVAL Run to a suspension and never to a provider", () => {
    const directive = createRunExecutionCoordinator().next(
      facts({ status: "WAITING_APPROVAL", continuation: "WAITING_TOOL_RESULTS" }),
      NOW,
    );
    expect(directive).toEqual({ kind: "SUSPEND", reason: "APPROVAL" });
  });
});
