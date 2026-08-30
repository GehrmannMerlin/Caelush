import {
  CapabilitySchema,
  JsonObjectSchema,
  RiskLevelSchema,
  ToolNameSchema,
  ToolInvocationSchema,
  type ToolDefinition,
} from "@caelush/protocol";
import {
  assertToolSecurityContext,
  type ToolExecutionGateDecision,
  type ToolExecutionGateInput,
  type ToolExecutionGatePort,
  type ToolDefinitionMetadata,
} from "@caelush/tools";
import { SecurityPolicyInvariantError } from "./errors.js";
import { evaluateSecurityPolicy } from "./evaluator.js";

export class CaelushToolExecutionGate implements ToolExecutionGatePort {
  async decide(input: ToolExecutionGateInput): Promise<ToolExecutionGateDecision> {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new SecurityPolicyInvariantError();
    }
    const definition = input.definition;
    if (
      !isToolDefinitionMetadata(definition) ||
      !ToolNameSchema.safeParse(input.toolName).success
    ) {
      throw new SecurityPolicyInvariantError();
    }
    let invocation;
    try {
      invocation = ToolInvocationSchema.parse(input.invocation);
    } catch {
      throw new SecurityPolicyInvariantError();
    }
    try {
      assertToolSecurityContext(input.securityContext);
    } catch {
      throw new SecurityPolicyInvariantError();
    }
    if (
      input.toolName !== definition.name ||
      invocation.toolName !== definition.name ||
      invocation.riskLevel !== definition.riskLevel
    ) {
      throw new SecurityPolicyInvariantError();
    }
    return evaluateSecurityPolicy({
      permissionProfile: input.securityContext.permissionProfile,
      approvalPolicy: input.securityContext.approvalPolicy,
      riskLevel: definition.riskLevel,
      requiredCapabilities: definition.requiredCapabilities,
    });
  }
}

function isToolDefinitionMetadata(
  value: unknown,
): value is ToolDefinitionMetadata | ToolDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const definition = value as Record<string, unknown>;
  const keys = Object.keys(definition);
  const hasFullDefinition =
    keys.length === 7 &&
    Object.hasOwn(definition, "description") &&
    Object.hasOwn(definition, "inputSchema") &&
    Object.hasOwn(definition, "outputSchema");
  const hasMetadata = keys.length === 4;
  return (
    (hasFullDefinition || hasMetadata) &&
    ToolNameSchema.safeParse(definition.name).success &&
    RiskLevelSchema.safeParse(definition.riskLevel).success &&
    Array.isArray(definition.requiredCapabilities) &&
    definition.requiredCapabilities.every(
      (capability) => CapabilitySchema.safeParse(capability).success,
    ) &&
    JsonObjectSchema.safeParse(definition.runtimeRequirements).success &&
    (!hasFullDefinition ||
      (typeof definition.description === "string" &&
        JsonObjectSchema.safeParse(definition.inputSchema).success &&
        JsonObjectSchema.safeParse(definition.outputSchema).success))
  );
}

export type SecurityToolDefinition = Pick<
  ToolDefinition,
  "name" | "riskLevel" | "requiredCapabilities" | "runtimeRequirements"
>;
