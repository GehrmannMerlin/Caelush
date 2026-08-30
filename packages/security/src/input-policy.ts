import type { ApprovalPolicy, PermissionProfile } from "@caelush/protocol";
import type { ToolSecurityFacts } from "@caelush/tools";
import { analyzeCommand, type CommandClassification } from "./command-policy.js";
import {
  classifySensitivePath,
  isValidWorkspaceFactPath,
  type SensitivePathCategory,
} from "./sensitive-path.js";
import type { SecurityDecisionCode } from "./decision.js";
import { detectSecrets } from "./secret-redaction.js";

export type InputSecurityAssessmentKind = "NO_ADDITIONAL_RESTRICTION" | "REQUIRE_APPROVAL" | "DENY";

export interface InputSecurityAssessment {
  readonly kind: InputSecurityAssessmentKind;
  readonly reasonCode: SecurityDecisionCode | "NO_INPUT_RESTRICTION";
  readonly safeReason: string;
  readonly sensitiveCategories: readonly SensitivePathCategory[];
  readonly commandClassifications?: readonly CommandClassification[];
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
  if (facts.opaqueInput === true) {
    return reviewOrDeny(
      context.approvalPolicy,
      "OPAQUE_INPUT_REQUIRES_REVIEW",
      "This operation contains an input that cannot be safely interpreted and requires review.",
      categories,
      "OPAQUE_INPUT_BLOCKED_WITHOUT_APPROVAL",
      "This operation is blocked because its input cannot be safely interpreted.",
    );
  }
  if (invalidPath) {
    return reviewOrDeny(
      context.approvalPolicy,
      "OPAQUE_INPUT_REQUIRES_REVIEW",
      "This operation contains an input that cannot be safely interpreted and requires review.",
      categories,
    );
  }
  if (facts.secretScanInputs.some((input) => detectSecrets(input.text).count > 0)) {
    return reviewOrDeny(
      context.approvalPolicy,
      "SECRET_BEARING_INPUT_REQUIRES_REVIEW",
      "This operation contains secret-bearing input and requires review.",
      categories,
      "SECRET_BEARING_INPUT_BLOCKED_WITHOUT_APPROVAL",
      "This operation contains secret-bearing input and is blocked without approval.",
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
  if (facts.shellCommand !== undefined) {
    const classifications = analyzeShellCommand(facts.shellCommand);
    const commandAssessment = assessCommand(classifications, context.approvalPolicy);
    if (commandAssessment !== undefined) {
      return { ...commandAssessment, commandClassifications: classifications };
    }
    return {
      kind: "NO_ADDITIONAL_RESTRICTION",
      reasonCode: "NO_INPUT_RESTRICTION",
      safeReason: "No additional input-level restriction applies.",
      sensitiveCategories: [],
      commandClassifications: classifications,
    };
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
  reviewCode: SecurityDecisionCode,
  reviewReason: string,
  categories: ReadonlySet<SensitivePathCategory>,
  denyCode: SecurityDecisionCode = "OPAQUE_INPUT_BLOCKED_WITHOUT_APPROVAL",
  denyReason = "This operation is blocked because its input cannot be safely reviewed.",
): InputSecurityAssessment {
  return {
    kind: approvalPolicy === "NEVER_ASK" ? "DENY" : "REQUIRE_APPROVAL",
    reasonCode: approvalPolicy === "NEVER_ASK" ? denyCode : reviewCode,
    safeReason: approvalPolicy === "NEVER_ASK" ? denyReason : reviewReason,
    sensitiveCategories: [...categories].sort(),
  };
}

function analyzeShellCommand(
  fact: NonNullable<ToolSecurityFacts["shellCommand"]>,
): readonly CommandClassification[] {
  const classifications = new Set<CommandClassification>();
  for (const platform of ["POSIX_SH", "POWERSHELL", "CMD"] as const) {
    for (const classification of analyzeCommand({ ...fact, platform }).classifications) {
      classifications.add(classification);
    }
  }
  if (classifications.size > 1) classifications.delete("NORMAL_LOCAL");
  return [...classifications];
}

function assessCommand(
  classifications: readonly CommandClassification[],
  approvalPolicy: ApprovalPolicy,
): InputSecurityAssessment | undefined {
  if (classifications.includes("SYSTEM_DESTRUCTIVE")) {
    return {
      kind: "DENY",
      reasonCode: "SYSTEM_DESTRUCTIVE_COMMAND_DENIED",
      safeReason: "This command is classified as system-destructive and is denied.",
      sensitiveCategories: [],
      commandClassifications: classifications,
    };
  }
  const rule = commandRule(classifications);
  if (rule === undefined) return undefined;
  const denied = approvalPolicy === "NEVER_ASK";
  return {
    kind: denied ? "DENY" : "REQUIRE_APPROVAL",
    reasonCode: denied ? rule.denyCode : rule.reviewCode,
    safeReason: denied ? rule.denyReason : rule.reviewReason,
    sensitiveCategories: [],
    commandClassifications: classifications,
  };
}

function commandRule(classifications: readonly CommandClassification[]):
  | {
      readonly reviewCode: SecurityDecisionCode;
      readonly denyCode: SecurityDecisionCode;
      readonly reviewReason: string;
      readonly denyReason: string;
    }
  | undefined {
  if (classifications.includes("OPAQUE_DYNAMIC")) {
    return {
      reviewCode: "OPAQUE_COMMAND_REQUIRES_REVIEW",
      denyCode: "OPAQUE_COMMAND_BLOCKED_WITHOUT_APPROVAL",
      reviewReason: "This command cannot be safely interpreted and requires review.",
      denyReason: "This command cannot be safely interpreted and is blocked without approval.",
    };
  }
  if (classifications.includes("PRIVILEGE_ESCALATION")) {
    return {
      reviewCode: "PRIVILEGED_COMMAND_REQUIRES_REVIEW",
      denyCode: "PRIVILEGED_COMMAND_BLOCKED_WITHOUT_APPROVAL",
      reviewReason: "This command requests elevated privileges and requires review.",
      denyReason: "This command requests elevated privileges and is blocked without approval.",
    };
  }
  if (classifications.includes("REMOTE_MUTATION")) {
    return {
      reviewCode: "REMOTE_MUTATION_REQUIRES_REVIEW",
      denyCode: "REMOTE_MUTATION_BLOCKED_WITHOUT_APPROVAL",
      reviewReason: "This command may modify remote state and requires review.",
      denyReason: "This command may modify remote state and is blocked without approval.",
    };
  }
  if (classifications.includes("NETWORK_ACCESS")) {
    return {
      reviewCode: "NETWORK_COMMAND_REQUIRES_REVIEW",
      denyCode: "NETWORK_COMMAND_BLOCKED_WITHOUT_APPROVAL",
      reviewReason: "This command accesses a network resource and requires review.",
      denyReason: "This command accesses a network resource and is blocked without approval.",
    };
  }
  if (
    classifications.includes("DESTRUCTIVE_LOCAL") ||
    classifications.includes("LOCAL_REPO_MUTATION")
  ) {
    return {
      reviewCode: "DESTRUCTIVE_COMMAND_REQUIRES_REVIEW",
      denyCode: "DESTRUCTIVE_COMMAND_BLOCKED_WITHOUT_APPROVAL",
      reviewReason: "This command may modify local project state and requires review.",
      denyReason: "This command may modify local project state and is blocked without approval.",
    };
  }
  return undefined;
}
