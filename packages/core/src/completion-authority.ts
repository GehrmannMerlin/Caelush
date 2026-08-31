import {
  VerifiedRunFinalResultSchema,
  VerificationCompletionSealSchema,
  type AgentRun,
  type VerificationPlan,
} from "@caelush/protocol";
import type { RunContinuationCheckpoint } from "./agent-continuation.js";

export type CompletionFreshness = "FRESH" | "STALE" | "UNPROVABLE";
export type CompletionGitFreshness = CompletionFreshness | "SKIPPED";

export interface CompletionAuthorityInput {
  readonly run: AgentRun;
  readonly plan: VerificationPlan;
  readonly continuation: Extract<RunContinuationCheckpoint, { type: "AWAITING_VERIFICATION" }>;
  readonly verificationStatus: "PASSED" | "FAILED" | "ERROR" | "INCOMPLETE";
  readonly candidateHash: string;
  readonly workspaceFreshness: CompletionFreshness;
  readonly gitFreshness: CompletionGitFreshness;
  readonly cancellationRequested: boolean;
}

export type CompletionAuthorityDecision =
  | { readonly kind: "COMPLETE" }
  | {
      readonly kind: "DEFER";
      readonly reason:
        | "RUN_NOT_VERIFYING"
        | "CONTINUATION_MISMATCH"
        | "PLAN_MISMATCH"
        | "CANDIDATE_HASH_MISSING"
        | "CANDIDATE_HASH_MISMATCH"
        | "VERIFICATION_NOT_PASSED"
        | "WORKSPACE_NOT_FRESH"
        | "GIT_NOT_FRESH"
        | "CANCELLATION_REQUESTED";
    };

export function evaluateCompletionAuthority(
  input: CompletionAuthorityInput,
): CompletionAuthorityDecision {
  if (input.cancellationRequested) return { kind: "DEFER", reason: "CANCELLATION_REQUESTED" };
  if (input.run.status !== "VERIFYING") return { kind: "DEFER", reason: "RUN_NOT_VERIFYING" };
  if (
    input.continuation.runId !== input.run.id ||
    input.continuation.verificationPlanId !== input.plan.id ||
    input.continuation.sourceStepId !== input.plan.sourceStepId
  )
    return { kind: "DEFER", reason: "CONTINUATION_MISMATCH" };
  if (
    input.plan.runId !== input.run.id ||
    input.plan.sourceStepId !== input.continuation.sourceStepId
  )
    return { kind: "DEFER", reason: "PLAN_MISMATCH" };
  if (input.plan.candidateHash === undefined)
    return { kind: "DEFER", reason: "CANDIDATE_HASH_MISSING" };
  if (input.plan.candidateHash !== input.candidateHash)
    return { kind: "DEFER", reason: "CANDIDATE_HASH_MISMATCH" };
  if (input.verificationStatus !== "PASSED")
    return { kind: "DEFER", reason: "VERIFICATION_NOT_PASSED" };
  if (input.workspaceFreshness !== "FRESH") return { kind: "DEFER", reason: "WORKSPACE_NOT_FRESH" };
  if (input.gitFreshness !== "FRESH" && input.gitFreshness !== "SKIPPED")
    return { kind: "DEFER", reason: "GIT_NOT_FRESH" };
  return { kind: "COMPLETE" };
}

export function createVerifiedRunFinalResult(input: {
  readonly run: AgentRun;
  readonly plan: VerificationPlan;
  readonly continuation: Extract<RunContinuationCheckpoint, { type: "AWAITING_VERIFICATION" }>;
  readonly candidateHash: string;
  readonly seal: unknown;
  readonly counts: {
    readonly total: number;
    readonly passed: number;
    readonly skipped: number;
    readonly advisoryWarnings: number;
  };
}) {
  const seal = VerificationCompletionSealSchema.parse(input.seal);
  if (input.run.id !== seal.runId || input.plan.id !== seal.planId)
    throw new Error("verified completion seal identity mismatch");
  if (input.plan.sourceStepId !== seal.sourceStepId || input.plan.planHash !== seal.planHash)
    throw new Error("verified completion seal plan mismatch");
  if (
    input.candidateHash !== seal.candidateHash ||
    input.plan.candidateHash !== input.candidateHash
  )
    throw new Error("verified completion candidate hash mismatch");
  return VerifiedRunFinalResultSchema.parse({
    type: "VERIFIED_COMPLETION",
    text: input.continuation.finalDecision.candidateText,
    verification: {
      planId: input.plan.id,
      sourceStepId: input.plan.sourceStepId,
      planHash: input.plan.planHash,
      candidateHash: input.candidateHash,
      evidenceDigest: seal.evidenceDigest,
      freshnessHash: seal.workspaceFreshnessHash,
      sealHash: seal.sealHash,
      checks: input.counts,
    },
  });
}
