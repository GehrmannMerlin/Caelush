import {
  CapabilitySchema,
  JsonObjectSchema,
  RiskLevelSchema,
  ToolNameSchema,
  ToolInvocationSchema,
  type JsonObject,
} from "@caelush/protocol";
import { assertToolSecurityContext } from "@caelush/agent";
import type {
  ToolDefinitionMetadata,
  ToolExecutionGateDecision,
  ToolExecutionGateInput,
  ToolExecutionGatePort,
} from "./tool-gate-types.js";
import { SecurityPolicyInvariantError } from "./errors.js";
import { evaluateSecurityPolicy } from "./evaluator.js";
import { evaluateSecurityDecision } from "./evaluator.js";
import { combineSecurityDecisions, type SecurityDecision } from "./decision.js";
import { evaluateInputSecurityPolicy } from "./input-policy.js";
import { redactJson, redactText, detectSecrets } from "./secret-redaction.js";
import { isValidWorkspaceFactPath, normalizeWorkspaceFactPath } from "./sensitive-path.js";
import { evaluateLogicalSandboxAdmission } from "./logical-sandbox.js";
import { classifyExecutionContainment } from "./containment.js";
import { assessCommandEffect, type CommandEffectAssessment } from "./effect-assessment.js";

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
      input.securityContext.securityPolicy !== undefined &&
      !isAlignedPolicyContext(input.securityContext)
    ) {
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
    if (input.securityContext.securityPolicy !== undefined) {
      const effect =
        facts.shellCommand === undefined
          ? undefined
          : assessShellCommandEffect(facts.shellCommand, facts.secretScanInputs);
      const policyDecision = evaluatePolicySnapshotBoundFacts(input, definition, facts, effect);
      const safeAction = createSafeAction(facts, effect?.classifications, admission.containment);
      return safeAction === undefined ? policyDecision : { ...policyDecision, safeAction };
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

function isAlignedPolicyContext(input: ToolExecutionGateInput["securityContext"]): boolean {
  const policy = input.securityPolicy;
  if (policy === undefined) return true;
  const expected =
    policy.presetId === "VIEW_ONLY"
      ? {
          permissionProfile: "READ_ONLY",
          approvalPolicy: "ON_BOUNDARY",
          filesystemBoundary: "WORKSPACE_READ_ONLY",
          processBoundary: "READ_ONLY",
          requiredEnforcement: "OS_RESTRICTED",
        }
      : policy.presetId === "WORKSPACE_WRITE"
        ? {
            permissionProfile: "PROJECT_ACCESS",
            approvalPolicy: "ON_BOUNDARY",
            filesystemBoundary: "WORKSPACE_READ_WRITE",
            processBoundary: "WORKSPACE_WRITE",
            requiredEnforcement: "OS_RESTRICTED",
          }
        : policy.presetId === "FULL_ACCESS"
          ? {
              permissionProfile: "FULL_ACCESS",
              approvalPolicy: "NEVER_ASK",
              filesystemBoundary: "HOST_USER_SCOPE",
              processBoundary: "UNRESTRICTED",
              requiredEnforcement: "HARD_SAFETY_ONLY",
            }
          : undefined;
  return (
    expected !== undefined &&
    input.permissionProfile === expected.permissionProfile &&
    input.approvalPolicy === expected.approvalPolicy &&
    policy.filesystemBoundary === expected.filesystemBoundary &&
    policy.processBoundary === expected.processBoundary &&
    policy.requiredEnforcement === expected.requiredEnforcement
  );
}

function evaluatePolicySnapshotBoundFacts(
  input: ToolExecutionGateInput,
  definition: ToolDefinitionMetadata,
  facts: NonNullable<ToolExecutionGateInput["securityFacts"]>,
  effect: CommandEffectAssessment | undefined,
): SecurityDecision {
  const policy = input.securityContext.securityPolicy!;
  if (facts.shellCommand !== undefined) {
    return evaluateSecurityDecision({
      permissionProfile: input.securityContext.permissionProfile,
      approvalPolicy: input.securityContext.approvalPolicy,
      riskLevel: definition.riskLevel,
      requiredCapabilities: definition.requiredCapabilities,
      effect: effect ?? assessShellCommandEffect(facts.shellCommand, facts.secretScanInputs),
      filesystemBoundary: policy.filesystemBoundary,
      processBoundary: policy.processBoundary,
    });
  }
  if (facts.opaqueInput === true) {
    return evaluateSecurityDecision({
      permissionProfile: input.securityContext.permissionProfile,
      approvalPolicy: input.securityContext.approvalPolicy,
      riskLevel: definition.riskLevel,
      requiredCapabilities: definition.requiredCapabilities,
      approvalRequired: true,
      filesystemBoundary: policy.filesystemBoundary,
      processBoundary: policy.processBoundary,
    });
  }
  return evaluateSecurityPolicy({
    permissionProfile: input.securityContext.permissionProfile,
    approvalPolicy: input.securityContext.approvalPolicy,
    riskLevel: definition.riskLevel,
    requiredCapabilities: definition.requiredCapabilities,
  });
}

function assessShellCommandEffect(
  shell: NonNullable<NonNullable<ToolExecutionGateInput["securityFacts"]>["shellCommand"]>,
  secretInputs: readonly { readonly text: string }[],
): CommandEffectAssessment {
  const secretTaintIds = secretInputs.some((input) => detectSecrets(input.text).count > 0)
    ? ["secret-scan"]
    : [];
  const assessments = (["POSIX_SH", "POWERSHELL", "CMD"] as const).map((platform) =>
    assessCommandEffect({
      command: shell.command,
      platform,
      workdir: shell.workdir,
      tty: shell.tty,
      secretTaintIds,
    }),
  );
  return mergeCommandEffects(assessments);
}

function mergeCommandEffects(
  assessments: readonly CommandEffectAssessment[],
): CommandEffectAssessment {
  const first = assessments[0]!;
  const uniquePathFacts = <T extends { readonly path: string }>(values: readonly T[]): T[] => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const classifications = [
    ...new Set(assessments.flatMap((assessment) => assessment.classifications ?? [])),
  ];
  const taintIds = [
    ...new Set(assessments.flatMap((assessment) => assessment.secrets.detectedTaintIds)),
  ];
  return Object.freeze({
    confidence: assessments.some((assessment) => assessment.confidence === "OPAQUE")
      ? "OPAQUE"
      : assessments.some((assessment) => assessment.confidence === "PARTIAL")
        ? "PARTIAL"
        : "EXACT",
    filesystem: Object.freeze({
      reads: Object.freeze(
        uniquePathFacts(assessments.flatMap((assessment) => assessment.filesystem.reads)),
      ),
      writes: Object.freeze(
        uniquePathFacts(assessments.flatMap((assessment) => assessment.filesystem.writes)),
      ),
      deletes: Object.freeze(
        uniquePathFacts(assessments.flatMap((assessment) => assessment.filesystem.deletes)),
      ),
      unknownTargets: assessments.some((assessment) => assessment.filesystem.unknownTargets),
    }),
    process: Object.freeze({
      spawnsChildren: assessments.some((assessment) => assessment.process.spawnsChildren),
      longRunning: assessments.some((assessment) => assessment.process.longRunning),
      targetsManagedProcessIds: Object.freeze([
        ...new Set(
          assessments.flatMap((assessment) => assessment.process.targetsManagedProcessIds),
        ),
      ]),
      targetsUnmanagedProcesses: assessments.some(
        (assessment) => assessment.process.targetsUnmanagedProcesses,
      ),
    }),
    network: Object.freeze({
      mayAccessNetwork: assessments.some((assessment) => assessment.network.mayAccessNetwork),
      knownDestinations: Object.freeze([
        ...new Set(assessments.flatMap((assessment) => assessment.network.knownDestinations)),
      ]),
      remoteMutation: assessments.some((assessment) => assessment.network.remoteMutation),
    }),
    privilege: Object.freeze({
      requestsElevation: assessments.some((assessment) => assessment.privilege.requestsElevation),
      modifiesIdentityOrPermissions: assessments.some(
        (assessment) => assessment.privilege.modifiesIdentityOrPermissions,
      ),
    }),
    system: Object.freeze({
      powerControl: assessments.some((assessment) => assessment.system.powerControl),
      diskOrPartitionMutation: assessments.some(
        (assessment) => assessment.system.diskOrPartitionMutation,
      ),
      serviceMutation: assessments.some((assessment) => assessment.system.serviceMutation),
      securityPolicyMutation: assessments.some(
        (assessment) => assessment.system.securityPolicyMutation,
      ),
      rawDeviceAccess: assessments.some((assessment) => assessment.system.rawDeviceAccess),
    }),
    secrets: Object.freeze({
      readsKnownSecretMaterial: assessments.some(
        (assessment) => assessment.secrets.readsKnownSecretMaterial,
      ),
      sendsDataToNetwork: assessments.some((assessment) => assessment.secrets.sendsDataToNetwork),
      detectedTaintIds: Object.freeze(taintIds),
    }),
    execution: Object.freeze({
      ...(first.execution.executablePath === undefined
        ? {}
        : { executablePath: first.execution.executablePath }),
      ...(first.execution.interpreter === undefined
        ? {}
        : { interpreter: first.execution.interpreter }),
      dynamicEvaluation: assessments.some((assessment) => assessment.execution.dynamicEvaluation),
      opaqueBinary: assessments.some((assessment) => assessment.execution.opaqueBinary),
    }),
    classifications: Object.freeze(classifications),
  });
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

/**
 * Refuse anything that is not exactly the four-field Tool policy metadata.
 *
 * The check is deliberately *exact*: four own properties on the canonical metadata shape, plus the
 * Protocol schemas for every value. A partially-configured host that hands the gate a wider or
 * narrower object gets an invariant failure rather than a policy decision made over fields the gate
 * did not read.
 *
 * Phase 4F removed the second accepted arm. The gate used to also admit a legacy seven-field
 * `protocol.ToolDefinition`, which existed only because the retired Tool System carried that shape to
 * it. With that contract retired, `ToolGateMetadata` is the only shape the gate can be asked about,
 * and the runtime check narrowed with it — the policy behaviour is unchanged, because the four fields
 * it reads are the same four fields it always read.
 */
function isToolDefinitionMetadata(value: unknown): value is ToolDefinitionMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const definition = value as Record<string, unknown>;
  return (
    Object.keys(definition).length === 4 &&
    ToolNameSchema.safeParse(definition.name).success &&
    RiskLevelSchema.safeParse(definition.riskLevel).success &&
    Array.isArray(definition.requiredCapabilities) &&
    definition.requiredCapabilities.every(
      (capability) => CapabilitySchema.safeParse(capability).success,
    ) &&
    JsonObjectSchema.safeParse(definition.runtimeRequirements).success
  );
}
