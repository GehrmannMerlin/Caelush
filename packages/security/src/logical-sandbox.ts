import type { Capability, JsonObject } from "@caelush/protocol";
import { classifyExecutionContainment, type ExecutionContainment } from "./containment.js";
import {
  declaresHostAccess,
  resolveToolExecutionRequirement,
} from "./tool-execution-requirement.js";

export interface LogicalSandboxAdmissionInput {
  readonly containment: ExecutionContainment;
  readonly runtimeKind: string;
  readonly runtimeRequirements: JsonObject;
  readonly requiredCapabilities: readonly Capability[];
  readonly securityFacts: unknown;
}

export interface LogicalSandboxAdmission {
  readonly kind: "ALLOW" | "DENY";
  readonly containment: ExecutionContainment;
  readonly reasonCode?:
    | "RUNTIME_KIND_UNSUPPORTED"
    | "CONTAINMENT_MISMATCH"
    | "SECURITY_FACTS_UNAVAILABLE"
    | "METADATA_MISMATCH"
    | "INERT_TOOL_HOST_ACCESS_DECLARED";
}

/**
 * Admit one Tool to the active logical execution boundary.
 *
 * ```text
 * containment the declared capabilities imply   must be the containment being enforced
 * the execution requirement                    what the declaration says the Tool needs
 * its security facts                           must exist, and must agree with that requirement
 * the runtime kind                             only consulted when the Tool reaches the host
 * ```
 *
 * ## Why an inert Tool is not asked about a runtime
 *
 * The requirement — resolved by the same function the composition self-check uses — already
 * decided whether a host runtime is involved at all. Asking a Tool that declared no capability and
 * no runtime to name a *supported* runtime kind is a question it cannot answer, and answering it
 * "no" was refusing every plan update. So the runtime check is asked only of the requirement that
 * has one, and it is still asked in full: the runtime must be `local`, the declared kinds must be
 * well-formed, and the active kind must be among them.
 *
 * ## Why the facts are checked even for an inert Tool
 *
 * A declaration is a claim; the projected facts are what the Tool says it is about to touch. An
 * inert Tool that projects a resource access or a shell command contradicts itself, and the
 * contradiction is refused instead of resolved in either direction. That check is the reason
 * "no capability" is a reviewed statement rather than a self-issued exemption.
 *
 * This function never decides *permission*. It removes the one requirement that does not apply,
 * and the caller's policy evaluation decides the rest, unchanged.
 */
export function evaluateLogicalSandboxAdmission(
  input: LogicalSandboxAdmissionInput,
): LogicalSandboxAdmission {
  const expectedContainment = classifyExecutionContainment(input.requiredCapabilities);
  if (input.containment !== expectedContainment) {
    return {
      kind: "DENY",
      containment: input.containment,
      reasonCode: "CONTAINMENT_MISMATCH",
    };
  }
  const requirement = resolveToolExecutionRequirement({
    requiredCapabilities: input.requiredCapabilities,
    runtimeRequirements: input.runtimeRequirements,
  });
  if (requirement.kind === "INVALID") {
    return {
      kind: "DENY",
      containment: input.containment,
      reasonCode: "METADATA_MISMATCH",
    };
  }
  if (!hasSecurityFacts(input.securityFacts)) {
    return {
      kind: "DENY",
      containment: input.containment,
      reasonCode: "SECURITY_FACTS_UNAVAILABLE",
    };
  }
  if (requirement.kind === "IN_PROCESS") {
    if (declaresHostAccess(input.securityFacts)) {
      return {
        kind: "DENY",
        containment: input.containment,
        reasonCode: "INERT_TOOL_HOST_ACCESS_DECLARED",
      };
    }
    return { kind: "ALLOW", containment: input.containment };
  }
  const runtimeKinds = requirement.supportedRuntimeKinds;
  if (input.runtimeKind !== "local" || !runtimeKinds.includes(input.runtimeKind)) {
    return {
      kind: "DENY",
      containment: input.containment,
      reasonCode: "RUNTIME_KIND_UNSUPPORTED",
    };
  }
  return { kind: "ALLOW", containment: input.containment };
}

function hasSecurityFacts(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.resourceAccesses) && Array.isArray(record.secretScanInputs);
}
