import type {
  ApprovalPolicy,
  Capability,
  FilesystemBoundary,
  JsonObject,
  PermissionProfile,
  ProcessBoundary,
  RiskLevel,
} from "@caelush/protocol";
import type { CommandEffectAssessment } from "./effect-assessment.js";

export type SecurityDecisionCode =
  | "ALLOWED_BY_POLICY"
  | "MISSING_REQUIRED_CAPABILITY"
  | "APPROVAL_POLICY_REQUIRES_REVIEW"
  | "DANGEROUS_ACTION_REQUIRES_REVIEW"
  | "UNCONFINED_EXECUTION_REQUIRES_REVIEW"
  | "UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL"
  | "SENSITIVE_RESOURCE_REQUIRES_REVIEW"
  | "SENSITIVE_RESOURCE_BLOCKED_WITHOUT_APPROVAL"
  | "DESTRUCTIVE_COMMAND_REQUIRES_REVIEW"
  | "DESTRUCTIVE_COMMAND_BLOCKED_WITHOUT_APPROVAL"
  | "NETWORK_COMMAND_REQUIRES_REVIEW"
  | "NETWORK_COMMAND_BLOCKED_WITHOUT_APPROVAL"
  | "REMOTE_MUTATION_REQUIRES_REVIEW"
  | "REMOTE_MUTATION_BLOCKED_WITHOUT_APPROVAL"
  | "PRIVILEGED_COMMAND_REQUIRES_REVIEW"
  | "PRIVILEGED_COMMAND_BLOCKED_WITHOUT_APPROVAL"
  | "OPAQUE_COMMAND_REQUIRES_REVIEW"
  | "OPAQUE_COMMAND_BLOCKED_WITHOUT_APPROVAL"
  | "OPAQUE_INPUT_REQUIRES_REVIEW"
  | "OPAQUE_INPUT_BLOCKED_WITHOUT_APPROVAL"
  | "SECRET_BEARING_INPUT_REQUIRES_REVIEW"
  | "SECRET_BEARING_INPUT_BLOCKED_WITHOUT_APPROVAL"
  | "SYSTEM_DESTRUCTIVE_COMMAND_DENIED"
  | "POWER_CONTROL_DENIED"
  | "DISK_PARTITION_MUTATION_DENIED"
  | "RAW_DEVICE_DENIED"
  | "SYSTEM_POLICY_MUTATION_DENIED"
  | "PRIVILEGE_ESCALATION_DENIED"
  | "UNMANAGED_PROCESS_TERMINATION_DENIED"
  | "SECRET_EXFILTRATION_DENIED"
  | "RECURSIVE_DELETE_UNRESOLVED"
  | "PROTECTED_ROOT_MUTATION"
  | "APPROVAL_REQUIRED_BUT_NEVER_ASK"
  | "PRESET_BOUNDARY_DENIED"
  | "PRESET_BOUNDARY_REQUIRES_REVIEW";

export type SecurityDecision =
  | {
      readonly kind: "ALLOW";
      readonly reasonCode: "ALLOWED_BY_POLICY";
      readonly safeReason: string;
      readonly safeAction?: JsonObject;
    }
  | {
      readonly kind: "DENY";
      readonly reasonCode:
        | "MISSING_REQUIRED_CAPABILITY"
        | "UNCONFINED_EXECUTION_BLOCKED_WITHOUT_APPROVAL"
        | "SENSITIVE_RESOURCE_BLOCKED_WITHOUT_APPROVAL"
        | "DESTRUCTIVE_COMMAND_BLOCKED_WITHOUT_APPROVAL"
        | "NETWORK_COMMAND_BLOCKED_WITHOUT_APPROVAL"
        | "REMOTE_MUTATION_BLOCKED_WITHOUT_APPROVAL"
        | "PRIVILEGED_COMMAND_BLOCKED_WITHOUT_APPROVAL"
        | "OPAQUE_COMMAND_BLOCKED_WITHOUT_APPROVAL"
        | "OPAQUE_INPUT_BLOCKED_WITHOUT_APPROVAL"
        | "SECRET_BEARING_INPUT_BLOCKED_WITHOUT_APPROVAL"
        | "SYSTEM_DESTRUCTIVE_COMMAND_DENIED"
        | "POWER_CONTROL_DENIED"
        | "DISK_PARTITION_MUTATION_DENIED"
        | "RAW_DEVICE_DENIED"
        | "SYSTEM_POLICY_MUTATION_DENIED"
        | "PRIVILEGE_ESCALATION_DENIED"
        | "UNMANAGED_PROCESS_TERMINATION_DENIED"
        | "SECRET_EXFILTRATION_DENIED"
        | "RECURSIVE_DELETE_UNRESOLVED"
        | "PROTECTED_ROOT_MUTATION"
        | "APPROVAL_REQUIRED_BUT_NEVER_ASK"
        | "PRESET_BOUNDARY_DENIED";
      readonly safeReason: string;
      readonly safeAction?: JsonObject;
    }
  | {
      readonly kind: "REQUIRE_APPROVAL";
      readonly reasonCode:
        | "APPROVAL_POLICY_REQUIRES_REVIEW"
        | "DANGEROUS_ACTION_REQUIRES_REVIEW"
        | "UNCONFINED_EXECUTION_REQUIRES_REVIEW"
        | "SENSITIVE_RESOURCE_REQUIRES_REVIEW"
        | "DESTRUCTIVE_COMMAND_REQUIRES_REVIEW"
        | "NETWORK_COMMAND_REQUIRES_REVIEW"
        | "REMOTE_MUTATION_REQUIRES_REVIEW"
        | "PRIVILEGED_COMMAND_REQUIRES_REVIEW"
        | "OPAQUE_COMMAND_REQUIRES_REVIEW"
        | "OPAQUE_INPUT_REQUIRES_REVIEW"
        | "SECRET_BEARING_INPUT_REQUIRES_REVIEW"
        | "PRESET_BOUNDARY_REQUIRES_REVIEW";
      readonly safeReason: string;
      readonly safeAction?: JsonObject;
    };

export interface SecurityPolicyInput {
  readonly permissionProfile: PermissionProfile;
  readonly approvalPolicy: ApprovalPolicy;
  readonly riskLevel: RiskLevel;
  readonly requiredCapabilities: readonly Capability[];
}

export interface SecurityDecisionInput extends SecurityPolicyInput {
  readonly effect?: CommandEffectAssessment;
  readonly approvalRequired?: boolean;
  readonly filesystemBoundary?: FilesystemBoundary;
  readonly processBoundary?: ProcessBoundary;
}

export type SecurityDecisionContext = SecurityDecisionInput;

export interface SecurityPolicyEvaluator {
  evaluate(input: SecurityPolicyInput): SecurityDecision;
}

export function combineSecurityDecisions(
  base: SecurityDecision,
  input: SecurityDecision | undefined,
): SecurityDecision {
  if (base.kind === "DENY") return base;
  if (input === undefined) return base;
  if (input.kind === "DENY") return input;
  if (base.kind === "REQUIRE_APPROVAL") return base;
  if (input.kind === "REQUIRE_APPROVAL") return input;
  return base;
}
