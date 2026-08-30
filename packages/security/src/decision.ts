import type { ApprovalPolicy, Capability, PermissionProfile, RiskLevel } from "@caelush/protocol";

export type SecurityDecisionCode =
  | "ALLOWED_BY_POLICY"
  | "MISSING_REQUIRED_CAPABILITY"
  | "APPROVAL_POLICY_REQUIRES_REVIEW"
  | "DANGEROUS_ACTION_REQUIRES_REVIEW"
  | "UNCONFINED_EXECUTION_REQUIRES_REVIEW"
  | "UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL";

export type SecurityDecision =
  | {
      readonly kind: "ALLOW";
      readonly reasonCode: "ALLOWED_BY_POLICY";
      readonly safeReason: string;
    }
  | {
      readonly kind: "DENY";
      readonly reasonCode:
        "MISSING_REQUIRED_CAPABILITY" | "UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL";
      readonly safeReason: string;
    }
  | {
      readonly kind: "REQUIRE_APPROVAL";
      readonly reasonCode:
        | "APPROVAL_POLICY_REQUIRES_REVIEW"
        | "DANGEROUS_ACTION_REQUIRES_REVIEW"
        | "UNCONFINED_EXECUTION_REQUIRES_REVIEW";
      readonly safeReason: string;
    };

export interface SecurityPolicyInput {
  readonly permissionProfile: PermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
  readonly riskLevel: RiskLevel;
  readonly requiredCapabilities: readonly Capability[];
}

export interface SecurityPolicyEvaluator {
  evaluate(input: SecurityPolicyInput): SecurityDecision;
}
