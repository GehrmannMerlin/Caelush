import type { ApprovalRequest, ToolDefinition, ToolName } from "@caelush/protocol";
import { ApprovalRequestSchema } from "@caelush/protocol";
import {
  type DurableToolExecutionCoordinator,
  type ToolApprovalRequestFactory,
  type ToolExecutionUpdateSanitizerPort,
  type TransientToolUpdateConsumer,
  type TransientToolUpdateDiagnostics,
} from "@caelush/agent";
import {
  createToolExecutionDependencies,
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_BUILTIN_TOOL_ORDER,
  ToolDispatcher,
  type ResolvedTool,
  type ToolApprovalRequestIdFactory,
  type ToolApprovalStorePort,
  type ToolClock,
  type ToolDispatcherOptions,
  type ToolEventIdFactory,
  type ToolExecutionStorePort,
  type ToolInvocationIdFactory,
  type ToolObservationIdFactory,
  type ToolCommittedEventNotifier,
  type ToolRegistry,
  type ToolResultSanitizerPort,
  type ToolPresentationPort,
} from "@caelush/tools";
import { CaelushToolExecutionGate } from "./tool-gate.js";
import { CaelushToolPresentation, type TerminalOutputSanitizer } from "./presentation.js";
import { CaelushToolResultSanitizer } from "./tool-result-sanitizer.js";

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

export interface V1SecureToolDispatcherOptions extends Omit<
  ToolDispatcherOptions,
  "gate" | "execution" | "presentation" | "approvalStore" | "approvalIdFactory"
> {
  readonly approvalStore: ToolApprovalStorePort;
  readonly approvalIdFactory: ToolApprovalRequestIdFactory;
  readonly terminalOutputSanitizer: TerminalOutputSanitizer;
  readonly securityToolNames?: readonly ToolName[];
  /**
   * The transient update sanitizer for this composition.
   *
   * Supplied rather than defaulted: the executor binds it before any Tool runs, so a composition that
   * forgot one would forward nothing and prove nothing. The production daemon passes
   * `new CaelushToolExecutionUpdateSanitizer()`; a test that only needs the durable path passes its
   * own trivial implementation.
   */
  readonly updateSanitizer: ToolExecutionUpdateSanitizerPort;
  /** Where sanitized transient updates go. Absent means the Agent layer's discarding consumer. */
  readonly transientUpdates?: TransientToolUpdateConsumer | undefined;
  readonly updateDiagnostics?: TransientToolUpdateDiagnostics | undefined;
}

/**
 * The production V1 Secure Tool dispatcher.
 *
 * ```text
 * legacy ToolRegistry
 *        ↓
 * createV1SecureToolDispatcher
 *        ├─ canonical ToolCallPreparer              (@caelush/agent, via the shell)
 *        ├─ canonical ToolInvocationExecutor        (Phase 4B)
 *        ├─ canonical ToolResultPipeline            (Phase 4B)
 *        └─ compatibility ToolDispatcher            ← this composition returns it, for 4D
 * ```
 *
 * ## What changed in Phase 4C
 *
 * Before, this factory built a `ToolDispatcher` and handed it a gate, an approval store and a budget —
 * and the dispatcher then owned the lifecycle. Now the lifecycle belongs to the canonical
 * `DurableToolExecutionCoordinator`, and the composition is what assembles it:
 *
 * ```text
 * ToolAdmissionPort              Security/Coding admission adapter over CaelushToolExecutionGate
 * ToolDurableMetadataPort        the Coding catalog's risk level for the invocation row
 * ToolApprovalRequestFactory     the security-facts-derived approval card
 * ToolBudgetAdmissionPort        the durable ledger's canonical Tool admission
 * ToolExecutionStorePort         @caelush/storage, implementing the canonical port
 * DurableToolExecutionCoordinator
 * ToolDispatcher                 a compatibility facade, delegating to the coordinator
 * ```
 *
 * The legacy `ToolDispatcher` remains the object the batch and the Run layer hold, so no production
 * consumer has to change in this round. What it *is* has changed: it validates a legacy request,
 * prepares the call, and translates the canonical outcome back.
 *
 * ## Why the coordinator is required
 *
 * A composition that reached the lexical Tool without one would be a second lifecycle implementation,
 * so this factory demands it rather than building one. The layer that knows the host's policy — here,
 * the daemon and this security composition — is the layer that assembles it.
 */
