import type { ApprovalPolicy, PermissionProfile } from "@caelush/protocol";
import type { ToolSecurityFacts } from "@caelush/tools";
import { classifySensitivePath, isValidWorkspaceFactPath, type SensitivePathCategory } from "./sensitive-path.js";

export type InputSecurityAssessmentKind = "NO_ADDITIONAL_RESTRICTION" | "REQUIRE_APPROVAL" | "DENY";

export interface InputSecurityAssessment {
  readonly kind: InputSecurityAssessmentKind;
  readonly reasonCode: string;
  readonly safeReason: string;
  readonly sensitiveCategories: readonly SensitivePathCategory[];
}

export interface InputSecurityContext {
  readonly permissionProfile: PermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
}

export function evaluateInputSecurityPolicy(
  facts: ToolSecurityFacts,
  context: InputSecurityContext,
): InputSecurityAssessment {
  const categories = new Set<SensitivePathCategory>();
  let invalidPath = false;
  for (const access of facts.resourceAccesses) {
    if (!isValidWorkspaceFactPath(access.path)) {
      invalidPath = true;
      continue;
    }
    const category = classifySensitivePath(access.path);
    if (category !== undefined) categories.add(category);
  }
  if (invalidPath) {
    return reviewOrDeny(
      context.approvalPolicy,
      "OPAQUE_INPUT_REQUIRES_REVIEW",
      "This operation contains an input that cannot be safely interpreted and requires review.",
      categories,
    );
  }
  if (categories.size > 0) {
    return reviewOrDeny(
      context.approvalPolicy,
      "SENSITIVE_RESOURCE_REQUIRES_REVIEW",
      "This operation accesses a sensitive project resource and requires review.",
      categories,
      "SENSITIVE_RESOURCE_BLOCKED_WITHOUT_APPROVAL",
      "This operation accesses a sensitive project resource and is blocked without approval.",
    );
  }
  return {
    kind: "NO_ADDITIONAL_RESTRICTION",
    reasonCode: "NO_INPUT_RESTRICTION",
    safeReason: "No additional input-level restriction applies.",
    sensitiveCategories: [],
  };
}

function reviewOrDeny(
  approvalPolicy: ApprovalPolicy,
  reviewCode: string,
  reviewReason: string,
  categories: ReadonlySet<SensitivePathCategory>,
  denyCode = "OPAQUE_INPUT_BLOCKED_WITHOUT_APPROVAL",
  denyReason = "This operation is blocked because its input cannot be safely reviewed.",
): InputSecurityAssessment {
  return {
    kind: approvalPolicy === "NEVER_ASK" ? "DENY" : "REQUIRE_APPROVAL",
    reasonCode: approvalPolicy === "NEVER_ASK" ? denyCode : reviewCode,
    safeReason: approvalPolicy === "NEVER_ASK" ? denyReason : reviewReason,
    sensitiveCategories: [...categories].sort(),
  };
}
