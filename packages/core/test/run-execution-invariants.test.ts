import { describe, expect, it } from "vitest";
import {
  createRunExecutionCoordinator,
  nextRunExecutionDirective,
  RUN_EXECUTION_DIRECTIVE_KINDS,
} from "@caelush/agent";
import type { RunExecutionSnapshot } from "@caelush/agent";
import { toAgentExecutionSnapshot, toExecutionStatus } from "../src/run-execution-facts.js";
import { evaluateAgentStepGate } from "../src/agent-step-gate.js";
import { createInitialAgentState, startAgentState } from "../src/agent-state.js";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createWorkspaceId,
  type AgentRun,
  type AgentState,
} from "@caelush/protocol";

/**
 * Phase 3C invariants that must hold across the whole refactor.
 *
 * The properties here are the ones a lifecycle extraction can quietly break:
 *
 * ```text
 * maxSteps is a Run Layer gate, and the AgentLoop must not know about it
 * the routing vocabulary is closed, and Core projects onto it rather than inventing one
 * a state the coordinator cannot route never reaches a provider
 * ```
 */

const NOW = createTimestampMs(1_000);

function run(maxSteps: number): AgentRun {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal: "prove the step gate",
    status: "RUNNING",
    workspace: { id: createWorkspaceId(), path: "/repo" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "fixture" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps, maxToolCalls: 10, timeoutMs: 10_000 },
    createdAt: createTimestampMs(0),
    startedAt: createTimestampMs(0),
  });
}

function scheduled(run: AgentRun, steps: number): AgentState {
  const pending = AgentRunSchema.parse({ ...run, status: "PENDING", startedAt: undefined });
  const started = startAgentState(
    createInitialAgentState(pending, createTimestampMs(0)),
    createTimestampMs(0),
  );
  return { ...started, usage: { ...started.usage, steps } };
}

/** The canonical snapshot the coordinator routes on. */
function snapshot(overrides: Partial<RunExecutionSnapshot> = {}): RunExecutionSnapshot {
  const agentRun = overrides.run ?? run(3);
  return {
    run: agentRun,
    state: overrides.state ?? scheduled(agentRun, 0),
    conversation: [],
    ...overrides,
  };
}

describe("the step budget is a Run Layer concern", () => {
  it("admits the first turn of a fresh Run", () => {
    const pending = AgentRunSchema.parse({
      ...run(3),
      status: "PENDING",
      startedAt: undefined,
    });
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
    const pending = AgentRunSchema.parse({ ...run(2), status: "PENDING", startedAt: undefined });
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
    const agentRun = run(2);
    expect(
      nextRunExecutionDirective(snapshot({ run: agentRun, state: scheduled(agentRun, 2) }), NOW),
    ).toEqual({ kind: "FINALIZE", reason: "MAX_STEPS_REACHED" });
  });
});

describe("the durable boundary precedes provider I/O", () => {
  it("never returns a work directive for a settled Run", () => {
    const coordinator = createRunExecutionCoordinator();
    for (const status of [
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "MAX_STEPS_REACHED",
      "BUDGET_EXCEEDED",
    ] as const) {
      const directive = coordinator.next(
        snapshot({ run: AgentRunSchema.parse({ ...run(3), status }) }),
        NOW,
      );
      expect(RUN_EXECUTION_DIRECTIVE_KINDS).toContain(directive.kind);
      expect(directive.kind).not.toBe("ADVANCE_AGENT");
      expect(directive.kind).not.toBe("EXECUTE_TOOL_BATCH");
      expect(directive.kind).not.toBe("EVALUATE_COMPLETION");
    }
  });

  it("produces a finalization for every terminal authority", () => {
    const agentRun = run(1);
    expect(
      nextRunExecutionDirective(
        snapshot({
          run: agentRun,
          state: scheduled(agentRun, 0),
          cancellationIntent: {
            runId: agentRun.id,
            cause: "USER_REQUESTED",
            requestedAt: createTimestampMs(0),
          },
        }),
        NOW,
      ),
    ).toEqual({ kind: "FINALIZE", reason: "CANCELLED" });

    const expiring = AgentRunSchema.parse({
      ...run(3),
      limits: { maxSteps: 3, maxToolCalls: 10, timeoutMs: 1 },
    });
    expect(nextRunExecutionDirective(snapshot({ run: expiring }), NOW)).toEqual({
      kind: "FINALIZE",
      reason: "TIMEOUT",
    });

    const spent = run(1);
    expect(
      nextRunExecutionDirective(snapshot({ run: spent, state: scheduled(spent, 1) }), NOW),
    ).toEqual({ kind: "FINALIZE", reason: "MAX_STEPS_REACHED" });
  });

  it("refuses to route a stale active Step instead of advancing past it", () => {
    const agentRun = run(3);
    expect(() =>
      nextRunExecutionDirective(
        snapshot({
          run: agentRun,
          activeStep: {
            id: createStepId(),
            runId: agentRun.id,
            sequence: 1,
            status: "RUNNING",
            startedAt: createTimestampMs(0),
          },
        }),
        NOW,
      ),
    ).toThrow(/active Step/);
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

  it("projects the Run Layer's durable record onto the canonical snapshot", () => {
    const agentRun = run(3);
    const projected = toAgentExecutionSnapshot({
      run: agentRun,
      state: scheduled(agentRun, 0),
      conversation: [
        {
          runId: agentRun.id,
          sequence: 1,
          sourceStepId: createStepId(),
          createdAt: createTimestampMs(0),
          message: { role: "user", content: "hello" },
        },
      ],
    });
    expect(projected.run).toBe(agentRun);
    expect(projected.conversation).toHaveLength(1);
    // The legacy durable encoding is projected, not leaked: the canonical domain is AIMessage.
    expect(projected.conversation[0]?.message).toEqual({ role: "user", content: "hello" });
  });
});
