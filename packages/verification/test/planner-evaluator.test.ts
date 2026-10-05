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
  it("plans only task acceptance when the current Run changed no files", () => {
    const plan = new DefaultVerificationPlanner().plan(
      planningInput({ changedFiles: [], projectFacts: undefined }),
    );

    expect(plan.checks).toHaveLength(1);
    expect(plan.checks[0]).toMatchObject({
      ordinal: 0,
      stage: "ACCEPTANCE",
      requirement: "REQUIRED",
      spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
    });
  });

  it("limits a reliably classified change to its single package", () => {
    const plan = new DefaultVerificationPlanner().plan(
      planningInput({
        changedFiles: [{ path: "packages/core/src/run-controller.ts", changeType: "MODIFIED" }],
        projectFacts: {
          isCodeProject: true,
          isGitRepository: true,
          packageDirectories: [".", "packages/core", "packages/protocol"],
        },
      }),
    );

    expect(
      plan.checks.map((check) => [
        check.spec.kind,
        check.spec.purpose,
        check.spec.kind === "PROJECT" ? check.spec.packageRelativePath : undefined,
      ]),
    ).toEqual([
      ["PROJECT", "LINT", "packages/core"],
      ["PROJECT", "TYPECHECK", "packages/core"],
      ["PROJECT", "TEST", "packages/core"],
      ["PROJECT", "BUILD", "packages/core"],
      ["WORKSPACE", "CHANGESET_SANITY", undefined],
      ["GIT", "CHANGESET_REVIEW", undefined],
      ["TASK", "ACCEPTANCE", undefined],
    ]);
  });

  it("adds architecture and scoped package checks for cross-package and boundary changes", () => {
    const planner = new DefaultVerificationPlanner();
    const packages = [".", "packages/core", "packages/protocol"];
    const crossPackage = planner.plan(
      planningInput({
        changedFiles: [
          { path: "packages/core/src/run-controller.ts", changeType: "MODIFIED" },
          { path: "packages/protocol/src/events.ts", changeType: "MODIFIED" },
        ],
        projectFacts: {
          isCodeProject: true,
          isGitRepository: true,
          packageDirectories: packages,
        },
      }),
    );
    expect(crossPackage.checks[0]?.requirement).toBe("REQUIRED");
    expect(crossPackage.checks.map((check) => [check.spec.kind, check.spec.purpose])).toEqual([
      ["PROJECT", "ARCHITECTURE"],
      ["PROJECT", "LINT"],
      ["PROJECT", "TYPECHECK"],
      ["PROJECT", "TEST"],
      ["PROJECT", "BUILD"],
      ["PROJECT", "LINT"],
      ["PROJECT", "TYPECHECK"],
      ["PROJECT", "TEST"],
      ["PROJECT", "BUILD"],
      ["WORKSPACE", "CHANGESET_SANITY"],
      ["GIT", "CHANGESET_REVIEW"],
      ["TASK", "ACCEPTANCE"],
    ]);
    expect(
      crossPackage.checks
        .filter((check) => check.spec.kind === "PROJECT")
        .map((check) =>
          check.spec.kind === "PROJECT" ? check.spec.packageRelativePath : undefined,
        ),
    ).toEqual([
      undefined,
      "packages/core",
      "packages/core",
      "packages/core",
      "packages/core",
      "packages/protocol",
      "packages/protocol",
      "packages/protocol",
      "packages/protocol",
    ]);

    const boundary = planner.plan(
      planningInput({
        changedFiles: [{ path: "packages/protocol/src/events.ts", changeType: "MODIFIED" }],
        projectFacts: {
          isCodeProject: true,
          packageDirectories: packages,
        },
      }),
    );
    expect(boundary.checks[0]).toMatchObject({
      spec: { kind: "PROJECT", purpose: "ARCHITECTURE" },
    });
    expect(
      boundary.checks
        .filter((check) => check.spec.kind === "PROJECT")
        .some(
          (check) =>
            check.spec.kind === "PROJECT" && check.spec.packageRelativePath === "packages/protocol",
        ),
    ).toBe(true);
  });

  it("uses full checks for unknown impact and explicit full-verification requests", () => {
    const planner = new DefaultVerificationPlanner();
    const unknown = planner.plan(
      planningInput({
        changedFiles: [{ path: "src/unknown.ts", changeType: "MODIFIED" }],
        projectFacts: { isCodeProject: true, packageDirectories: ["packages/core"] },
      }),
    );
    expect(unknown.checks.map((check) => check.spec.kind)).toContain("PROJECT");
    expect(
      unknown.checks
        .filter((check) => check.spec.kind === "PROJECT")
        .every(
          (check) => check.spec.kind !== "PROJECT" || check.spec.packageRelativePath === undefined,
        ),
    ).toBe(true);

    const explicitlyFull = planner.plan(
      planningInput({
        goal: "Please run the full project verification suite.",
        changedFiles: [],
        projectFacts: {
          isCodeProject: true,
          isGitRepository: true,
          packageDirectories: [".", "packages/core"],
        },
      }),
    );
    expect(explicitlyFull.checks.map((check) => check.spec.kind)).toEqual([
      "PROJECT",
      "PROJECT",
      "PROJECT",
      "PROJECT",
      "PROJECT",
      "GIT",
      "TASK",
    ]);
    expect(
      explicitlyFull.checks
        .filter((check) => check.spec.kind === "PROJECT")
        .every(
          (check) => check.spec.kind !== "PROJECT" || check.spec.packageRelativePath === undefined,
        ),
    ).toBe(true);
  });

  it("keeps historical Runs without package-scope facts on conservative project checks", () => {
    const plan = new DefaultVerificationPlanner().plan(
      planningInput({
        projectFacts: { isCodeProject: true, isGitRepository: false },
      }),
    );

    expect(
      plan.checks
        .filter((check) => check.spec.kind === "PROJECT")
        .map((check) =>
          check.spec.kind === "PROJECT" ? [check.spec.purpose, check.spec.packageRelativePath] : [],
        ),
    ).toEqual([
      ["LINT", undefined],
      ["TYPECHECK", undefined],
      ["TEST", undefined],
      ["BUILD", undefined],
    ]);
  });

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
    const unknownChanges = planner.plan(planningInput({ projectFacts: undefined }));
    expect(unknownChanges.checks.map((check) => [check.spec.kind, check.spec.purpose])).toEqual([
      ["PROJECT", "LINT"],
      ["PROJECT", "TYPECHECK"],
      ["PROJECT", "TEST"],
      ["PROJECT", "BUILD"],
      ["WORKSPACE", "CHANGESET_SANITY"],
      ["GIT", "CHANGESET_REVIEW"],
      ["TASK", "ACCEPTANCE"],
    ]);

    const nonCode = planner.plan(
      planningInput({
        projectFacts: { isCodeProject: false, isGitRepository: false },
      }),
    );
    expect(nonCode.checks.map((check) => check.spec.kind)).toEqual(["WORKSPACE", "TASK"]);

    const notGit = planner.plan(
      planningInput({ projectFacts: { isCodeProject: true, isGitRepository: false } }),
    );
    expect(notGit.checks.map((check) => check.spec.kind)).toEqual([
      "PROJECT",
      "PROJECT",
      "PROJECT",
      "PROJECT",
      "WORKSPACE",
      "TASK",
    ]);

    const noChangesWithPositiveFacts = planner.plan(
      planningInput({
        projectFacts: { isCodeProject: true, isGitRepository: true },
        changedFiles: [],
      }),
    );
    expect(noChangesWithPositiveFacts.checks.map((check) => check.spec.kind)).toEqual(["TASK"]);
  });

  it("does not let random plan IDs or timestamps affect the canonical hash", () => {
    const planner = new DefaultVerificationPlanner();
    const first = planner.plan(planningInput());
    const second = planner.plan({ ...planningInput(), sourceStepId: first.sourceStepId });
    expect(second.planHash).toBe(first.planHash);
    expect(materialize(first, createTimestampMs(1_700_000_000_000)).planHash).toBe(first.planHash);
    expect(materialize(first, createTimestampMs(1_800_000_000_000)).planHash).toBe(first.planHash);

    const readOnlyInput = planningInput({ changedFiles: [], projectFacts: undefined });
    const readOnlyFirst = planner.plan(readOnlyInput);
    const readOnlySecond = planner.plan({
      ...readOnlyInput,
      sourceStepId: readOnlyFirst.sourceStepId,
    });
    expect(readOnlySecond.planHash).toBe(readOnlyFirst.planHash);
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

  it("prioritizes settled blockers over pending checks", () => {
    const plan = materialize(new DefaultVerificationPlanner().plan(planningInput()));
    const passedChecks = plan.checks.map((check) => ({ ...check, status: "PASSED" as const }));
    const passedPlan = { ...plan, checks: passedChecks };
    const passedEvidence = passedChecks.map((check) => evidence(passedPlan, check, { ok: true }));
    const pendingCheckId = passedChecks[1]?.id;
    const evidenceWithoutPending = passedEvidence.filter((item) => item.checkId !== pendingCheckId);
    const errorPendingChecks = passedChecks.map((check, index) =>
      index === 0
        ? { ...check, status: "ERROR" as const }
        : index === 1
          ? { ...check, status: "PENDING" as const }
          : check,
    );
    const errorPendingPlan = { ...plan, checks: errorPendingChecks };
    const failedPendingChecks = passedChecks.map((check, index) =>
      index === 0
        ? { ...check, status: "FAILED" as const }
        : index === 1
          ? { ...check, status: "PENDING" as const }
          : check,
    );
    const failedPendingPlan = { ...plan, checks: failedPendingChecks };
    const errorFailedChecks = passedChecks.map((check, index) =>
      index === 0
        ? { ...check, status: "ERROR" as const }
        : index === 1
          ? { ...check, status: "FAILED" as const }
          : check,
    );
    const errorFailedPlan = { ...plan, checks: errorFailedChecks };

    expect(evaluateVerification(errorPendingPlan, evidenceWithoutPending).status).toBe("ERROR");
    expect(evaluateVerification(failedPendingPlan, evidenceWithoutPending).status).toBe("FAILED");
    expect(evaluateVerification(errorFailedPlan, passedEvidence).status).toBe("ERROR");
    expect(
      evaluateVerification(
        {
          ...plan,
          checks: passedChecks.map((check, index) =>
            index === 1 ? { ...check, status: "PENDING" as const } : check,
          ),
        },
        evidenceWithoutPending,
      ).status,
    ).toBe("INCOMPLETE");
    expect(evaluateVerification(passedPlan, passedEvidence).status).toBe("PASSED");
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
