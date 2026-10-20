import {
  boundPlanBlock,
  deriveTaskPlanSnapshot,
  parseTaskPlanInput,
  renderPlanSteps,
  renderTaskPlanBlock,
  TASK_PLAN_LIMITS,
  validatePlanSteps,
} from "@caelush/coding-agent";
import { describe, expect, it } from "vitest";

/**
 * `update_plan` — the milestones the model maintains, the working record it keeps beside them, and the
 * read-only view derived from the accepted pair.
 *
 * The rules these pin:
 *
 * ```text
 * a plan is data in a Tool result        so it survives compaction, restart and context rebuild
 * a completed step is a report           never a completion, never a verification
 * an unaccepted call produces no plan    a rejected payload cannot become the current plan
 * v1 stays valid                         a historical payload keeps decoding exactly as it did
 * ```
 */

function assistantCall(callId: string, args: unknown): never {
  return {
    type: "ASSISTANT",
    runId: "run_1",
    id: `msg_${callId}`,
    content: [{ type: "TOOL_CALL", toolCallId: callId, toolName: "update_plan", input: args }],
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

const V1_PLAN = [
  { step: "backend health endpoint", status: "completed" },
  { step: "editor round-trip", status: "in_progress" },
  { step: "preview", status: "pending" },
];

describe("update_plan argument validation (v1)", () => {
  it("accepts a bounded linear plan with at most one active step", () => {
    const validated = validatePlanSteps(V1_PLAN);
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

describe("update_plan argument contract (v2)", () => {
  const v2 = {
    planVersion: 2 as const,
    explanation: "The schema is done; the editor is the current milestone.",
    plan: [
      {
        id: "schema",
        step: "schema",
        status: "completed" as const,
        acceptance: ["the migration applies on a fresh database"],
      },
      {
        id: "editor",
        step: "editor",
        status: "in_progress" as const,
        acceptance: ["an edit round-trips through the API"],
        evidenceRefs: ["msg_result_call_9"],
      },
    ],
    execution: {
      goal: "ship the editor slice",
      constraints: ["no schema changes after this point"],
      discoveries: ["the API rejects empty patches"],
      decisions: ["keep the current table"],
      unresolved: ["preview is not implemented"],
      nextAction: "wire the editor view to the round-trip endpoint",
    },
  };

  it("parses the full snapshot and keeps the ids stable", () => {
    const parsed = parseTaskPlanInput(v2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.planVersion).toBe(2);
    expect(parsed.plan.steps.map((step) => step.id)).toEqual(["schema", "editor"]);
    expect(parsed.plan.steps[1]?.evidenceRefs).toEqual(["msg_result_call_9"]);
    expect(parsed.plan.execution?.unresolved).toEqual(["preview is not implemented"]);
    expect(parsed.plan.execution?.nextAction).toContain("round-trip");
  });

  it("refuses v2-only fields without a version instead of guessing", () => {
    expect(
      parseTaskPlanInput({
        plan: [{ id: "a", step: "a", status: "pending" }],
      }),
    ).toMatchObject({ ok: false, reason: "PLAN_VERSION_REQUIRED" });
    expect(
      parseTaskPlanInput({
        plan: [{ step: "a", status: "pending" }],
        execution: { nextAction: "go" },
      }),
    ).toMatchObject({ ok: false, reason: "PLAN_VERSION_REQUIRED" });
    expect(
      parseTaskPlanInput({ planVersion: 3, plan: [{ step: "a", status: "pending" }] }),
    ).toMatchObject({ ok: false, reason: "PLAN_VERSION_UNSUPPORTED" });
  });

  it("requires a unique stable id on every v2 step", () => {
    expect(
      parseTaskPlanInput({
        planVersion: 2,
        plan: [{ step: "a", status: "pending" }],
      }),
    ).toMatchObject({ ok: false, reason: "STEP_ID_REQUIRED" });
    expect(
      parseTaskPlanInput({
        planVersion: 2,
        plan: [
          { id: "dup", step: "a", status: "pending" },
          { id: "dup", step: "b", status: "pending" },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "STEP_ID_DUPLICATE" });
  });

  it("bounds every field with a field-specific reason", () => {
    expect(
      parseTaskPlanInput({
        planVersion: 2,
        plan: [
          {
            id: "a",
            step: "a",
            status: "pending",
            acceptance: ["1", "2", "3", "4"],
          },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "ACCEPTANCE_TOO_MANY" });
    expect(
      parseTaskPlanInput({
        planVersion: 2,
        plan: [
          {
            id: "a",
            step: "a",
            status: "pending",
            evidenceRefs: Array.from({ length: 5 }, (_u, i) => `ref-${String(i)}`),
          },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "EVIDENCE_REFS_TOO_MANY" });
    expect(
      parseTaskPlanInput({
        planVersion: 2,
        explanation: "x".repeat(TASK_PLAN_LIMITS.maxExplanationChars + 1),
        plan: [{ id: "a", step: "a", status: "pending" }],
      }),
    ).toMatchObject({ ok: false, reason: "EXPLANATION_TOO_LONG" });
    expect(
      parseTaskPlanInput({
        planVersion: 2,
        plan: [{ id: "a", step: "a", status: "pending" }],
        execution: { unresolved: Array.from({ length: 9 }, () => "x") },
      }),
    ).toMatchObject({ ok: false, reason: "EXECUTION_LIST_TOO_LONG" });
  });

  it("bounds the whole payload in UTF-8 bytes, not characters", () => {
    // Chinese is three bytes per character, so a payload whose *character* count looks acceptable can
    // still be far over the byte budget. The limit has to be the one that constrains the request.
    const wide = "汉".repeat(TASK_PLAN_LIMITS.maxAcceptanceChars);
    const overLimit = parseTaskPlanInput({
      planVersion: 2,
      plan: Array.from({ length: 20 }, (_u, index) => ({
        id: `s${String(index)}`,
        step: "汉".repeat(TASK_PLAN_LIMITS.maxStepChars),
        status: "pending",
        acceptance: [wide, wide, wide],
        evidenceRefs: [wide, wide, wide, wide],
      })),
    });
    expect(overLimit).toMatchObject({ ok: false, reason: "PLAN_TOO_LARGE" });
  });

  it("allows a plan with no active step and no execution record", () => {
    const parsed = parseTaskPlanInput({
      planVersion: 2,
      plan: [{ id: "a", step: "a", status: "completed" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.execution).toBeUndefined();
  });
});

describe("task plan projection", () => {
  const plan = V1_PLAN;

  it("derives the last accepted plan only", () => {
    const snapshot = deriveTaskPlanSnapshot({
      runId: "run_1",
      messages: [
        { sequence: 1, message: assistantCall("call_1", { plan }) },
        { sequence: 2, message: toolResult("call_1", false) },
      ],
    });
    expect(snapshot?.steps).toHaveLength(2 + 1);
    expect(snapshot?.planVersion).toBe(1);
    expect(snapshot?.revision).toBe("msg_result_call_1");
    expect(snapshot?.resultsSincePlan).toBe(0);
  });

  it("counts work that happened after the plan without calling it evidence of completion", () => {
    const snapshot = deriveTaskPlanSnapshot({
      runId: "run_1",
      messages: [
        { sequence: 1, message: assistantCall("call_1", { plan }) },
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
    expect(block).toContain("not proof");
  });

  it("ignores a rejected call and a call with no result", () => {
    expect(
      deriveTaskPlanSnapshot({
        runId: "run_1",
        messages: [
          { sequence: 1, message: assistantCall("call_1", { plan }) },
          { sequence: 2, message: toolResult("call_1", true) },
        ],
      }),
    ).toBeUndefined();

    expect(
      deriveTaskPlanSnapshot({
        runId: "run_1",
        messages: [{ sequence: 1, message: assistantCall("call_1", { plan }) }],
      }),
    ).toBeUndefined();
  });

  it("prefers the newest accepted plan", () => {
    const snapshot = deriveTaskPlanSnapshot({
      runId: "run_1",
      messages: [
        { sequence: 1, message: assistantCall("call_1", { plan }) },
        { sequence: 2, message: toolResult("call_1", false) },
        {
          sequence: 3,
          message: assistantCall("call_2", {
            plan: [
              { step: "one", status: "in_progress" },
              { step: "two", status: "pending" },
              { step: "three", status: "pending" },
            ],
          }),
        },
        { sequence: 4, message: toolResult("call_2", false) },
      ],
    });
    expect(snapshot?.steps).toHaveLength(3);
    expect(snapshot?.revision).toBe("msg_result_call_2");
  });

  it("keeps a v1 plan readable after a v2 plan existed", () => {
    // A Run may accept a v2 plan and later a v1 one; the latest accepted snapshot wins and its own
    // version is reported, because the reader must not infer a shape from the Run's history.
    const snapshot = deriveTaskPlanSnapshot({
      runId: "run_1",
      messages: [
        {
          sequence: 1,
          message: assistantCall("call_1", {
            planVersion: 2,
            plan: [{ id: "a", step: "a", status: "in_progress" }],
          }),
        },
        { sequence: 2, message: toolResult("call_1", false) },
        { sequence: 3, message: assistantCall("call_2", { plan }) },
        { sequence: 4, message: toolResult("call_2", false) },
      ],
    });
    expect(snapshot?.planVersion).toBe(1);
    expect(snapshot?.steps).toHaveLength(3);
  });

  it("renders a block that says a completed step is a report, not proof", () => {
    const block = renderTaskPlanBlock({
      revision: "r",
      planVersion: 1,
      resultsSincePlan: 0,
      steps: [
        { step: "schema", status: "completed" },
        { step: "editor", status: "in_progress" },
      ],
    });
    expect(block).toContain("CURRENT PLAN v1");
    expect(block).toContain("[x] schema");
    expect(block).toContain("[>] editor");
    expect(block).toContain("1 of 2 steps reported completed");
    expect(block).toContain("not proof");
    expect(block).toContain("Independent evidence: UNVERIFIED");
  });

  it("renders unresolved failures and the next action, and marks claimed evidence as unverified", () => {
    const block = renderTaskPlanBlock({
      revision: "r",
      planVersion: 2,
      resultsSincePlan: 3,
      explanation: "the endpoint rejected empty patches",
      execution: {
        goal: "ship the editor",
        unresolved: ["preview missing"],
        nextAction: "fix the patch validator",
      },
      steps: [
        {
          id: "editor",
          step: "editor",
          status: "in_progress",
          acceptance: ["an edit round-trips"],
          evidenceRefs: ["msg_1"],
        },
      ],
    });
    expect(block).toContain("Why it changed: the endpoint rejected empty patches");
    expect(block).toContain("UNRESOLVED (must not be reported as done): preview missing");
    expect(block).toContain("Next action: fix the patch validator");
    expect(block).toContain("claimed evidence: msg_1 — unverified");
    expect(block).toContain("accept: an edit round-trips");
  });

  it("bounds the rendered block in bytes without splitting a character", () => {
    const block = renderTaskPlanBlock({
      revision: "r",
      planVersion: 1,
      resultsSincePlan: 0,
      steps: Array.from({ length: 20 }, (_u, index) => ({
        step: `${String(index)} ${"汉".repeat(60)}`,
        status: "pending" as const,
      })),
    });
    const bounded = boundPlanBlock(block, 512);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(512);
    expect(bounded).toContain("[plan truncated");
    // No replacement character and no broken sequence: decoding the bytes yields what we produced.
    expect(Buffer.from(bounded, "utf8").toString("utf8")).toBe(bounded);
    expect(bounded).not.toContain("\uFFFD");
  });

  it("leaves a block that already fits untouched", () => {
    expect(boundPlanBlock("short", 512)).toBe("short");
  });
});
