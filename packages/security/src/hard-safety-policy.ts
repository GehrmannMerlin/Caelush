import type { SecurityDecisionCode } from "./decision.js";
import type { CommandEffectAssessment } from "./effect-assessment.js";
import { classifyRecursiveDelete } from "./recursive-delete-policy.js";

export type HardSafetyReasonCode = Extract<
  SecurityDecisionCode,
  | "POWER_CONTROL_DENIED"
  | "DISK_PARTITION_MUTATION_DENIED"
  | "RAW_DEVICE_DENIED"
  | "SYSTEM_POLICY_MUTATION_DENIED"
  | "PRIVILEGE_ESCALATION_DENIED"
  | "UNMANAGED_PROCESS_TERMINATION_DENIED"
  | "SECRET_EXFILTRATION_DENIED"
  | "RECURSIVE_DELETE_UNRESOLVED"
  | "PROTECTED_ROOT_MUTATION"
>;

export type HardSafetyDecision =
  | {
      readonly kind: "ALLOW";
      readonly reasonCode: "HARD_SAFETY_CHECK_PASSED";
      readonly safeReason: string;
    }
  | {
      readonly kind: "DENY";
      readonly reasonCode: HardSafetyReasonCode;
      readonly safeReason: string;
    };

export function evaluateHardSafety(effect: CommandEffectAssessment): HardSafetyDecision {
  if (effect.system.powerControl) {
    return deny("POWER_CONTROL_DENIED", "Power-control operations are always denied.");
  }
  if (effect.system.diskOrPartitionMutation) {
    return deny("DISK_PARTITION_MUTATION_DENIED", "Disk or partition mutation is always denied.");
  }
  if (effect.system.rawDeviceAccess) {
    return deny("RAW_DEVICE_DENIED", "Raw-device access is always denied.");
  }
  if (effect.system.serviceMutation || effect.system.securityPolicyMutation) {
    return deny(
      "SYSTEM_POLICY_MUTATION_DENIED",
      "Service and host security-policy mutation is denied.",
    );
  }
  if (effect.privilege.requestsElevation || effect.privilege.modifiesIdentityOrPermissions) {
    return deny(
      "PRIVILEGE_ESCALATION_DENIED",
      "Privilege elevation or identity mutation is denied.",
    );
  }
  if (effect.process.targetsUnmanagedProcesses) {
    return deny(
      "UNMANAGED_PROCESS_TERMINATION_DENIED",
      "A process outside the current Run ownership boundary cannot be terminated.",
    );
  }
  if (effect.secrets.sendsDataToNetwork && effect.secrets.detectedTaintIds.length > 0) {
    return deny(
      "SECRET_EXFILTRATION_DENIED",
      "Detected secret material cannot be sent to a network destination.",
    );
  }
  for (const deletion of effect.filesystem.deletes) {
    const decision = classifyRecursiveDelete(deletion);
    if (decision.kind === "DENY") return decision;
  }
  return {
    kind: "ALLOW",
    reasonCode: "HARD_SAFETY_CHECK_PASSED",
    safeReason: "No hard safety rule applies to the bounded effect facts.",
  };
}

function deny(reasonCode: HardSafetyReasonCode, safeReason: string): HardSafetyDecision {
  return { kind: "DENY", reasonCode, safeReason };
}
