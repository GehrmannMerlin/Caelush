import {
  CapabilitySchema,
  JsonObjectSchema,
  RiskLevelSchema,
  ToolNameSchema,
  ToolInvocationSchema,
  type JsonObject,
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
import { combineSecurityDecisions, type SecurityDecision } from "./decision.js";
import { evaluateInputSecurityPolicy } from "./input-policy.js";
import { redactJson, redactText } from "./secret-redaction.js";
import { isValidWorkspaceFactPath, normalizeWorkspaceFactPath } from "./sensitive-path.js";
import { evaluateLogicalSandboxAdmission } from "./logical-sandbox.js";
import { classifyExecutionContainment } from "./containment.js";

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
    const baseDecision = evaluateSecurityPolicy({
      permissionProfile: input.securityContext.permissionProfile,
      approvalPolicy: input.securityContext.approvalPolicy,
      riskLevel: definition.riskLevel,
      requiredCapabilities: definition.requiredCapabilities,
    });
    if (input.securityFacts === undefined) return baseDecision;
    const facts = normalizeSecurityFacts(input.securityFacts);
    const admission = evaluateLogicalSandboxAdmission({
      containment: classifyExecutionContainment(definition.requiredCapabilities),
      runtimeKind: input.runtimeKind ?? "local",
      runtimeRequirements: definition.runtimeRequirements,
      requiredCapabilities: definition.requiredCapabilities,
      securityFacts: facts ?? input.securityFacts,
    });
    if (admission.kind === "DENY") {
      const safeAction = createSafeAction(facts, undefined, admission.containment);
      return {
        kind: "DENY",
        ...(admission.reasonCode === undefined ? {} : { reasonCode: admission.reasonCode }),
        safeReason: "The Tool cannot be admitted to the active logical execution boundary.",
        ...(safeAction === undefined ? {} : { safeAction }),
      };
    }
    if (facts === undefined) {
      return { kind: "DENY", reasonCode: "SECURITY_FACTS_UNAVAILABLE" };
    }
    const assessment = evaluateInputSecurityPolicy(facts, {
      permissionProfile: input.securityContext.permissionProfile,
      approvalPolicy: input.securityContext.approvalPolicy,
    });
    const inputDecision =
      assessment.kind === "NO_ADDITIONAL_RESTRICTION"
        ? undefined
        : ({
            kind: assessment.kind,
            reasonCode: assessment.reasonCode,
            safeReason: assessment.safeReason,
          } as SecurityDecision);
    const effective = combineSecurityDecisions(baseDecision, inputDecision);
    const safeAction = createSafeAction(
      facts,
      assessment.commandClassifications,
      admission.containment,
    );
    return safeAction === undefined ? effective : { ...effective, safeAction };
  }
}

function normalizeSecurityFacts(
  facts: NonNullable<ToolExecutionGateInput["securityFacts"]>,
): NonNullable<ToolExecutionGateInput["securityFacts"]> | undefined {
  const validResourceAccesses =
    Array.isArray(facts.resourceAccesses) &&
    facts.resourceAccesses.every(
      (access) =>
        access !== null &&
        typeof access === "object" &&
        ["READ", "WRITE", "DELETE", "MOVE", "SEARCH", "DIFF"].includes(access.operation) &&
        typeof access.path === "string",
    );
  const validSecretInputs =
    Array.isArray(facts.secretScanInputs) &&
    facts.secretScanInputs.every(
      (scan) =>
        scan !== null &&
        typeof scan === "object" &&
        ["COMMAND", "STDIN", "PATCH", "GENERIC"].includes(scan.kind) &&
        typeof scan.text === "string",
    );
  const shell = facts.shellCommand;
  const validShell =
    shell === undefined ||
    (shell !== null &&
      typeof shell === "object" &&
      typeof shell.command === "string" &&
      typeof shell.workdir === "string" &&
      typeof shell.tty === "boolean");
  if (validResourceAccesses && validSecretInputs && validShell) return facts;
  return undefined;
}

function createSafeAction(
  facts: ToolExecutionGateInput["securityFacts"],
  commandClassifications: readonly string[] | undefined,
  containment: import("./containment.js").ExecutionContainment,
): JsonObject | undefined {
  if (facts === undefined) return undefined;
  if (facts.shellCommand !== undefined) {
    const workdir = isValidWorkspaceFactPath(facts.shellCommand.workdir)
      ? normalizeWorkspaceFactPath(facts.shellCommand.workdir)!
      : ".";
    return {
      kind: "SHELL_COMMAND",
      command: redactText(facts.shellCommand.command),
      workdir,
      tty: facts.shellCommand.tty,
      containment,
      classifications: [...(commandClassifications ?? [])],
    };
  }
  if (facts.structuralPreview !== undefined) {
    return {
      ...sanitizeStructuralPreview(redactJson(facts.structuralPreview) as JsonObject),
      containment,
    };
  }
  return {
    kind: "TOOL_INPUT",
    containment,
    resourceAccessCount: facts.resourceAccesses.length,
    secretScanInputCount: facts.secretScanInputs.length,
  };
}

function sanitizeStructuralPreview(value: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && ["path", "fromPath", "toPath", "workdir"].includes(key)) {
      output[key] = isValidWorkspaceFactPath(child)
        ? (normalizeWorkspaceFactPath(child) ?? "[opaque path]")
        : "[opaque path]";
    } else if (Array.isArray(child)) {
      output[key] = child.map((item) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? sanitizeStructuralPreview(item as JsonObject)
          : item,
      );
    } else if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      output[key] = sanitizeStructuralPreview(child as JsonObject);
    } else {
      output[key] = child;
    }
  }
  return output;
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
