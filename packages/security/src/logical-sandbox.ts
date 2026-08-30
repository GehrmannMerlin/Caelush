import type { Capability, JsonObject } from "@caelush/protocol";
import { classifyExecutionContainment, type ExecutionContainment } from "./containment.js";

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
    "RUNTIME_KIND_UNSUPPORTED" | "CONTAINMENT_MISMATCH" | "SECURITY_FACTS_UNAVAILABLE";
}

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
  const runtimeKinds = input.runtimeRequirements.runtimeKinds;
  if (
    input.runtimeKind !== "local" ||
    !Array.isArray(runtimeKinds) ||
    !runtimeKinds.every((value): value is string => typeof value === "string") ||
    !runtimeKinds.includes(input.runtimeKind)
  ) {
    return {
      kind: "DENY",
      containment: input.containment,
      reasonCode: "RUNTIME_KIND_UNSUPPORTED",
    };
  }
  if (!hasSecurityFacts(input.securityFacts)) {
    return {
      kind: "DENY",
      containment: input.containment,
      reasonCode: "SECURITY_FACTS_UNAVAILABLE",
    };
  }
  return { kind: "ALLOW", containment: input.containment };
}

function hasSecurityFacts(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.resourceAccesses) && Array.isArray(record.secretScanInputs);
}
