import {
  CapabilitySchema,
  RiskLevelSchema,
  ToolInvocationSchema,
  type ToolDefinition,
} from "@caelush/protocol";
import {
  assertToolSecurityContext,
  type ToolExecutionGateDecision,
  type ToolExecutionGateInput,
  type ToolExecutionGatePort,
} from "@caelush/tools";
import { SecurityPolicyInvariantError } from "./errors.js";
import { evaluateSecurityPolicy } from "./evaluator.js";

export class CaelushToolExecutionGate implements ToolExecutionGatePort {
  async decide(input: ToolExecutionGateInput): Promise<ToolExecutionGateDecision> {
    const definition = input.definition;
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
    if (
      !RiskLevelSchema.safeParse(definition.riskLevel).success ||
      !Array.isArray(definition.requiredCapabilities) ||
      definition.requiredCapabilities.some(
        (capability) => !CapabilitySchema.safeParse(capability).success,
      )
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

export type SecurityToolDefinition = Pick<
  ToolDefinition,
  "name" | "riskLevel" | "requiredCapabilities" | "runtimeRequirements"
>;