export function createV1SecureToolDispatcher(
  options: V1SecureToolDispatcherOptions & {
    readonly coordinator: DurableToolExecutionCoordinator;
  },
): ToolDispatcher {
  assertDefaultBuiltinSecurityCoverage(options.registry, options.securityToolNames);
  const security = createDefaultV1ToolExecutionSecurity({
    terminalOutputSanitizer: options.terminalOutputSanitizer,
  });
  return new ToolDispatcher({
    ...options,
    gate: security.gate,
    presentation: security.presentation,
    approvalRequests: createV1ToolApprovalRequestFactory({
      registry: options.registry,
      gate: security.gate,
      approvalIdFactory: options.approvalIdFactory,
    }),
    execution: createToolExecutionDependencies({
      registry: options.registry,
      resultSanitizer: security.resultSanitizer,
      updateSanitizer: options.updateSanitizer,
      ...(options.transientUpdates === undefined
        ? {}
        : { transientUpdates: options.transientUpdates }),
      ...(options.updateDiagnostics === undefined
        ? {}
        : { updateDiagnostics: options.updateDiagnostics }),
      ...(options.outputPolicy === undefined ? {} : { outputPolicy: options.outputPolicy }),
    }),
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
 */
export function createV1ToolApprovalRequestFactory(input: {
  readonly registry: ToolRegistry;
  /** The real gate. Its own `safeAction` is what keeps the approval card's preview. */
  readonly gate: import("@caelush/tools").ToolExecutionGatePort;
  /**
   * The Tool's own security-facts projector.
   *
   * It is read from the resolved Tool so the preview describes the *actual* input — the shell command,
   * the patch shape, the resource accesses — exactly as the admission decision did. Without it the card
   * is still correct, only less specific.
   */
  readonly securityFacts?: (
    resolved: import("@caelush/tools").ResolvedTool,
    args: Readonly<import("@caelush/protocol").JsonObject>,
  ) => import("@caelush/tools").ToolSecurityFacts | undefined;
  readonly approvalIdFactory: ToolApprovalRequestIdFactory;
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
    const riskLevel = resolved.codingMetadata?.riskLevel ?? resolved.definition.riskLevel;
    return ApprovalRequestSchema.parse({
      id: input.approvalIdFactory.create(),
      runId: identity.runId,
      toolInvocationId: identity.invocationId,
      riskLevel,
      title: "Approve Tool execution",
      reason: requirement.reason,
      action: requirement.presentation ?? genericToolAction(resolved),
      status: "PENDING",
      scope: requirement.requestedScope ?? "RUN",
      expiresAt: (createdAt + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)) as typeof createdAt,
      createdAt,
    } satisfies ApprovalRequest);
  };
}

/**
 * The fallback action preview when the gate did not produce one.
 *
 * It is the same bounded, non-secret description the pre-4C dispatcher used: the Tool name, its risk
 * level, its sorted capabilities and its runtime requirements. It carries no arguments, no paths and
 * no command text, so it is safe for every Tool that has no richer preview.
 */
function genericToolAction(resolved: ResolvedTool): import("@caelush/protocol").JsonObject {
  return {
    kind: "TOOL_EXECUTION",
    toolName: resolved.definition.name,
    riskLevel: resolved.codingMetadata?.riskLevel ?? resolved.definition.riskLevel,
    requiredCapabilities: [...resolved.definition.requiredCapabilities].sort(),
    runtimeRequirements: resolved.definition.runtimeRequirements,
  };
}

export function assertDefaultBuiltinSecurityCoverage(
  registry: ToolRegistry,
  expectedToolNames: readonly ToolName[] = DEFAULT_BUILTIN_TOOL_ORDER,
): void {
  const missing = expectedToolNames.filter((name) => {
    const resolved = registry.resolve(name);
    return (
      resolved === undefined ||
      resolved.securityFactsProjector === undefined ||
      !isValidBuiltinDefinition(resolved.definition)
    );
  });
  if (missing.length > 0) {
    throw new V1SecurityCompositionError(
      `Default Tool security coverage is incomplete: ${missing.join(", ")}`,
    );
  }
}

function isValidBuiltinDefinition(definition: ToolDefinition): boolean {
  const runtimeKinds = definition.runtimeRequirements.runtimeKinds;
  return (
    definition.name.length > 0 &&
    definition.description.length > 0 &&
    definition.requiredCapabilities.length > 0 &&
    Array.isArray(runtimeKinds) &&
    runtimeKinds.length > 0 &&
    runtimeKinds.every((kind): kind is string => typeof kind === "string") &&
    runtimeKinds.includes("local")
  );
}

export type SecureDispatcherDependencySummary = Pick<
  V1SecureToolDispatcherOptions,
  | "registry"
  | "store"
  | "notifier"
  | "clock"
  | "invocationIdFactory"
  | "observationIdFactory"
  | "eventIdFactory"
  | "approvalStore"
  | "approvalIdFactory"
>;

export type {
  ToolApprovalRequestIdFactory,
  ToolApprovalStorePort,
  ToolClock,
  ToolCommittedEventNotifier,
  ToolEventIdFactory,
  ToolExecutionStorePort,
  ToolInvocationIdFactory,
  ToolObservationIdFactory,
};
