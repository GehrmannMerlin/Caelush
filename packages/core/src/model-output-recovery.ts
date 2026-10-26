import type { AgentState, ContextBudgetPolicySnapshot } from "@caelush/protocol";

export type ModelOutputRecoveryStopReason =
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "POLICY_MISSING"
  | "POLICY_UNSUPPORTED"
  | "RECOVERY_DISABLED"
  | "RECOVERY_ALREADY_USED"
  | "MISSING_ADMITTED_CAP"
  | "INVALID_ADMITTED_CAP"
  | "INVALID_MODEL_CAP"
  | "INVALID_USER_CAP"
  | "TARGET_OVERFLOW"
  | "NO_OUTPUT_INCREMENT";

export type ModelOutputRecoveryPlan =
  | { readonly kind: "RECOVER"; readonly targetOutputTokens: number }
  | { readonly kind: "STOP"; readonly reason: ModelOutputRecoveryStopReason };

export interface PlanModelOutputRecoveryInput {
  readonly policy: ContextBudgetPolicySnapshot | undefined;
  readonly recovery: AgentState["modelOutputRecovery"];
  readonly trustedAdmittedOutputTokens: number | undefined;
  readonly modelMaxOutputTokens: number;
  readonly explicitUserMaxOutputTokens: number | undefined;
  readonly cancelled: boolean;
  readonly deadlineExceeded: boolean;
}

export function planModelOutputRecovery(
  input: PlanModelOutputRecoveryInput,
): ModelOutputRecoveryPlan {
  if (input.cancelled) {
    return { kind: "STOP", reason: "CANCELLED" };
  }

  if (input.deadlineExceeded) {
    return { kind: "STOP", reason: "DEADLINE_EXCEEDED" };
  }

  if (!input.policy) {
    return { kind: "STOP", reason: "POLICY_MISSING" };
  }

  if (input.policy.version !== "TURN_BUDGET_V3" && input.policy.version !== "TURN_BUDGET_V4") {
    return { kind: "STOP", reason: "POLICY_UNSUPPORTED" };
  }

  const recoveryPolicy = input.policy.outputRecovery;
  if (!recoveryPolicy) {
    return { kind: "STOP", reason: "RECOVERY_DISABLED" };
  }

  if (input.recovery) {
    return { kind: "STOP", reason: "RECOVERY_ALREADY_USED" };
  }

  const originalOutputTokens = input.trustedAdmittedOutputTokens;
  if (originalOutputTokens === undefined) {
    return { kind: "STOP", reason: "MISSING_ADMITTED_CAP" };
  }

  if (!isPositiveSafeInteger(originalOutputTokens)) {
    return { kind: "STOP", reason: "INVALID_ADMITTED_CAP" };
  }

  if (!isPositiveSafeInteger(input.modelMaxOutputTokens)) {
    return { kind: "STOP", reason: "INVALID_MODEL_CAP" };
  }

  if (
    input.explicitUserMaxOutputTokens !== undefined &&
    !isPositiveSafeInteger(input.explicitUserMaxOutputTokens)
  ) {
    return { kind: "STOP", reason: "INVALID_USER_CAP" };
  }

  const multipliedTarget = originalOutputTokens * recoveryPolicy.outputMultiplier;
  if (!Number.isSafeInteger(multipliedTarget)) {
    return { kind: "STOP", reason: "TARGET_OVERFLOW" };
  }

  const targetOutputTokens = Math.min(
    multipliedTarget,
    input.modelMaxOutputTokens,
    input.explicitUserMaxOutputTokens ?? Number.MAX_SAFE_INTEGER,
  );

  if (targetOutputTokens <= originalOutputTokens) {
    return { kind: "STOP", reason: "NO_OUTPUT_INCREMENT" };
  }

  return { kind: "RECOVER", targetOutputTokens };
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
