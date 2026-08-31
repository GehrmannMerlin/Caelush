import { createHash } from "node:crypto";
import {
  VerificationPlanDraftSchema,
  VerificationPlanningInputSchema,
  type VerificationCheckDraft,
  type VerificationPlanDraft,
  type VerificationPlanningInput,
} from "@caelush/protocol";

export const DEFAULT_VERIFICATION_PLANNER_VERSION = "phase-11a.v1";

type VerificationPlanHashInput = Pick<
  VerificationPlanDraft,
  "sourceStepId" | "plannerVersion" | "checks"
>;

function canonicalPlanContent(input: VerificationPlanHashInput): string {
  return JSON.stringify({
    sourceStepId: input.sourceStepId,
    plannerVersion: input.plannerVersion,
    checks: input.checks.map((check) => ({
      ordinal: check.ordinal,
      stage: check.stage,
      requirement: check.requirement,
      spec: check.spec,
    })),
  });
}

export function computeVerificationPlanHash(input: VerificationPlanHashInput): string {
  return createHash("sha256").update(canonicalPlanContent(input), "utf8").digest("hex");
}

function projectChecks(): VerificationCheckDraft[] {
  return [
    {
      ordinal: 0,
      stage: "FAST_STATIC",
      requirement: "IF_AVAILABLE",
      spec: { kind: "PROJECT", purpose: "LINT", source: "SYSTEM" },
    },
    {
      ordinal: 1,
      stage: "FAST_STATIC",
      requirement: "IF_AVAILABLE",
      spec: { kind: "PROJECT", purpose: "TYPECHECK", source: "SYSTEM" },
    },
    {
      ordinal: 2,
      stage: "BEHAVIORAL",
      requirement: "IF_AVAILABLE",
      spec: { kind: "PROJECT", purpose: "TEST", source: "SYSTEM" },
    },
    {
      ordinal: 3,
      stage: "BROAD",
      requirement: "IF_AVAILABLE",
      spec: { kind: "PROJECT", purpose: "BUILD", source: "SYSTEM" },
    },
  ];
}

export interface VerificationPlanner {
  plan(input: VerificationPlanningInput): VerificationPlanDraft;
}

export class DefaultVerificationPlanner implements VerificationPlanner {
  readonly plannerVersion: string;

  constructor(plannerVersion = DEFAULT_VERIFICATION_PLANNER_VERSION) {
    this.plannerVersion = plannerVersion;
  }

  plan(input: VerificationPlanningInput): VerificationPlanDraft {
    const planningInput = VerificationPlanningInputSchema.parse(input);
    const checks: VerificationCheckDraft[] = [];
    const facts = planningInput.projectFacts;

    if (facts?.isCodeProject !== false) {
      checks.push(...projectChecks());
    }
    if (planningInput.changedFiles.length > 0) {
      checks.push({
        ordinal: checks.length,
        stage: "CHANGE_REVIEW",
        requirement: "REQUIRED",
        spec: { kind: "WORKSPACE", purpose: "CHANGESET_SANITY", source: "SYSTEM" },
      });
    }
    if (facts?.isGitRepository !== false) {
      checks.push({
        ordinal: checks.length,
        stage: "CHANGE_REVIEW",
        requirement: facts?.isGitRepository === true ? "REQUIRED" : "IF_AVAILABLE",
        spec: { kind: "GIT", purpose: "CHANGESET_REVIEW", source: "SYSTEM" },
      });
    }
    checks.push({
      ordinal: checks.length,
      stage: "ACCEPTANCE",
      requirement: "REQUIRED",
      spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
    });

    const draft = {
      runId: planningInput.runId,
      sourceStepId: planningInput.sourceStepId,
      plannerVersion: this.plannerVersion,
      planHash: computeVerificationPlanHash({
        sourceStepId: planningInput.sourceStepId,
        plannerVersion: this.plannerVersion,
        checks,
      }),
      checks,
    };
    return VerificationPlanDraftSchema.parse(draft);
  }
}
