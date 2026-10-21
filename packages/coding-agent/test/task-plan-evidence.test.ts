import { describe, expect, it } from "vitest";
import { projectProcessOutcome } from "../src/tools/operations/process-outcome.js";
import {
  aggregateTaskPlanEvidenceState,
  resolveTaskPlanEvidence,
  type ResolvedTaskPlanEvidence,
  type TaskPlanEvidenceFact,
  type TaskPlanEvidenceState,
} from "../src/tools/plan/task-plan-evidence.js";
import {
  renderBoundedTaskPlan,
  type TaskPlanSnapshot,
} from "../src/tools/plan/task-plan-projection.js";

const identity = { sessionId: "session-current", runId: "run-current" };

function fact(overrides: Partial<TaskPlanEvidenceFact> = {}): TaskPlanEvidenceFact {
  return {
    reference: "observation:obs-1",
    kind: "OBSERVATION",
    sessionId: identity.sessionId,
    runId: identity.runId,
    sourceStepId: "step-1",
    sourceCallId: "call-1",
    observedAt: 10,
    outcome: "EXITED_NONZERO",
    dependenciesKnown: false,
    ...overrides,
  };
}

describe("task plan evidence", () => {
  it("treats a completed invocation with exit code 2 as a known failure", () => {
    expect(projectProcessOutcome({ status: "EXITED", exitCode: 2 })).toEqual({
      kind: "EXITED_NONZERO",
      exitCode: 2,
    });
    expect(
      resolveTaskPlanEvidence({
        identity,
        refs: ["observation:obs-1"],
        facts: [fact()],
      }),
    ).toEqual([{ reference: "observation:obs-1", kind: "OBSERVATION", state: "FAILED" }]);
  });

  it("keeps a running preview service unknown and incomplete output incomplete", () => {
    expect(projectProcessOutcome({ status: "RUNNING", sessionId: "proc-1" })).toEqual({
      kind: "RUNNING",
    });
    const resolved = resolveTaskPlanEvidence({
      identity,
      refs: ["observation:obs-running", "observation:obs-truncated"],
      facts: [
        fact({ reference: "observation:obs-running", outcome: "RUNNING" }),
        fact({ reference: "observation:obs-truncated", outcome: "EXITED_OK", truncated: true }),
      ],
    });
    expect(resolved.map((item) => item.state)).toEqual(["UNKNOWN", "INCOMPLETE"]);
  });

  it("rejects missing and cross-Run or cross-Session evidence references", () => {
    const resolved = resolveTaskPlanEvidence({
      identity,
      refs: [
        "observation:missing",
        "observation:foreign-run",
        "observation:foreign-session",
        "bad reference",
      ],
      facts: [
        fact({ reference: "observation:foreign-run", runId: "run-other", outcome: "CHECK_PASSED" }),
        fact({
          reference: "observation:foreign-session",
          sessionId: "session-other",
          outcome: "EXITED_OK",
        }),
      ],
    });
    expect(resolved.map((item) => item.state)).toEqual([
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
    ]);
  });

  it("marks passed verification stale after a matching dependency changes", () => {
    const resolved = resolveTaskPlanEvidence({
      identity,
      refs: ["verification:check-1", "verification:check-2", "verification:check-3"],
      facts: [
        fact({
          reference: "verification:check-1",
          kind: "VERIFICATION",
          outcome: "CHECK_PASSED",
          dependenciesKnown: true,
          dependencies: ["packages/app/src"],
          laterMutations: [{ at: 20, path: "packages/app/src/main.ts" }],
        }),
        fact({
          reference: "verification:check-2",
          kind: "VERIFICATION",
          outcome: "CHECK_PASSED",
          dependenciesKnown: true,
          dependencies: ["packages/app/src"],
          laterMutations: [{ at: 20, path: "packages/other/README.md" }],
        }),
        fact({
          reference: "verification:check-3",
          kind: "VERIFICATION",
          outcome: "CHECK_PASSED",
          dependenciesKnown: false,
          mutationWatermark: 20,
        }),
      ],
    });
    expect(resolved.map((item) => item.state)).toEqual(["STALE", "PASSED", "STALE"]);
  });

  it("keeps the model's reported status separate from independent evidence state", () => {
    const refs = ["verification:failed", "observation:successful-shell"];
    const resolved = resolveTaskPlanEvidence({
      identity,
      refs,
      facts: [
        fact({
          reference: "verification:failed",
          kind: "VERIFICATION",
          outcome: "CHECK_FAILED",
        }),
        fact({ reference: "observation:successful-shell", outcome: "EXITED_OK" }),
      ],
    });
    const stateByReference = new Map(resolved.map((item) => [item.reference, item.state]));
    expect(aggregateTaskPlanEvidenceState(refs, stateByReference)).toBe("FAILED");
    expect(aggregateTaskPlanEvidenceState(["observation:successful-shell"], stateByReference)).toBe(
      "UNVERIFIED",
    );
  });
});

