import { createHash } from "node:crypto";
import {
  VerificationCompletionSealSchema,
  VerificationEvidenceSchema,
  type VerificationCompletionSeal,
  type VerificationEvidence,
  type VerificationPlan,
} from "@caelush/protocol";

export interface VerificationCompletionSealInput {
  readonly runId: VerificationCompletionSeal["runId"];
  readonly planId: VerificationCompletionSeal["planId"];
  readonly sourceStepId: VerificationCompletionSeal["sourceStepId"];
  readonly planHash: string;
  readonly candidateHash: string;
  readonly evidenceDigest: string;
  readonly workspaceFreshnessHash: string;
  readonly gitFreshnessHash?: string;
}

export function computeVerificationCandidateTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function computeVerificationEvidenceDigest(
  plan: VerificationPlan,
  evidence: readonly VerificationEvidence[],
): string {
  const checks = [...plan.checks]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .map((check) => ({
      id: check.id,
      planId: check.planId,
      ordinal: check.ordinal,
      stage: check.stage,
      requirement: check.requirement,
      spec: check.spec,
      status: check.status,
      createdAt: check.createdAt,
      ...(check.startedAt === undefined ? {} : { startedAt: check.startedAt }),
      ...(check.finishedAt === undefined ? {} : { finishedAt: check.finishedAt }),
      ...(check.skipReason === undefined ? {} : { skipReason: check.skipReason }),
    }));
  const checkIds = new Set(plan.checks.map((check) => check.id));
  const canonicalEvidence = evidence
    .map((item) => VerificationEvidenceSchema.parse(item))
    .sort(
      (left, right) =>
        left.checkId.localeCompare(right.checkId) ||
        left.capturedAt - right.capturedAt ||
        left.id.localeCompare(right.id),
    )
    .map((item) => {
      if (item.planId !== plan.id || !checkIds.has(item.checkId)) {
        throw new Error("Verification evidence does not belong to the current plan.");
      }
      return item;
    });
  return sha256(JSON.stringify({ planId: plan.id, checks, evidence: canonicalEvidence }));
}

export function createVerificationCompletionSeal(
  input: VerificationCompletionSealInput,
): VerificationCompletionSeal {
  const unsigned = {
    runId: input.runId,
    planId: input.planId,
    sourceStepId: input.sourceStepId,
    planHash: input.planHash,
    candidateHash: input.candidateHash,
    evidenceDigest: input.evidenceDigest,
    workspaceFreshnessHash: input.workspaceFreshnessHash,
    ...(input.gitFreshnessHash === undefined ? {} : { gitFreshnessHash: input.gitFreshnessHash }),
  };
  return VerificationCompletionSealSchema.parse({
    ...unsigned,
    sealHash: sha256(JSON.stringify(unsigned)),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
