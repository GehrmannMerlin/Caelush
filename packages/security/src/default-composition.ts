import type {
  ApprovalRequest,
  ApprovalRequestId,
  EventId,
  JsonObject,
  ObservationId,
  TimestampMs,
  ToolInvocationId,
  ToolName,
} from "@caelush/protocol";
import { ApprovalRequestSchema } from "@caelush/protocol";
import {
  type AgentToolRegistry,
  type ResolvedAgentTool,
  type ToolApprovalRequestFactory,
  type ToolExecutionStorePort,
  type ToolPresentationPort,
  type ToolResultSanitizerPort,
} from "@caelush/agent";
import type { CodingToolCatalog, CodingToolSecurityMetadata } from "@caelush/coding-agent";
import type { ToolExecutionGatePort, ToolGateSecurityFacts } from "./tool-gate-types.js";
import { CaelushToolExecutionGate } from "./tool-gate.js";
import { CaelushToolPresentation, type TerminalOutputSanitizer } from "./presentation.js";
import { CaelushToolResultSanitizer } from "./tool-result-sanitizer.js";

/**
 * The pending-approval lifetime, in milliseconds.
 *
 * Fifteen minutes, the value production has always used. It is a Security/composition constant rather
 * than an Agent one because the Agent contract deliberately carries no TTL: an approval's lifetime is a
 * host policy decision about how long it will hold a Tool call open, and the layer that creates the
 * durable request is the layer that decides it.
 */
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1_000;

/** The scope an approval requirement grants when the policy does not state one. */
export const DEFAULT_CODING_APPROVAL_SCOPE = "RUN";

/** The durable Tool identity factories a host supplies. One `create()` each, and nothing else. */
export interface ToolIdentityFactories {
  readonly invocationIdFactory: { create(): ToolInvocationId };
  readonly observationIdFactory: { create(): ObservationId };
  readonly eventIdFactory: { create(): EventId };
  readonly approvalIdFactory: { create(): ApprovalRequestId };
  readonly clock: { now(): TimestampMs };
}

export interface V1ToolExecutionSecurity {
  readonly gate: CaelushToolExecutionGate;
  readonly resultSanitizer: ToolResultSanitizerPort;
  readonly presentation: ToolPresentationPort;
}

export class V1SecurityCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V1SecurityCompositionError";
  }
}

export function createDefaultV1ToolExecutionSecurity(options: {
  readonly terminalOutputSanitizer: TerminalOutputSanitizer;
}): V1ToolExecutionSecurity {
  return Object.freeze({
    gate: new CaelushToolExecutionGate(),
    presentation: new CaelushToolPresentation(options),
    resultSanitizer: new CaelushToolResultSanitizer(),
  });
}

/**
 * The production approval card.
 *
 * ```text
 * opaque ToolApprovalRequirement
 *        ↓
 * ApprovalRequest { riskLevel, title, reason, action, scope, TTL, status = PENDING }
 * ```
 *
 * ## Why this factory exists at all
 *
 * The canonical `ToolApprovalRequirement` is deliberately narrow: an opaque key, a safe reason and an
 * optional scope. It has no `action`, because an action preview is Security/Coding presentation — it
 * can describe a shell command, a patch shape or a set of resource accesses — and putting it on the
 * general Agent contract would make every general Agent host describe one.
 *
 * The production approval card must not lose anything for that reason, so this factory, which lives in
 * the layer that owns the security facts, rebuilds the *full* durable request:
 *
 * ```text
 * riskLevel    the Coding catalog's risk for this Tool
 * title        "Approve Tool execution"
 * reason       the requirement's safe reason
 * action       the gate's redacted safeAction when it produced one, otherwise the generic preview
 * scope        the requirement's scope, defaulting to RUN
 * expiresAt    createdAt + the existing 15-minute TTL
 * status       PENDING
 * createdAt    the canonical clock's timestamp, passed in
 * ```
 *
 * The redaction itself already happened: `safeAction` is built by `CaelushToolExecutionGate` from
 * redacted security facts, so a raw command, stdin, patch body or absolute host path never reaches the
 * approval row.
 *
 * ## Why it reads two canonical objects
 *
 * The registry is the Tool Execution authority — it decides whether this Tool can run at all — and the
 * catalog is the Coding metadata authority — it decides what the Tool's risk is. Phase 4F replaced the
 * legacy `ToolRegistry` view with those two directly, because the *value* the card needs is the same
 * one the durable invocation row was written from, and reading it from the object that owns it is what
 * keeps the two describing one Tool.
 */
export function createV1ToolApprovalRequestFactory(input: {
  readonly registry: AgentToolRegistry;
  /** The Coding overlay authority, when this host built one. */
  readonly catalog?: Pick<CodingToolCatalog, "get"> | undefined;
  /** The real gate. Its own `safeAction` is what keeps the approval card's preview. */
  readonly gate: ToolExecutionGatePort;
  /**
   * The Tool's own security-facts projector.
   *
   * It is read from the resolved Tool so the preview describes the *actual* input — the shell command,
   * the patch shape, the resource accesses — exactly as the admission decision did. Without it the card
   * is still correct, only less specific.
   */
  readonly securityFacts?: (
    resolved: ResolvedAgentTool,
    args: Readonly<JsonObject>,
  ) => ToolGateSecurityFacts | undefined;
  readonly approvalIdFactory: { create(): ApprovalRequestId };
  readonly ttlMs?: number;
}): ToolApprovalRequestFactory {
  /**
   * The security context of the decision currently being projected.
   *
   * The approval factory is called from inside the admission coordinator, one requirement at a time,
   * and the presentation projection below re-asks the gate about *that* decision — so it needs the
   * security context the decision was made under. Rather than widen the factory input with a field the
   * general Agent contract has no business carrying, the adapter that produces the requirement records
   * the context here for the duration of the call.
   */
  return ({ identity, call, requirement, createdAt }) => {
    const resolved = input.registry.resolve(call.resolved.tool.name);
    if (resolved === undefined) return null;
    const riskLevel = riskLevelOf(input.catalog, resolved);
    return ApprovalRequestSchema.parse({
      id: input.approvalIdFactory.create(),
      runId: identity.runId,
      toolInvocationId: identity.invocationId,
      riskLevel,
      title: "Approve Tool execution",
      reason: requirement.reason,
      action: requirement.presentation ?? genericToolAction(resolved, riskLevel),
      status: "PENDING",
      scope: requirement.requestedScope ?? DEFAULT_CODING_APPROVAL_SCOPE,
      expiresAt: (createdAt + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)) as typeof createdAt,
      createdAt,
    } satisfies ApprovalRequest);
  };
}

