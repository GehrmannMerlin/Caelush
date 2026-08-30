import {
  ApprovalPolicySchema,
  CapabilitySchema,
  PermissionProfileSchema,
  RiskLevelSchema,
} from "@caelush/protocol";
import { classifyExecutionContainment } from "./containment.js";
import { resolveGrantedCapabilities } from "./capabilities.js";
import { SecurityPolicyInputError } from "./errors.js";
import type {
  SecurityDecision,
  SecurityPolicyEvaluator,
  SecurityPolicyInput,
} from "./decision.js";

const ALLOW_REASON = "The Tool is allowed by the active execution policy.";
const MISSING_CAPABILITY_REASON =
  "The Tool requires a capability that the active permission profile does not grant.";
const APPROVAL_REASON = "The Tool requires approval under the active approval policy.";
const DANGEROUS_REASON = "This high-risk Tool requires approval under the active approval policy.";
const UNCONFINED_APPROVAL_REASON =
  "This unconfined process Tool requires approval under the active execution policy.";
const UNCONFINED_DENIED_REASON =
  "This unconfined process Tool is blocked without approval under the active permission profile.";

export function evaluateSecurityPolicy(input: SecurityPolicyInput): SecurityDecision {
  validateInput(input);
  const granted = resolveGrantedCapabilities(input.permissionProfile);
  if (input.requiredCapabilities.some((capability) => !granted.has(capability))) {
    return {
      kind: "DENY",
      reasonCode: "MISSING_REQUIRED_CAPABILITY",
      safeReason: MISSING_CAPABILITY_REASON,
    };
  }

  const containment = classifyExecutionContainment(input.requiredCapabilities);
  if (
    input.permissionProfile === "PROJECT_ACCESS" &&
    containment === "UNCONFINED_PROCESS"
  ) {
    if (input.approvalPolicy === "NEVER_ASK") {
      return {
        kind: "DENY",
        reasonCode: "UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL",
        safeReason: UNCONFINED_DENIED_REASON,
      };
    }
    return {
      kind: "REQUIRE_APPROVAL",
      reasonCode: "UNCONFINED_EXECUTION_REQUIRES_REVIEW",
      safeReason: UNCONFINED_APPROVAL_REASON,
    };
  }

  if (input.approvalPolicy === "ALWAYS_ASK") {
    return {
      kind: "REQUIRE_APPROVAL",
      reasonCode: "APPROVAL_POLICY_REQUIRES_REVIEW",
      safeReason: APPROVAL_REASON,
    };
  }
  if (input.approvalPolicy === "DANGEROUS_ONLY") {
    if (input.riskLevel === "HIGH" || input.riskLevel === "CRITICAL") {
      return {
        kind: "REQUIRE_APPROVAL",
        reasonCode: "DANGEROUS_ACTION_REQUIRES_REVIEW",
        safeReason: DANGEROUS_REASON,
      };
    }
  }
  return { kind: "ALLOW", reasonCode: "ALLOWED_BY_POLICY", safeReason: ALLOW_REASON };
}

export const securityPolicyEvaluator: SecurityPolicyEvaluator = {
  evaluate: evaluateSecurityPolicy,
};

function validateInput(input: SecurityPolicyInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SecurityPolicyInputError();
  }
  const record = input as unknown as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    !Object.hasOwn(record, "permissionProfile") ||
    !Object.hasOwn(record, "approvalPolicy") ||
    !Object.hasOwn(record, "riskLevel") ||
    !Object.hasOwn(record, "requiredCapabilities") ||
    !PermissionProfileSchema.safeParse(record.permissionProfile).success ||
    !ApprovalPolicySchema.safeParse(record.approvalPolicy).success ||
    !RiskLevelSchema.safeParse(record.riskLevel).success ||
    !Array.isArray(record.requiredCapabilities) ||
    record.requiredCapabilities.some(
      (capability) => !CapabilitySchema.safeParse(capability).success,
    )
  ) {
    throw new SecurityPolicyInputError();
  }
}
