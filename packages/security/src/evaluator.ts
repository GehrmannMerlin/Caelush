import {
  ApprovalPolicySchema,
  CapabilitySchema,
  FilesystemBoundarySchema,
  PermissionProfileSchema,
  ProcessBoundarySchema,
  RiskLevelSchema,
} from "@caelush/protocol";
import { classifyExecutionContainment } from "./containment.js";
import { resolveGrantedCapabilities } from "./capabilities.js";
import { SecurityPolicyInputError } from "./errors.js";
import { evaluateHardSafety } from "./hard-safety-policy.js";
import type {
  SecurityDecision,
  SecurityDecisionInput,
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
const APPROVAL_REQUIRED_REASON =
  "This operation requires an approval boundary that the active policy cannot silently bypass.";
const BOUNDARY_APPROVAL_REASON =
  "This operation crosses the active preset boundary and requires review.";
const BOUNDARY_DENIED_REASON =
  "This operation crosses the active preset boundary and is blocked without approval.";
const OPAQUE_APPROVAL_REASON =
  "This operation cannot be bounded precisely and requires review before execution.";
const OPAQUE_DENIED_REASON =
  "This operation cannot be bounded precisely and is blocked without an approval path.";

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
  if (input.permissionProfile === "PROJECT_ACCESS" && containment === "UNCONFINED_LOCAL_PROCESS") {
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

/**
 * Evaluate the complete preset-aware decision order:
 * hard safety -> capability -> preset boundary -> approval.
 *
 * `NEVER_ASK` removes the waiting state; it never turns an operation that still needs review into
 * an automatic allow. The caller must make the resulting DENY terminal for that operation.
 */
export function evaluateSecurityDecision(input: SecurityDecisionInput): SecurityDecision {
  validateDecisionInput(input);

  if (input.effect !== undefined) {
    const hardSafety = evaluateHardSafety(input.effect);
    if (hardSafety.kind === "DENY") {
      return {
        kind: "DENY",
        reasonCode: hardSafety.reasonCode,
        safeReason: hardSafety.safeReason,
      };
    }
  }

  const granted = resolveGrantedCapabilities(input.permissionProfile);
  if (input.requiredCapabilities.some((capability) => !granted.has(capability))) {
    return {
      kind: "DENY",
      reasonCode: "MISSING_REQUIRED_CAPABILITY",
      safeReason: MISSING_CAPABILITY_REASON,
    };
  }

  const filesystemBoundary =
    input.filesystemBoundary ?? defaultFilesystemBoundary(input.permissionProfile);
  const processBoundary = input.processBoundary ?? defaultProcessBoundary(input.permissionProfile);
  const crossesBoundary =
    input.effect !== undefined &&
    effectCrossesBoundary(input.effect, filesystemBoundary, processBoundary);
  if (crossesBoundary) {
    if (input.approvalPolicy === "NEVER_ASK") {
      return {
        kind: "DENY",
        reasonCode: "PRESET_BOUNDARY_DENIED",
        safeReason: BOUNDARY_DENIED_REASON,
      };
    }
    return {
      kind: "REQUIRE_APPROVAL",
      reasonCode: "PRESET_BOUNDARY_REQUIRES_REVIEW",
      safeReason: BOUNDARY_APPROVAL_REASON,
    };
  }

  const opaqueEffect = input.effect?.confidence === "OPAQUE";
  const approvalRequired = input.approvalRequired === true || opaqueEffect;
  if (approvalRequired) {
    if (input.approvalPolicy === "NEVER_ASK") {
      return {
        kind: "DENY",
        reasonCode: "APPROVAL_REQUIRED_BUT_NEVER_ASK",
        safeReason: OPAQUE_DENIED_REASON,
      };
    }
    return {
      kind: "REQUIRE_APPROVAL",
      reasonCode: "APPROVAL_POLICY_REQUIRES_REVIEW",
      safeReason: opaqueEffect ? OPAQUE_APPROVAL_REASON : APPROVAL_REQUIRED_REASON,
    };
  }

  if (input.approvalPolicy === "ALWAYS_ASK") {
    return {
      kind: "REQUIRE_APPROVAL",
      reasonCode: "APPROVAL_POLICY_REQUIRES_REVIEW",
      safeReason: APPROVAL_REASON,
    };
  }
  if (
    input.approvalPolicy === "DANGEROUS_ONLY" &&
    (input.riskLevel === "HIGH" || input.riskLevel === "CRITICAL")
  ) {
    return {
      kind: "REQUIRE_APPROVAL",
      reasonCode: "DANGEROUS_ACTION_REQUIRES_REVIEW",
      safeReason: DANGEROUS_REASON,
    };
  }
  return { kind: "ALLOW", reasonCode: "ALLOWED_BY_POLICY", safeReason: ALLOW_REASON };
}

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

function validateDecisionInput(input: SecurityDecisionInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SecurityPolicyInputError();
  }
  const record = input as unknown as Record<string, unknown>;
  if (
    !PermissionProfileSchema.safeParse(record.permissionProfile).success ||
    !ApprovalPolicySchema.safeParse(record.approvalPolicy).success ||
    !RiskLevelSchema.safeParse(record.riskLevel).success ||
    !Array.isArray(record.requiredCapabilities) ||
    record.requiredCapabilities.some(
      (capability) => !CapabilitySchema.safeParse(capability).success,
    ) ||
    (record.effect !== undefined &&
      (record.effect === null ||
        typeof record.effect !== "object" ||
        Array.isArray(record.effect))) ||
    (record.approvalRequired !== undefined && typeof record.approvalRequired !== "boolean") ||
    (record.filesystemBoundary !== undefined &&
      !FilesystemBoundarySchema.safeParse(record.filesystemBoundary).success) ||
    (record.processBoundary !== undefined &&
      !ProcessBoundarySchema.safeParse(record.processBoundary).success)
  ) {
    throw new SecurityPolicyInputError();
  }
}

function defaultFilesystemBoundary(
  permissionProfile: SecurityDecisionInput["permissionProfile"],
): NonNullable<SecurityDecisionInput["filesystemBoundary"]> {
  if (permissionProfile === "READ_ONLY") return "WORKSPACE_READ_ONLY";
  if (permissionProfile === "PROJECT_ACCESS") return "WORKSPACE_READ_WRITE";
  return "HOST_USER_SCOPE";
}

function defaultProcessBoundary(
  permissionProfile: SecurityDecisionInput["permissionProfile"],
): NonNullable<SecurityDecisionInput["processBoundary"]> {
  if (permissionProfile === "READ_ONLY") return "READ_ONLY";
  if (permissionProfile === "PROJECT_ACCESS") return "WORKSPACE_WRITE";
  return "UNRESTRICTED";
}

function effectCrossesBoundary(
  effect: NonNullable<SecurityDecisionInput["effect"]>,
  filesystemBoundary: NonNullable<SecurityDecisionInput["filesystemBoundary"]>,
  processBoundary: NonNullable<SecurityDecisionInput["processBoundary"]>,
): boolean {
  if (filesystemBoundary !== "HOST_USER_SCOPE") {
    const paths = [
      ...effect.filesystem.reads,
      ...effect.filesystem.writes,
      ...effect.filesystem.deletes,
    ];
    if (
      paths.some((path) =>
        filesystemBoundary === "WORKSPACE_READ_ONLY"
          ? path.relation !== "WORKSPACE" ||
            effect.filesystem.writes.length > 0 ||
            effect.filesystem.deletes.length > 0
          : path.relation !== "WORKSPACE",
      )
    ) {
      return true;
    }
    if (effect.filesystem.unknownTargets) return true;
  }
  if (processBoundary === "READ_ONLY") {
    return effect.process.spawnsChildren || effect.process.longRunning;
  }
  return false;
}
