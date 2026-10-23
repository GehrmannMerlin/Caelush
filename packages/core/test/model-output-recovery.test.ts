import { createStepId, type AgentState, type ContextBudgetPolicySnapshot } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { planModelOutputRecovery } from "../src/model-output-recovery.js";

const enabledPolicy = {
  version: "TURN_BUDGET_V3",
  algorithm: "HEADROOM_V1",
  minOutputTokens: 1_024,
  preferredOutputTokens: 16_384,
  safetyTokens: 2_048,
  expectedGrowthTokens: 4_096,
  postCompactionRatio: 0.5,
  outputRecovery: {
    version: "OUTPUT_RECOVERY_V1",
    maxRecoveryTurns: 1,
    outputMultiplier: 2,
  },
} satisfies ContextBudgetPolicySnapshot;

function recoveryState(
  phase: "RESERVED" | "OPENED",
): NonNullable<AgentState["modelOutputRecovery"]> {
  const common = {
    version: 1 as const,
    sourceStepId: createStepId(),
    previousOutputTokens: 16_384,
    targetOutputTokens: 32_768,
  };

  return phase === "RESERVED"
    ? { ...common, phase }
    : { ...common, phase, recoveryStepId: createStepId() };
}

const baseInput = {
  policy: enabledPolicy,
  recovery: undefined,
  trustedAdmittedOutputTokens: 16_384,
  modelMaxOutputTokens: 65_536,
  explicitUserMaxOutputTokens: undefined,
  cancelled: false,
  deadlineExceeded: false,
};

describe("planModelOutputRecovery", () => {
  it("doubles an enabled, unused output cap once", () => {
    expect(planModelOutputRecovery(baseInput)).toEqual({
      kind: "RECOVER",
      targetOutputTokens: 32_768,
    });
  });

  it("caps the target at the model ceiling and the original explicit user ceiling", () => {
    expect(planModelOutputRecovery({ ...baseInput, modelMaxOutputTokens: 24_576 })).toEqual({
      kind: "RECOVER",
      targetOutputTokens: 24_576,
    });
    expect(
      planModelOutputRecovery({
        ...baseInput,
        trustedAdmittedOutputTokens: 8_192,
        explicitUserMaxOutputTokens: 16_384,
      }),
    ).toEqual({ kind: "RECOVER", targetOutputTokens: 16_384 });
    expect(planModelOutputRecovery({ ...baseInput, explicitUserMaxOutputTokens: 16_384 })).toEqual({
      kind: "STOP",
      reason: "NO_OUTPUT_INCREMENT",
    });
  });

  it("stops when the trusted original admitted cap is missing", () => {
    expect(
      planModelOutputRecovery({ ...baseInput, trustedAdmittedOutputTokens: undefined }),
    ).toEqual({ kind: "STOP", reason: "MISSING_ADMITTED_CAP" });
  });

  it("does not use output recovery again after a reservation or an opened recovery Step", () => {
    expect(planModelOutputRecovery({ ...baseInput, recovery: recoveryState("RESERVED") })).toEqual({
      kind: "STOP",
      reason: "RECOVERY_ALREADY_USED",
    });
    expect(planModelOutputRecovery({ ...baseInput, recovery: recoveryState("OPENED") })).toEqual({
      kind: "STOP",
      reason: "RECOVERY_ALREADY_USED",
    });
  });

  it("stops when the persisted policy is absent, not V3, or has no recovery strategy", () => {
    const legacyPolicy: ContextBudgetPolicySnapshot = {
      version: "ADAPTIVE_V1",
      outputReserveTokens: 16_384,
      safetyReserveTokens: 2_048,
    };

    expect(planModelOutputRecovery({ ...baseInput, policy: undefined })).toEqual({
      kind: "STOP",
      reason: "POLICY_MISSING",
    });
    expect(planModelOutputRecovery({ ...baseInput, policy: legacyPolicy })).toEqual({
      kind: "STOP",
      reason: "POLICY_UNSUPPORTED",
    });
    const disabledPolicy: ContextBudgetPolicySnapshot = {
      version: "TURN_BUDGET_V3",
      algorithm: "HEADROOM_V1",
      minOutputTokens: 1_024,
      preferredOutputTokens: 16_384,
      safetyTokens: 2_048,
      expectedGrowthTokens: 4_096,
      postCompactionRatio: 0.5,
    };
    expect(planModelOutputRecovery({ ...baseInput, policy: disabledPolicy })).toEqual({
      kind: "STOP",
      reason: "RECOVERY_DISABLED",
    });
  });

  it("stops on cancellation or deadline, with cancellation taking precedence", () => {
    expect(planModelOutputRecovery({ ...baseInput, cancelled: true })).toEqual({
      kind: "STOP",
      reason: "CANCELLED",
    });
    expect(planModelOutputRecovery({ ...baseInput, deadlineExceeded: true })).toEqual({
      kind: "STOP",
      reason: "DEADLINE_EXCEEDED",
    });
    expect(
      planModelOutputRecovery({ ...baseInput, cancelled: true, deadlineExceeded: true }),
    ).toEqual({ kind: "STOP", reason: "CANCELLED" });
  });

  it("stops when doubling would exceed the safe integer range", () => {
    expect(
      planModelOutputRecovery({
        ...baseInput,
        trustedAdmittedOutputTokens: Number.MAX_SAFE_INTEGER,
        modelMaxOutputTokens: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ kind: "STOP", reason: "TARGET_OVERFLOW" });
  });

  it("fails closed for invalid caps and never claims a budget decision", () => {
    expect(planModelOutputRecovery({ ...baseInput, modelMaxOutputTokens: 0 })).toEqual({
      kind: "STOP",
      reason: "INVALID_MODEL_CAP",
    });
    expect(planModelOutputRecovery({ ...baseInput, explicitUserMaxOutputTokens: -1 })).toEqual({
      kind: "STOP",
      reason: "INVALID_USER_CAP",
    });
  });
});
