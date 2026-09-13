import { describe, expect, it } from "vitest";
import {
  createRunExecutionCoordinator,
  nextRunExecutionDirective,
  RUN_EXECUTION_DIRECTIVE_KINDS,
} from "@caelush/agent";
import type { RunExecutionFacts, RunExecutionDirective } from "@caelush/agent";
import { toExecutionStatus } from "../src/run-execution-facts.js";
import { evaluateAgentStepGate } from "../src/agent-step-gate.js";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
} from "@caelush/protocol";

/**
 * Phase 3C invariants that must hold across the whole refactor.
 *
 * The two properties here are the ones a lifecycle extraction can quietly break:
 *
 * ```text
 * maxSteps is a Run Layer gate, and the AgentLoop must not know about it
 * a durable commit failure must cost zero provider calls
 * ```
 */

function run(maxSteps: number) {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "prove the step gate",
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps, maxToolCalls: 10, timeoutMs: 1_000 },
    createdAt: createTimestampMs(0),
  });
}

describe("the step budget is a Run Layer concern", () => {
  it("admits the first turn of a fresh Run", () => {
    const pending = run(3);
    const state = startAgentState(
      createInitialAgentState(pending, createTimestampMs(0)),
      createTimestampMs(0),
    );
    expect(evaluateAgentStepGate(state, pending.limits)).toEqual({
      allowed: true,
      nextSequence: 1,
    });
  });

  it("refuses the next turn exactly when the budget is spent", () => {
    const pending = run(2);
    let state = startAgentState(
      createInitialAgentState(pending, createTimestampMs(0)),
      createTimestampMs(0),
    );
    // Two settled attempts, which is what the budget counts.
    state = { ...state, usage: { ...state.usage, steps: 2 } };
    expect(evaluateAgentStepGate(state, pending.limits)).toEqual({
      allowed: false,
      outcome: { type: "MAX_STEPS_REACHED", stepsCompleted: 2, maxSteps: 2 },
    });
  });

  it("is the coordinator, not the loop, that settles an exhausted budget", () => {
    const facts: RunExecutionFacts = {
      runId: "run_1",
      status: "RUNNING",
      stepsCompleted: 2,
      maxSteps: 2,
    };
    expect(nextRunExecutionDirective(facts, 0)).toEqual({
      kind: "FINALIZE",
      finalization: { reason: "MAX_STEPS_REACHED", stepsCompleted: 2, maxSteps: 2 },
    });
  });
});

describe("the durable boundary precedes provider I/O", () => {
  /**
   * The frozen order is:
   *
   * ```text
   * context -> admission -> durable boundary -> model turn
   * ```
   *
   * The coordinator is what decides *whether* execution continues at all, and a Run whose state
   * cannot be routed must never reach a provider. The directive for every unroutable state is a
   * terminal report or a finalization, never an advance.
   */
  it("never returns an advance directive for an unroutable state", () => {
    const unroutable: readonly RunExecutionFacts[] = [
      { runId: "r", status: "COMPLETED" },
      { runId: "r", status: "FAILED" },
      { runId: "r", status: "CANCELLED" },
      { runId: "r", status: "TIMEOUT" },
      { runId: "r", status: "MAX_STEPS_REACHED" },
      { runId: "r", status: "BUDGET_EXCEEDED" },
      { runId: "r", status: "RUNNING", cancellationRequested: true },
      { runId: "r", status: "RUNNING", deadlineExceeded: true },
      { runId: "r", status: "RUNNING", activeStep: true },
      { runId: "r", status: "RUNNING", aborted: true },
      { runId: "r", status: "RUNNING", stepsCompleted: 5, maxSteps: 5 },
    ];

    const coordinator = createRunExecutionCoordinator();
    for (const facts of unroutable) {
      const directive: RunExecutionDirective = coordinator.next(facts, 0);
      expect(RUN_EXECUTION_DIRECTIVE_KINDS).toContain(directive.kind);
      expect(directive.kind).not.toBe("ADVANCE_AGENT");
      expect(directive.kind).not.toBe("EXECUTE_TOOL_BATCH");
      expect(directive.kind).not.toBe("EVALUATE_COMPLETION");
    }
  });

  it("produces a finalization for every terminal authority", () => {
    expect(
      nextRunExecutionDirective({ runId: "r", status: "RUNNING", cancellationRequested: true }, 0),
    ).toEqual({ kind: "FINALIZE", finalization: { reason: "CANCELLED" } });
    expect(
      nextRunExecutionDirective({ runId: "r", status: "RUNNING", deadlineExceeded: true }, 0),
    ).toEqual({ kind: "FINALIZE", finalization: { reason: "TIMEOUT" } });
    expect(
      nextRunExecutionDirective(
        { runId: "r", status: "RUNNING", stepsCompleted: 1, maxSteps: 1 },
        0,
      ),
    ).toEqual({
      kind: "FINALIZE",
      finalization: { reason: "MAX_STEPS_REACHED", stepsCompleted: 1, maxSteps: 1 },
    });
  });
});

describe("the routing vocabulary stays closed", () => {
  it("has exactly the six frozen discriminants", () => {
    expect(RUN_EXECUTION_DIRECTIVE_KINDS).toEqual([
      "ADVANCE_AGENT",
      "EXECUTE_TOOL_BATCH",
      "EVALUATE_COMPLETION",
      "SUSPEND",
      "FINALIZE",
      "RETURN_TERMINAL",
    ]);
  });

  it("maps every durable Run status onto a routable execution status", () => {
    for (const status of [
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
    ] as const) {
      expect(toExecutionStatus(status)).toBe(status);
    }
  });
});
