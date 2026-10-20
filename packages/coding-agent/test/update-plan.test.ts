import {
  deriveTaskPlanSnapshot,
  renderTaskPlanBlock,
  renderPlanSteps,
  validatePlanSteps,
} from "@caelush/coding-agent";
import { describe, expect, it } from "vitest";

/**
 * `update_plan` — the checklist the model maintains, and the read-only view derived from it.
 *
 * The rules these pin: a plan is data in a Tool result (so it survives compaction and restart), a
 * completed step is a *report* and never a completion, and an unaccepted call produces no plan.
 */

function assistantCall(callId: string, plan: unknown): never {
  return {
    type: "ASSISTANT",
    runId: "run_1",
    id: `msg_${callId}`,
    content: [{ type: "TOOL_CALL", toolCallId: callId, toolName: "update_plan", input: { plan } }],
  } as never;
}

function toolResult(callId: string, isError: boolean): never {
  return {
    type: "TOOL_RESULT",
    runId: "run_1",
    id: `msg_result_${callId}`,
    toolCallId: callId,
    toolName: "update_plan",
    isError,
  } as never;
}

describe("update_plan argument validation", () => {
  it("accepts a bounded linear plan with at most one active step", () => {
    const validated = validatePlanSteps([
      { step: "backend health endpoint", status: "completed" },
      { step: "editor round-trip", status: "in_progress" },
      { step: "preview", status: "pending" },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.steps).toHaveLength(3);
    expect(renderPlanSteps(validated.steps)).toBe(
      "[x] backend health endpoint\n[>] editor round-trip\n[ ] preview",
    );
  });

  it("refuses shapes a checklist cannot honestly represent", () => {
    expect(validatePlanSteps([])).toMatchObject({ ok: false, reason: "PLAN_EMPTY" });
    expect(validatePlanSteps("nope")).toMatchObject({ ok: false, reason: "PLAN_NOT_A_LIST" });
    expect(
      validatePlanSteps([
        { step: "a", status: "in_progress" },
        { step: "b", status: "in_progress" },
      ]),
    ).toMatchObject({ ok: false, reason: "MULTIPLE_IN_PROGRESS" });
    expect(validatePlanSteps([{ step: "a", status: "done" }])).toMatchObject({
      ok: false,
      reason: "STEP_STATUS_INVALID",
    });
    expect(
      validatePlanSteps(
        Array.from({ length: 21 }, (_u, i) => ({ step: `s${i}`, status: "pending" })),
      ),
    ).toMatchObject({ ok: false, reason: "PLAN_TOO_LONG" });
  });
});

describe("task plan projection", () => {
  const plan = [
    { step: "schema", status: "completed" },
    { step: "editor", status: "in_progress" },
  ];

  it("derives the last accepted plan only", () => {
    const snapshot = deriveTaskPlanSnapshot({
      runId: "run_1",
      messages: [
        { sequence: 1, message: assistantCall("call_1", plan) },
        { sequence: 2, message: toolResult("call_1", false) },
      ],
    });
    expect(snapshot?.steps).toHaveLength(2);
    expect(snapshot?.revision).toBe("msg_result_call_1");
    expect(snapshot?.resultsSincePlan).toBe(0);
  });

  it("counts work that happened after the plan without calling it evidence of completion", () => {
    const snapshot = deriveTaskPlanSnapshot({
      runId: "run_1",
      messages: [
        { sequence: 1, message: assistantCall("call_1", plan) },
        { sequence: 2, message: toolResult("call_1", false) },
        {
          sequence: 3,
          message: {
            type: "TOOL_RESULT",
            runId: "run_1",
            id: "m3",
            toolName: "apply_patch",
            isError: false,
          } as never,
        },
        {
          sequence: 4,
          message: {
            type: "TOOL_RESULT",
            runId: "run_1",
            id: "m4",
            toolName: "apply_patch",
            isError: true,
          } as never,
        },
      ],
    });
    expect(snapshot?.resultsSincePlan).toBe(1);
    const block = renderTaskPlanBlock(snapshot!);
    expect(block).toContain("1 successful Tool result(s) accepted");
    expect(block).toContain("not a verification");
  });

  it("ignores a rejected call and a call with no result", () => {
    expect(
      deriveTaskPlanSnapshot({
        runId: "run_1",
        messages: [
          { sequence: 1, message: assistantCall("call_1", plan) },
          { sequence: 2, message: toolResult("call_1", true) },
        ],
      }),
    ).toBeUndefined();

    expect(
      deriveTaskPlanSnapshot({
        runId: "run_1",
        messages: [{ sequence: 1, message: assistantCall("call_1", plan) }],
      }),
    ).toBeUndefined();
  });

  it("prefers the newest accepted plan", () => {
    const snapshot = deriveTaskPlanSnapshot({
      runId: "run_1",
      messages: [
        { sequence: 1, message: assistantCall("call_1", plan) },
        { sequence: 2, message: toolResult("call_1", false) },
        {
          sequence: 3,
          message: assistantCall("call_2", [
            { step: "one", status: "in_progress" },
            { step: "two", status: "pending" },
            { step: "three", status: "pending" },
          ]),
        },
        { sequence: 4, message: toolResult("call_2", false) },
      ],
    });
    expect(snapshot?.steps).toHaveLength(3);
    expect(snapshot?.revision).toBe("msg_result_call_2");
  });

  it("renders a block that says a completed step is a report, not proof", () => {
    const block = renderTaskPlanBlock({
      revision: "r",
      steps: [
        { step: "schema", status: "completed" },
        { step: "editor", status: "in_progress" },
      ],
    });
    expect(block).toContain("1. [x] schema");
    expect(block).toContain("2. [>] editor");
    expect(block).toContain("1 of 2 steps reported completed");
    expect(block).toContain("not proof");
  });
});