/**
 * The Tool's risk level, read from the authority that owns it.
 *
 * A Coding Tool's risk is Coding metadata and belongs to the catalog; a general Agent Tool has no
 * Coding metadata at all, and falls back to its own declared risk. Neither authority is derived from
 * the other, and an empty catalog is not a failure — it is a host with no Coding Tools.
 */
function riskLevelOf(
  catalog: Pick<CodingToolCatalog, "get"> | undefined,
  resolved: ResolvedAgentTool,
): import("@caelush/protocol").RiskLevel {
  return catalog?.get(resolved.tool.name)?.security.riskLevel ?? metadataRiskLevel(resolved);
}

/**
 * The risk a Tool declared when it was registered.
 *
 * The canonical registry stores a Tool's model-facing spec separately from its executable contract, so
 * the registration-time metadata is read back from the executable contract itself — the same object a
 * `CodingToolDefinition` wraps and the same object the durable invocation row was written from.
 */
function metadataRiskLevel(resolved: ResolvedAgentTool): import("@caelush/protocol").RiskLevel {
  const declared = (resolved.tool as { readonly riskLevel?: unknown }).riskLevel;
  return declared === "MEDIUM" || declared === "HIGH" || declared === "CRITICAL" ? declared : "LOW";
}

/**
 * The fallback action preview when the gate did not produce one.
 *
 * It is the same bounded, non-secret description the pre-4C dispatcher used: the Tool name, its risk
 * level, its sorted capabilities and its runtime requirements. It carries no arguments, no paths and
 * no command text, so it is safe for every Tool that has no richer preview.
 */
function genericToolAction(
  resolved: ResolvedAgentTool,
  riskLevel: import("@caelush/protocol").RiskLevel,
): JsonObject {
  const tool = resolved.tool as {
    readonly name: string;
    readonly requiredCapabilities?: readonly string[];
    readonly runtimeRequirements?: JsonObject;
  };
  return {
    kind: "TOOL_EXECUTION",
    toolName: tool.name,
    riskLevel,
    requiredCapabilities: [...(tool.requiredCapabilities ?? [])].sort(),
    runtimeRequirements: tool.runtimeRequirements ?? {},
  };
}

/**
 * Refuse a host whose default Coding Tools are not all security-described.
 *
 * ```text
 * for each expected Tool
 *   the active registry can execute it
 *   the Coding catalog describes its security metadata, with a facts projector
 * ```
 *
 * It is a composition self-check, not a policy decision: a Tool that reaches admission without facts
 * is refused there anyway, and this is what turns a partially-wired host into a startup error instead
 * of a Runtime surprise. The expected set is injected rather than restated, so the host that owns the
 * default order is the only place that order is declared.
 */
export function assertDefaultBuiltinSecurityCoverage(
  registry: AgentToolRegistry,
  catalog: Pick<CodingToolCatalog, "get">,
  expectedToolNames: readonly ToolName[],
): void {
  const missing = expectedToolNames.filter((name) => {
    const resolved = registry.resolve(name);
    if (resolved === undefined) return true;
    const definition = catalog.get(name);
    return (
      definition === undefined ||
      definition.securityFactsProjector === undefined ||
      !isValidCodingToolMetadata(definition.security, resolved)
    );
  });
  if (missing.length > 0) {
    throw new V1SecurityCompositionError(
      `Default Tool security coverage is incomplete: ${missing.join(", ")}`,
    );
  }
}

/**
 * A Tool's Coding security metadata must describe a real executable Tool.
 *
 * `runtimeKinds` is the one structured runtime requirement the current default nine all declare, and
 * it must include `local`: a Tool offered to a local host that cannot say it runs locally is a
 * metadata defect, not an exotic configuration.
 */
function isValidCodingToolMetadata(
  security: CodingToolSecurityMetadata,
  resolved: ResolvedAgentTool,
): boolean {
  const runtimeKinds = security.runtimeRequirements.runtimeKinds;
  return (
    resolved.tool.name.length > 0 &&
    resolved.tool.description.length > 0 &&
    security.requiredCapabilities.length > 0 &&
    Array.isArray(runtimeKinds) &&
    runtimeKinds.length > 0 &&
    runtimeKinds.every((kind): kind is string => typeof kind === "string") &&
    runtimeKinds.includes("local")
  );
}

export type SecureDispatcherDependencySummary = {
  readonly registry: AgentToolRegistry;
  readonly store: ToolExecutionStorePort;
  readonly sessionId: import("@caelush/protocol").SessionId;
  readonly approvalTtlMs?: number;
} & ToolIdentityFactories;
