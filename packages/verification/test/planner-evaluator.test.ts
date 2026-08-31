import {
  createRunId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type JsonObject,
  type VerificationCheck,
  type VerificationPlan,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  DefaultVerificationPlanner,
  computeVerificationPlanHash,
  evaluateVerification,
} from "../src/index.js";

const workspace = { id: "wsp_0190c1f0-7f14-7a9e-9b1b-0d2a8f1c4e55" as never, path: "C:/workspace" };

function planningInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: createRunId(),
    sourceStepId: createStepId(),
    goal: "Add a safe verification boundary",
    workspace,
    changedFiles: [
      { path: "packages/core/src/run-controller.ts", changeType: "MODIFIED" as const },
    ],
    projectFacts: { isCodeProject: true, isGitRepository: true },
    ...overrides,
  };
}

function materialize(
  draft: ReturnType<DefaultVerificationPlanner["plan"]>,
  now = createTimestampMs(1_700_000_000_000),
): VerificationPlan {
  const planId = createVerificationPlanId();
  const checks: VerificationCheck[] = draft.checks.map((draftCheck) => ({
    ...draftCheck,
    id: createVerificationCheckId(),
    planId,
    status: "PENDING",
    createdAt: now,
  }));
  return { ...draft, id: planId, checks, createdAt: now };
}

function evidence(plan: VerificationPlan, check: VerificationCheck, details: JsonObject = {}) {
  return {
    id: createVerificationEvidenceId(),
    planId: plan.id,
    checkId: check.id,
    kind: "DISCOVERY" as const,
    summary: "Evidence",
    details,
    capturedAt: createTimestampMs(1_700_000_000_001),
  };
}

describe("Phase 11A verification planner", () => {
  it("creates a deterministic, command-free default plan from explicit facts", () => {
    const input = planningInput();
    const draft = new DefaultVerificationPlanner().plan(input);

    expect(
      draft.checks.map((check) => [check.spec.kind, check.spec.purpose, check.requirement]),
    ).toEqual([
      ["PROJECT", "LINT", "IF_AVAILABLE"],
      ["PROJECT", "TYPECHECK", "IF_AVAILABLE"],
      ["PROJECT", "TEST", "IF_AVAILABLE"],
      ["PROJECT", "BUILD", "IF_AVAILABLE"],
      ["WORKSPACE", "CHANGESET_SANITY", "REQUIRED"],
      ["GIT", "CHANGESET_REVIEW", "REQUIRED"],
      ["TASK", "ACCEPTANCE", "REQUIRED"],
    ]);
    expect(draft.checks.every((check) => !Object.hasOwn(check, "command"))).toBe(true);
    expect(draft.planHash).toBe(
      computeVerificationPlanHash({
        sourceStepId: input.sourceStepId,
        plannerVersion: draft.plannerVersion,
        checks: draft.checks,
      }),
    );
  });

  it("uses conservative unknown facts and omits checks known to be unavailable", () => {
    const planner = new DefaultVerificationPlanner();
    const unknown = planner.plan(planningInput({ projectFacts: undefined, changedFiles: [] }));
    expect(unknown.checks).toHaveLength(6);
    expect(unknown.checks.at(-1)?.spec.kind).toBe("TASK");

    const nonCode = planner.plan(
      planningInput({
        projectFacts: { isCodeProject: false, isGitRepository: false },
        changedFiles: [],
      }),
    );
    expect(nonCode.checks.map((check) => check.spec.kind)).toEqual(["TASK"]);
  });

  it("does not let random plan IDs or timestamps affect the canonical hash", () => {
    const planner = new DefaultVerificationPlanner();
    const first = planner.plan(planningInput());
    const second = planner.plan({ ...planningInput(), sourceStepId: first.sourceStepId });
    expect(second.planHash).toBe(first.planHash);
    expect(materialize(first, createTimestampMs(1_700_000_000_000)).planHash).toBe(first.planHash);
    expect(materialize(first, createTimestampMs(1_800_000_000_000)).planHash).toBe(first.planHash);
  });
});

describe("Phase 11A verification evaluator", () => {
  it("keeps zero checks and missing evidence incomplete", () => {
    const planner = new DefaultVerificationPlanner();
    const empty = materialize({
      runId: createRunId(),
      sourceStepId: createStepId(),
      plannerVersion: "phase-11a.v1",
      planHash: "a".repeat(64),
      checks: [],
    });
    expect(evaluateVerification(empty, []).status).toBe("INCOMPLETE");

    const plan = materialize(planner.plan(planningInput()));
    expect(evaluateVerification(plan, []).status).toBe("INCOMPLETE");
  });

  it("distinguishes blocking failure, infrastructure error, unavailable skip, and advisory warning", () => {
    const plan = materialize(new DefaultVerificationPlanner().plan(planningInput()));
    const checks = plan.checks.map((check) => ({ ...check, status: "PASSED" as const }));
    const completePlan = { ...plan, checks };
    const baseEvidence = checks.map((check) => evidence(completePlan, check, { ok: true }));

    expect(
      evaluateVerification(
        {
          ...completePlan,
          checks: checks.map((check, index) =>
            index === 4 ? { ...check, status: "FAILED" as const } : check,
          ),
        },
        baseEvidence,
      ).status,
    ).toBe("FAILED");
    expect(
      evaluateVerification(
        {
          ...completePlan,
          checks: checks.map((check, index) =>
            index === 4 ? { ...check, status: "ERROR" as const } : check,
          ),
        },
        baseEvidence,
      ).status,
    ).toBe("ERROR");

    const skipped = checks.map((check, index) =>
      index === 0
        ? { ...check, status: "SKIPPED" as const, skipReason: "NOT_AVAILABLE" as const }
        : check,
    );
    const skippedPlan = { ...completePlan, checks: skipped };
    expect(
      evaluateVerification(skippedPlan, [
        ...baseEvidence.filter((item) => item.checkId !== skipped[0]?.id),
        evidence(skippedPlan, skipped[0]!, { available: false, reason: "NOT_AVAILABLE" }),
      ]).status,
    ).toBe("PASSED");

    const advisory = checks.map((check, index) =>
      index === 0
        ? { ...check, requirement: "ADVISORY" as const, status: "FAILED" as const }
        : check,
    );
    const advisoryResult = evaluateVerification(
      { ...completePlan, checks: advisory },
      baseEvidence,
    );
    expect(advisoryResult.status).toBe("PASSED");
    expect(advisoryResult.warnings).toHaveLength(1);
  });
});
