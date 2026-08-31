import type { VerificationCheck, VerificationEvidence, VerificationPlan } from "@caelush/protocol";

export type VerificationEvaluationStatus = "INCOMPLETE" | "FAILED" | "ERROR" | "PASSED";

export interface VerificationEvaluation {
  readonly status: VerificationEvaluationStatus;
  readonly incompleteCheckIds: readonly VerificationCheck["id"][];
  readonly failedCheckIds: readonly VerificationCheck["id"][];
  readonly errorCheckIds: readonly VerificationCheck["id"][];
  readonly warnings: readonly string[];
}

function hasTrustworthyUnavailableEvidence(
  check: VerificationCheck,
  evidence: readonly VerificationEvidence[],
): boolean {
  return evidence.some((item) => {
    if (item.checkId !== check.id || item.kind !== "DISCOVERY" || item.details === undefined) {
      return false;
    }
    if (typeof item.details !== "object" || item.details === null || Array.isArray(item.details)) {
      return false;
    }
    const details = item.details as Record<string, unknown>;
    return (
      details.available === false &&
      (details.reason === check.skipReason || typeof details.unavailableReason === "string")
    );
  });
}

function hasEvidence(check: VerificationCheck, evidence: readonly VerificationEvidence[]): boolean {
  return evidence.some((item) => item.checkId === check.id);
}

export function evaluateVerification(
  plan: VerificationPlan,
  evidence: readonly VerificationEvidence[],
): VerificationEvaluation {
  if (plan.checks.length === 0) {
    return {
      status: "INCOMPLETE",
      incompleteCheckIds: [],
      failedCheckIds: [],
      errorCheckIds: [],
      warnings: [],
    };
  }

  const incompleteCheckIds: VerificationCheck["id"][] = [];
  const failedCheckIds: VerificationCheck["id"][] = [];
  const errorCheckIds: VerificationCheck["id"][] = [];
  const warnings: string[] = [];

  for (const check of plan.checks) {
    const blocking = check.requirement !== "ADVISORY";
    const checkHasEvidence = hasEvidence(check, evidence);

    if (check.status === "FAILED") {
      if (blocking) failedCheckIds.push(check.id);
      else warnings.push(`Advisory check ${check.ordinal} failed`);
      continue;
    }
    if (check.status === "ERROR") {
      if (blocking) errorCheckIds.push(check.id);
      else warnings.push(`Advisory check ${check.ordinal} errored`);
      continue;
    }
    if (check.status === "SKIPPED") {
      const trustedUnavailable =
        check.requirement === "IF_AVAILABLE" && hasTrustworthyUnavailableEvidence(check, evidence);
      if (blocking && !trustedUnavailable) incompleteCheckIds.push(check.id);
      continue;
    }
    if (blocking && (!checkHasEvidence || check.status !== "PASSED")) {
      incompleteCheckIds.push(check.id);
    }
  }

  let status: VerificationEvaluationStatus = "PASSED";
  if (incompleteCheckIds.length > 0) status = "INCOMPLETE";
  else if (failedCheckIds.length > 0) status = "FAILED";
  else if (errorCheckIds.length > 0) status = "ERROR";

  return { status, incompleteCheckIds, failedCheckIds, errorCheckIds, warnings };
}
