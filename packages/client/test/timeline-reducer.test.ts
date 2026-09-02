import {
  createApprovalRequestId,
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
  createVerificationCheckId,
  createVerificationPlanId,
  type AgentEvent,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { createInitialTimelineState } from "../src/timeline/model.js";
import { flushTimelineForTerminal, reduceTimelineEvent } from "../src/timeline/reducer.js";

const runId = createRunId();
const sessionId = createSessionId();
const stepId = createStepId();
const invocationId = createToolInvocationId();
const observationId = createObservationId();

describe("shared Timeline reducer", () => {
  it("counts completed verification outcomes and replaces a check without double-counting", () => {
    const planId = createVerificationPlanId();
    let state = createInitialTimelineState(runId, { limits: { maxActiveEntries: 1 } });
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 1, { planId, checkCount: 3 }),
    );
    for (const [sequence, status] of [
      [2, "PASSED"],
      [3, "FAILED"],
      [4, "ERROR"],
    ] as const) {
      state = reduceTimelineEvent(
        state,
        eventOf("verification.check.completed", sequence, {
          planId,
          checkId: createVerificationCheckId(),
          status,
          evidenceIds: [],
        }),
      );
    }
    expect(state.verification[0]).toMatchObject({ passed: 1, failed: 1, errors: 1 });
    const checkId = createVerificationCheckId();
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 5, {
        planId,
        checkId,
        status: "PASSED",
        evidenceIds: [],
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 6, {
        planId,
        checkId,
        status: "ERROR",
        evidenceIds: [],
      }),
    );
    expect(state.verification[0]).toMatchObject({ passed: 1, failed: 1, errors: 2 });
  });

  it("keeps verification replacement accounting after a visible check is evicted", () => {
    const planId = createVerificationPlanId();
    const checkA = createVerificationCheckId();
    const checkB = createVerificationCheckId();
    let state = createInitialTimelineState(runId, { limits: { maxActiveEntries: 1 } });
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 1, { planId, checkCount: 2 }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 2, {
        planId,
        checkId: checkA,
        status: "PASSED",
        evidenceIds: [],
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 3, {
        planId,
        checkId: checkB,
        status: "PASSED",
        evidenceIds: [],
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 4, {
        planId,
        checkId: checkA,
        status: "ERROR",
        evidenceIds: [],
      }),
    );
    expect(state.verification[0]).toMatchObject({ passed: 1, failed: 0, errors: 1 });
  });

  it("fails closed when an evicted outcome identity reappears", () => {
    const planId = createVerificationPlanId();
    const checkA = createVerificationCheckId();
    const checkB = createVerificationCheckId();
    let state = createInitialTimelineState(runId, {
      limits: { maxSeenEvents: 1, maxActiveEntries: 1 },
    });
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 1, { planId, checkCount: 2 }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 2, {
        planId,
        checkId: checkA,
        status: "PASSED",
        evidenceIds: [],
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 3, {
        planId,
        checkId: checkB,
        status: "PASSED",
        evidenceIds: [],
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 4, {
        planId,
        checkId: checkA,
        status: "ERROR",
        evidenceIds: [],
      }),
    );
    expect(state.error).toBe("Verification outcome history could not be verified.");
  });

  it("preserves planned total when a verification plan is evicted", () => {
    const planA = createVerificationPlanId();
    const planB = createVerificationPlanId();
    let state = createInitialTimelineState(runId, { limits: { maxActiveEntries: 1 } });
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 1, { planId: planA, checkCount: 3 }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 2, { planId: planB, checkCount: 1 }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.finalized", 3, {
        planId: planA,
        outcome: "PASSED",
        failedCheckIds: [],
        errorCheckIds: [],
      }),
    );
    expect(state.settled.at(-1)?.counts?.total).toBe(3);
  });

  it("fails closed when finalized plan metadata has also been evicted", () => {
    const planA = createVerificationPlanId();
    const planB = createVerificationPlanId();
    let state = createInitialTimelineState(runId, { limits: { maxSeenEvents: 1 } });
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 1, { planId: planA, checkCount: 3 }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 2, { planId: planB, checkCount: 1 }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.finalized", 3, {
        planId: planA,
        outcome: "PASSED",
        failedCheckIds: [],
        errorCheckIds: [],
      }),
    );
    expect(state.error).toBe("Verification plan history could not be verified.");
    expect(
      state.settled.some((entry) => entry.planId === planA && entry.status === "FINALIZED"),
    ).toBe(false);
  });

  it("bounds and sanitizes public strings across projection domains", () => {
    const bad = "\u001b[31m" + "x".repeat(200) + "\u001b[0m";
    let state = createInitialTimelineState(runId, { limits: { maxTextBytes: 32 } });
    state = reduceTimelineEvent(
      state,
      eventOf(
        "tool.requested",
        1,
        { invocationId, toolName: "read_file", riskLevel: "LOW" },
        { title: bad, summary: bad },
      ),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("plan.updated", 2, {
        plan: [{ id: "plan-item", title: bad, status: "IN_PROGRESS" }],
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("approval.requested", 3, {
        approval: {
          id: createApprovalRequestId(),
          runId,
          toolInvocationId: invocationId,
          riskLevel: "CRITICAL",
          title: bad,
          reason: bad,
          action: { toolName: "read_file" },
          status: "PENDING",
          scope: bad,
          createdAt: 1,
        },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("retry.scheduled", 4, { attempt: 1, maxAttempts: 2, delayMs: 1, errorCode: bad }),
    );
    for (const value of [
      ...state.activeTools,
      ...state.activeApprovals,
      ...state.currentPlan,
      ...state.retries,
    ]) {
      for (const field of ["title", "text", "detail", "reason", "scope"] as const) {
        const text = (value as Record<string, unknown>)[field];
        if (typeof text === "string") {
          expect(text).not.toContain("\u001b");
          expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(32);
        }
      }
    }
  });
  it("retains safe legacy CLI verification fields", () => {
    const planId = createVerificationPlanId();
    const checkId = createVerificationCheckId();
    let state = createInitialTimelineState(runId);
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 1, { planId, checkCount: 1 }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.started", 2, { planId, checkId, ordinal: 0, purpose: "Check" }),
    );
    expect(state.verification[0]).toMatchObject({
      planId,
      checkCount: 1,
      passed: 0,
      failed: 0,
      errors: 0,
    });
    expect(state.verification[0]?.checks[0]).toMatchObject({ checkId, title: "Check" });
  });
  it("accepts visible events and ignores other Runs and visibility", () => {
    const initial = createInitialTimelineState(runId);
    const visible = eventOf("reasoning.summary", 1, { summary: "检查认证代码" });
    const hidden = { ...visible, visibility: "DEBUG" as const };
    const otherRun = { ...visible, runId: createRunId() };

    const projected = reduceTimelineEvent(initial, visible);
    expect(projected.settled[0]?.text).toBe("检查认证代码");
    expect(reduceTimelineEvent(projected, hidden)).toBe(projected);
    expect(reduceTimelineEvent(projected, otherRun)).toBe(projected);
  });

  it("ignores exact replay and fails closed on sequence conflict", () => {
    const event = eventOf("reasoning.summary", 1, { summary: "same" });
    const projected = reduceTimelineEvent(createInitialTimelineState(runId), event);
    expect(reduceTimelineEvent(projected, event)).toBe(projected);

    const conflict = reduceTimelineEvent(
      projected,
      eventOf("reasoning.summary", 1, { summary: "different" }),
    );
    expect(conflict.error).toBe("Timeline event order could not be verified.");
  });

  it("bounds retained activity after 1000 durable events", () => {
    let state = createInitialTimelineState(runId, {
      limits: { maxSettledEntries: 3, maxActiveEntries: 2, maxSeenEvents: 4 },
    });
    for (let sequence = 1; sequence <= 1000; sequence += 1) {
      state = reduceTimelineEvent(
        state,
        eventOf("reasoning.summary", sequence, { summary: "event-" + sequence }),
      );
    }
    expect(state.settled.length).toBeLessThanOrEqual(3);
    expect(state.seenEvents.length).toBeLessThanOrEqual(4);
  });

  it("aggregates Tool lifecycle and file activity", () => {
    let state = createInitialTimelineState(runId);
    state = reduceTimelineEvent(
      state,
      eventOf("tool.requested", 1, {
        invocationId,
        toolName: "read_file",
        riskLevel: "LOW",
      }),
    );
    state = reduceTimelineEvent(state, eventOf("tool.started", 2, { invocationId }));
    state = reduceTimelineEvent(state, eventOf("file.read", 3, { path: "src/auth.ts" }));
    state = reduceTimelineEvent(
      state,
      eventOf("tool.completed", 4, { invocationId, observationId }),
    );

    expect(state.activeTools).toEqual([]);
    expect(state.settled).toHaveLength(1);
    expect(state.settled[0]).toMatchObject({
      kind: "TOOL",
      toolName: "read_file",
      status: "COMPLETED",
    });
    expect(JSON.stringify(state)).not.toContain("args");
  });

  it("projects verification progress and final outcome from payload labels", () => {
    let state = createInitialTimelineState(runId);
    const planId = createVerificationPlanId();
    const checkId = createVerificationCheckId();
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 1, {
        planId,
        sourceStepId: stepId,
        checkCount: 1,
        plannerVersion: "test-planner",
        counts: { required: 1, ifAvailable: 0, advisory: 0 },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.started", 2, {
        planId,
        checkId,
        ordinal: 0,
        kind: "TASK",
        purpose: "ACCEPTANCE",
        stage: "ACCEPTANCE",
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 3, {
        planId,
        checkId,
        status: "PASSED",
        evidenceIds: [],
        durationMs: 12,
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.finalized", 4, {
        planId,
        outcome: "PASSED",
        failedCheckIds: [],
        errorCheckIds: [],
      }),
    );

    expect(state.settled.at(-1)).toMatchObject({ kind: "VERIFICATION", status: "FINALIZED" });
    expect(JSON.stringify(state)).not.toContain("evidenceIds");
  });

  it("retains safe verification counts and check labels without source arrays", () => {
    let state = createInitialTimelineState(runId);
    const planId = createVerificationPlanId();
    const checkId = createVerificationCheckId();
    state = reduceTimelineEvent(
      state,
      eventOf("verification.planned", 1, {
        planId,
        sourceStepId: stepId,
        checkCount: 3,
        plannerVersion: "test-planner",
        counts: { required: 1, ifAvailable: 1, advisory: 1 },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.started", 2, {
        planId,
        checkId,
        ordinal: 0,
        kind: "TASK",
        purpose: "ACCEPTANCE",
        stage: "ACCEPTANCE",
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("verification.check.completed", 3, {
        planId,
        checkId,
        status: "PASSED",
        evidenceIds: ["forbidden-evidence-id"],
        durationMs: 12,
      }),
    );
    expect(state.verification[0]).toMatchObject({
      plannedCounts: { required: 1, ifAvailable: 1, advisory: 1 },
      checks: [{ label: "TASK · ACCEPTANCE · ACCEPTANCE", detail: "12ms" }],
    });
    state = reduceTimelineEvent(
      state,
      eventOf("verification.finalized", 4, {
        planId,
        outcome: "FAILED",
        failedCheckIds: ["forbidden-failed-check-id"],
        errorCheckIds: ["forbidden-error-check-id"],
      }),
    );
    expect(state.settled.at(-1)).toMatchObject({ counts: { total: 3, failed: 1, error: 1 } });
    expect(JSON.stringify(state)).not.toContain("forbidden-evidence-id");
    expect(JSON.stringify(state)).not.toContain("forbidden-failed-check-id");
    expect(JSON.stringify(state)).not.toContain("forbidden-error-check-id");
    expect(state.settled.at(-1)).not.toHaveProperty("failedCheckIds");
    expect(state.settled.at(-1)).not.toHaveProperty("errorCheckIds");
  });

  it("settles LLM activity with public model identity and aggregate usage", () => {
    let state = reduceTimelineEvent(
      createInitialTimelineState(runId),
      eventOf("llm.started", 1, {
        model: { provider: "openai", model: "gpt-test" },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("llm.completed", 2, {
        model: { provider: "openai", model: "gpt-test" },
        usage: { steps: 1, toolCalls: 0, inputTokens: 12, outputTokens: 4, totalCostMicros: 0 },
      }),
    );
    expect(state.activeLlm).toEqual([]);
    expect(state.settled.at(-1)).toMatchObject({ kind: "LLM", status: "COMPLETED" });
  });

  it("keys simultaneous LLM activity by Step and model", () => {
    let state = reduceTimelineEvent(
      createInitialTimelineState(runId),
      eventOf("llm.started", 1, {
        model: { provider: "openai", model: "gpt-test" },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("llm.started", 2, {
        model: { provider: "anthropic", model: "claude-test" },
      }),
    );
    expect(state.activeLlm).toHaveLength(2);
  });

  it("settles Tool failures with a sanitized error", () => {
    let state = reduceTimelineEvent(
      createInitialTimelineState(runId),
      eventOf("tool.requested", 1, {
        invocationId,
        toolName: "read_file",
        riskLevel: "LOW",
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("tool.failed", 2, {
        invocationId,
        error: { code: "TOOL_FAILURE", message: "secret arguments", retryable: false },
      }),
    );
    expect(state.settled.at(-1)).toMatchObject({ kind: "TOOL", status: "FAILED" });
    expect(JSON.stringify(state)).not.toContain("secret arguments");
  });

  it("projects shell exit codes and signals without output", () => {
    let state = toolForShell();
    state = reduceTimelineEvent(
      state,
      eventOf("shell.started", 2, { invocationId, command: "pnpm test" }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("shell.output", 3, { invocationId, stream: "stdout", chunk: "SECRET_OUTPUT" }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("shell.completed", 4, { invocationId, exitCode: 2 }),
    );
    expect(state.settled.at(-1)?.text).toContain("code 2");
    expect(JSON.stringify(state)).not.toContain("SECRET_OUTPUT");

    state = toolForShell();
    state = reduceTimelineEvent(
      state,
      eventOf("shell.completed", 2, { invocationId, signal: "SIGTERM" }),
    );
    expect(state.settled.at(-1)?.text).toContain("SIGTERM");
  });

  it("projects process start and stop without output", () => {
    let state = reduceTimelineEvent(
      createInitialTimelineState(runId),
      eventOf("process.started", 1, {
        process: { id: "process-1", command: "Run server", status: "RUNNING" },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("process.output", 2, {
        processId: "process-1",
        stream: "stderr",
        chunk: "SECRET_OUTPUT",
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("process.stopped", 3, { processId: "process-1", status: "EXITED" }),
    );
    expect(state.activeProcesses).toEqual([]);
    expect(state.settled.at(-1)).toMatchObject({ kind: "PROCESS", status: "COMPLETED" });
    expect(JSON.stringify(state)).not.toContain("SECRET_OUTPUT");
  });

  it("deduplicates adjacent reasoning summaries", () => {
    let state = reduceTimelineEvent(
      createInitialTimelineState(runId),
      eventOf("reasoning.summary", 1, { summary: "same" }),
    );
    state = reduceTimelineEvent(state, eventOf("reasoning.summary", 2, { summary: "same" }));
    expect(state.settled).toHaveLength(1);
  });

  it("upserts retry attempts by Step and attempt", () => {
    let state = reduceTimelineEvent(
      createInitialTimelineState(runId),
      eventOf("retry.scheduled", 1, {
        attempt: 1,
        maxAttempts: 2,
        delayMs: 10,
        nextAttemptAt: 20,
        errorCode: "LLM_TIMEOUT",
      }),
    );
    state = reduceTimelineEvent(state, eventOf("retry.started", 2, { attempt: 1, maxAttempts: 2 }));
    expect(state.retries).toEqual([expect.objectContaining({ attempt: 1, status: "RUNNING" })]);
  });

  it("retains approval read-only presentation data", () => {
    const approvalId = createApprovalRequestId();
    const state = reduceTimelineEvent(
      createInitialTimelineState(runId),
      eventOf("approval.requested", 1, {
        approval: {
          id: approvalId,
          runId,
          toolInvocationId: invocationId,
          riskLevel: "HIGH",
          title: "Need approval",
          reason: "Write a file",
          action: { command: "SECRET_COMMAND" },
          status: "PENDING",
          scope: "ONCE",
          createdAt: 1,
        },
      }),
    );
    expect(state.activeApprovals[0]).toMatchObject({ kind: "APPROVAL", title: "Need approval" });
    expect(JSON.stringify(state)).not.toContain("SECRET_COMMAND");
  });

  it("projects sanitized errors and budget exceedance", () => {
    let state = reduceTimelineEvent(
      createInitialTimelineState(runId),
      eventOf("error", 1, {
        error: { code: "MODEL_FAILURE", message: "secret prompt", retryable: false },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("budget.exceeded", 2, {
        dimension: "TOKENS",
        limit: 10,
        accounted: 11,
      }),
    );
    expect(state.settled.map((entry) => entry.kind)).toEqual(["SYSTEM", "SYSTEM"]);
    expect(JSON.stringify(state)).not.toContain("secret prompt");
  });

  it.each([
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ] as const)("flushes all active activity for %s", (status) => {
    let state = toolForShell();
    state = reduceTimelineEvent(
      state,
      eventOf("llm.started", 2, { model: { provider: "openai", model: "gpt-test" } }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("process.started", 3, {
        process: { id: "process-1", command: "Run server", status: "RUNNING" },
      }),
    );
    state = reduceTimelineEvent(
      state,
      eventOf("retry.scheduled", 4, {
        attempt: 1,
        maxAttempts: 2,
        delayMs: 10,
        nextAttemptAt: 20,
        errorCode: "LLM_TIMEOUT",
      }),
    );
    const flushed = flushTimelineForTerminal(state, status);
    expect(flushed.activeTools).toEqual([]);
    expect(flushed.activeLlm).toEqual([]);
    expect(flushed.activeProcesses).toEqual([]);
    expect(flushed.activeApprovals).toEqual([]);
    expect(flushed.retries).toEqual([]);
    expect(flushed.verification).toEqual([]);
  });

  it("interrupts settled verification repair activity on terminal flush", () => {
    let state = reduceTimelineEvent(
      createInitialTimelineState(runId),
      eventOf("verification.repair.started", 1, {
        failedPlanId: createVerificationPlanId(),
        failedCheckIds: [createVerificationCheckId()],
        repairCycle: 1,
      }),
    );
    state = flushTimelineForTerminal(state, "FAILED");
    expect(state.settled).toEqual([
      expect.objectContaining({ kind: "VERIFICATION", status: "INTERRUPTED" }),
    ]);
    expect(state.settled.some((entry) => entry.status === "RUNNING")).toBe(false);
  });

  it("keeps the omission marker within maxSettledEntries of one", () => {
    let state = createInitialTimelineState(runId, { limits: { maxSettledEntries: 1 } });
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      state = reduceTimelineEvent(
        state,
        eventOf("reasoning.summary", sequence, { summary: `event-${sequence}` }),
      );
      expect(state.settled.length).toBeLessThanOrEqual(1);
    }
    expect(state.settled[0]).toMatchObject({ id: "timeline:omitted", status: "SKIPPED" });
  });
});

function toolForShell() {
  return reduceTimelineEvent(
    createInitialTimelineState(runId),
    eventOf("tool.requested", 1, {
      invocationId,
      toolName: "exec_command",
      riskLevel: "HIGH",
    }),
  );
}

function eventOf(
  type: AgentEvent["type"],
  sequence: number,
  payload: unknown,
  overrides: Partial<AgentEvent> = {},
): AgentEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    type,
    runId,
    sessionId,
    stepId,
    timestamp: sequence,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence },
    payload,
    ...overrides,
  } as AgentEvent;
}