/**
 * What the rendered plan says about evidence.
 *
 * ```text
 * step line     recorded references, the model's reportedStatus, the resolved state
 * summary       per-step counts, which cover only the checks the steps cite
 * footer        never claims "nothing passed" beside a step whose evidence did pass
 * ```
 *
 * The plan is a report. Rendering a resolved PASSED reference and then closing with a fixed sentence
 * that no check has passed is not a cautious summary — it is a contradiction, and the model reading it
 * cannot tell which half is true.
 */
const PLAN_REVISION = "plan-result-1";

function planWith(steps: TaskPlanSnapshot["steps"]): TaskPlanSnapshot {
  return {
    revision: PLAN_REVISION,
    sourceStepId: "step-plan",
    planVersion: 2,
    steps,
    execution: {
      goal: "finish the reliability fix",
      unresolved: ["the failure path is still unproven"],
      nextAction: "run the acceptance suite",
    },
    resultsSincePlan: 2,
  };
}

function renderWith(
  steps: TaskPlanSnapshot["steps"],
  evidence: readonly ResolvedTaskPlanEvidence[],
): string {
  return renderBoundedTaskPlan(planWith(steps), { evidence }).text;
}

interface EvidenceCase {
  readonly state: TaskPlanEvidenceState;
  readonly overrides: Partial<TaskPlanEvidenceFact>;
}

function resolvedFor(
  reference: string,
  overrides: Partial<TaskPlanEvidenceFact> = {},
): readonly ResolvedTaskPlanEvidence[] {
  return resolveTaskPlanEvidence({
    identity,
    refs: [reference],
    facts: [fact({ reference, ...overrides })],
  });
}

describe("rendered plan evidence", () => {
  it("does not deny a check that it just rendered as PASSED", () => {
    const verification = "verification:check-passed";
    const text = renderWith(
      [
        {
          id: "check",
          step: "run the unit suite",
          status: "completed",
          acceptance: ["tests pass"],
          evidenceRefs: [verification],
        },
        { id: "report", step: "report the result", status: "in_progress" },
      ],
      resolvedFor(verification, {
        kind: "VERIFICATION",
        outcome: "CHECK_PASSED",
        dependenciesKnown: false,
      }),
    );

    expect(text).toContain("independentEvidence=PASSED");
    // The contradiction this replaces: a resolved pass beside a fixed "nothing passed" footer.
    expect(text).not.toContain("no check has been shown to pass");
    expect(text).toMatch(/PASSED 1/u);
    // Coverage, not a completion verdict.
    expect(text).toContain("不构成全部需求完成");
  });

  it.each<EvidenceCase>([
    { state: "FAILED", overrides: { kind: "VERIFICATION", outcome: "CHECK_FAILED" } },
    {
      state: "STALE",
      overrides: { kind: "VERIFICATION", outcome: "CHECK_PASSED", superseded: true },
    },
    { state: "INCOMPLETE", overrides: { kind: "VERIFICATION", outcome: "CHECK_INCOMPLETE" } },
    { state: "UNKNOWN", overrides: { kind: "VERIFICATION", outcome: "CHECK_RUNNING" } },
    { state: "UNVERIFIED", overrides: { kind: "MESSAGE", outcome: "UNVERIFIED" } },
  ])("reports $state as $state and never as a pass", ({ state, overrides }) => {
    const reference = overrides.kind === "MESSAGE" ? "message:msg-applied" : "verification:check-1";
    const text = renderWith(
      [
        {
          id: "check",
          step: "run the unit suite",
          status: "completed",
          evidenceRefs: [reference],
        },
      ],
      resolveTaskPlanEvidence({
        identity,
        refs: [reference],
        facts: [fact({ reference, ...overrides })],
      }),
    );

    expect(text).toContain(`independentEvidence=${state}`);
    expect(text).toMatch(new RegExp(`${state} 1`, "u"));
    if (state !== "PASSED") {
      expect(text).not.toContain("independentEvidence=PASSED");
    }
  });

  it("does not upgrade a plan whose steps cite no checks into a passed one", () => {
    const text = renderWith(
      [
        { id: "build", step: "build the package", status: "completed" },
        { id: "ship", step: "ship it", status: "completed" },
      ],
      [],
    );

    expect(text).toContain("independentEvidence=UNVERIFIED");
    expect(text).not.toContain("independentEvidence=PASSED");
    expect(text).toMatch(/PASSED 0/u);
    expect(text).toContain("计划未记录检查引用");
  });

  it("counts steps, not references, so repeating one reference cannot look like more evidence", () => {
    const shared = "verification:check-shared";
    const evidence = resolvedFor(shared, {
      kind: "VERIFICATION",
      outcome: "CHECK_PASSED",
      dependenciesKnown: false,
    });
    const text = renderWith(
      [
        { id: "a", step: "first claim", status: "completed", evidenceRefs: [shared, shared] },
        { id: "b", step: "second claim", status: "completed", evidenceRefs: [shared] },
      ],
      evidence,
    );

    expect(text).toMatch(/PASSED 2/u);
    // One distinct reference: once for each step that cites it, once in the evidence list.
    expect(text.split(shared).length - 1).toBe(3);
  });
});
