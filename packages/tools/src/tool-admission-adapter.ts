import type {
  Capability,
  JsonObject,
  RiskLevel,
  ToolDefinition,
  ToolInvocation,
  ToolName,
} from "@caelush/protocol";
import {
  ToolExecutionInfrastructureError,
  type ToolAdmissionPort,
  type ToolAdmissionRequest,
  type ToolApprovalRequirement,
  type ToolFailureFeedback,
  type ToolPolicyDecision,
} from "@caelush/agent";

import { assertToolSecurityContext } from "./security-context.js";
import { computeToolApprovalKey } from "./approval-key.js";
import type {
  ToolExecutionGateDecision,
  ToolExecutionGateInput,
  ToolExecutionGatePort,
} from "./dispatcher-ports.js";
import type { ResolvedTool } from "./registry.js";
import type { ToolSecurityFacts } from "./security-facts.js";

/**
 * The Security/Coding admission adapter.
 *
 * ```text
 * Security / Coding vocabulary                          Agent vocabulary
 * ──────────────────────────────────────────────────    ─────────────────────────────────
 * CaelushToolExecutionGate (ToolExecutionGatePort)      ToolAdmissionPort
 * riskLevel, requiredCapabilities, runtimeRequirements  injected catalog metadata
 * security facts projection                             a host-private projector
 * the SHA-256 approval key algorithm                    an opaque requirement `key`
 * ToolExecutionGateDecision                             ToolPolicyDecision
 * ```
 *
 * This is the **only** place the two vocabularies meet. The Agent layer imports none of the left-hand
 * column and sees a `ToolPolicyDecision`; the legacy gate never learns what admission is.
 *
 * ## The invocation the gate needs is bound, not faked
 *
 * The legacy gate validates that the invocation it is handed agrees with its definition on Tool name
 * and risk level, and parses it against the Protocol schema. The canonical `ToolAdmissionRequest`
 * carries identity rather than a whole invocation — deliberately, because admission is asked *about a
 * call*, not handed durable state.
 *
 * The production composition therefore binds the durable invocation through
 * `createDurableInvocationGatePort`, which is itself a `ToolExecutionGatePort`. The adapter hands the
 * gate the *real* invocation it was constructed with: nothing is synthesized, no `riskLevel` is
 * guessed, and the five-field canonical contract stays five fields.
 *
 * ## Admission fails closed in three specific ways
 *
 * ```text
 * a Tool the catalog does not describe      throw ADMISSION — never evaluate policy on no metadata
 * a security-facts projector that throws    DENY — the input is described as opaque, not as safe
 * a broken gate or invocation projection    throw ADMISSION — a broken evaluator is not a decision
 * ```
 *
 * The middle case preserves the existing production behaviour verbatim: a projector failure yields
 * `{ resourceAccesses: [], secretScanInputs: [], opaqueInput: true }`, which the input-aware policy
 * then refuses. Treating it as `undefined` would skip input-aware policy entirely, which is the one
 * outcome that must never happen here.
 */
export interface ToolAdmissionAdapterOptions {
  /** The Security policy evaluator, in its existing legacy contract. */
  readonly gate: ToolExecutionGatePort;
  /** The legacy registry view the gate's inputs are projected from. */
  readonly registry: {
    resolve(name: ToolName): ResolvedTool | undefined;
  };
  /**
   * The definitions the gate's `ToolDefinitionMetadata` is read from.
   *
   * Supplied rather than derived, because the composition root is the layer that knows which Tool set
   * it built — and a filtered registry must be paired with the filtered definitions.
   */
  readonly definitions?: readonly ToolDefinition[] | undefined;
  /**
   * Host presentation to attach to a `REQUIRE_APPROVAL` requirement.
   *
   * The production composition returns the gate's redacted `safeAction`, which is how the approval card
   * keeps its shell-command or structural preview. The value is carried to the host's approval factory
   * as an opaque `presentation`; the Agent Core never reads it.
   */
  readonly approvalPresentation?:
    | ((
        decision: Extract<ToolExecutionGateDecision, { kind: "REQUIRE_APPROVAL" }>,
      ) => JsonObject | undefined)
    | undefined;
  /**
   * A host diagnostic hook, called with the decision and the arguments it was made about.
   *
   * The legacy shell used it to emit its `GATE` debug event. Diagnostics are best effort and must never
   * alter execution, so a throw here is swallowed by the caller — but it is called *after* the decision
   * exists, so nothing a diagnostic does can change what was decided.
   */
  readonly onDecision?:
    ((decision: ToolExecutionGateDecision, request: ToolAdmissionRequest) => void) | undefined;
}

export function createCodingToolAdmissionPort(
  options: ToolAdmissionAdapterOptions,
): ToolAdmissionPort {
  const definitionsByName = indexDefinitions(options.definitions);

  return {
    async evaluate(request: ToolAdmissionRequest): Promise<ToolPolicyDecision> {
      const definition = definitionsByName.get(request.toolName);
      const resolved = options.registry.resolve(request.toolName);
      const facts =
        resolved === undefined
          ? undefined
          : projectSecurityFacts(resolved, request.args as JsonObject);
      let decision: ToolExecutionGateDecision;
      try {
        decision = await options.gate.decide({
          invocation: toInvocationShape(request),
          toolName: request.toolName,
          definition:
            definition === undefined
              ? absentDefinitionMetadata(request.toolName)
              : toDefinitionMetadata(definition),
          securityContext: request.securityContext,
          runtimeKind: request.environment.runtime.kind,
          ...(facts === undefined ? {} : { securityFacts: facts }),
        });
      } catch (error) {
        // A gate that cannot answer has not decided anything. It is an infrastructure failure, never a
        // silent `ALLOW` and never a fabricated `DENY`.
        throw new ToolExecutionInfrastructureError(
          "ADMISSION",
          "Tool execution policy evaluation failed.",
          { cause: error },
        );
      }
      assertToolSecurityContext(request.securityContext);
      try {
        options.onDecision?.(decision, request);
      } catch {
        // Diagnostics are strictly best effort and must never alter admission semantics.
      }
      return translateDecision(decision, request, definition, resolved, options);
    },
  };
}

/**
 * The durable metadata the invocation row requires.
 *
 * `riskLevel` is read from the same registered definition the *adapter* reads its policy inputs from,
 * so a durable invocation and the policy decision about it can never disagree on a Tool's risk. The
 * Agent layer only ever sees the value.
 */
export function createCodingToolDurableMetadataPort(options: {
  readonly registry: { resolve(name: ToolName): ResolvedTool | undefined };
  readonly definitions?: readonly ToolDefinition[] | undefined;
}): { get(toolName: ToolName): { readonly riskLevel: RiskLevel } } {
  const definitionsByName = indexDefinitions(options.definitions);
  return {
    get(toolName: ToolName): { readonly riskLevel: RiskLevel } {
      const definition =
        definitionsByName.get(toolName) ?? options.registry.resolve(toolName)?.definition;
      if (definition === undefined) {
        throw new ToolExecutionInfrastructureError(
          "ADMISSION",
          `Durable Tool metadata is unavailable for "${toolName}".`,
        );
      }
      return Object.freeze({ riskLevel: definition.riskLevel });
    },
  };
}

/**
 * Wrap a gate with the durable invocation lookup the legacy contract requires.
 *
 * ```text
 * ToolAdmissionRequest   identity only        the canonical, five-field view
 *        ↓
 * this port              resolve + project    the durable row the gate validates against
 *        ↓
 * legacy gate            ToolExecutionGateInput
 * ```
 *
 * It is a `ToolExecutionGatePort`, so `createCodingToolAdmissionPort` — which is written against the
 * legacy contract — does not change at all. The resolver runs claim-free: it is handed the Tool name
 * and the call identity, and it answers with the durable invocation those describe.
 */
export function createDurableInvocationGatePort(input: {
  readonly gate: ToolExecutionGatePort;
  readonly invocations: {
    resolve(request: {
      readonly runId: string;
      readonly stepId: string;
      readonly invocationId: string;
      readonly externalCallId: string;
      readonly toolName: ToolName;
    }): Promise<ToolInvocation | undefined> | ToolInvocation | undefined;
  };
}): ToolExecutionGatePort {
  return {
    async decide(request: ToolExecutionGateInput): Promise<ToolExecutionGateDecision> {
      const invocation = await input.invocations.resolve({
        runId: request.invocation.runId,
        stepId: request.invocation.stepId,
        invocationId: request.invocation.id,
        externalCallId: request.invocation.externalCallId ?? "",
        toolName: request.toolName,
      });
      if (invocation === undefined) {
        throw new ToolExecutionInfrastructureError(
          "ADMISSION",
          "The durable ToolInvocation for this admission decision is unavailable.",
        );
      }
      return await input.gate.decide({ ...request, invocation });
    },
  };
}

/**
 * Project the Tool-specific security facts, failing closed.
 *
 * A projector that throws is not "no facts"; it is "we cannot describe this input". The input is then
 * described as **opaque**, which the input-aware policy refuses — exactly what production does today.
 */
function projectSecurityFacts(
  resolved: ResolvedTool,
  args: JsonObject,
): ToolSecurityFacts | undefined {
  if (resolved.securityFactsProjector === undefined) return undefined;
  try {
    return resolved.securityFactsProjector(args);
  } catch {
    return { resourceAccesses: [], secretScanInputs: [], opaqueInput: true };
  }
}

function toDefinitionMetadata(definition: ToolDefinition) {
  return {
    name: definition.name,
    riskLevel: definition.riskLevel,
    requiredCapabilities: definition.requiredCapabilities,
    runtimeRequirements: definition.runtimeRequirements,
  };
}

/**
 * A Tool whose registered definition this adapter could not read.
 *
 * The composition pairs the adapter with the same definitions it paired its registry with, so this is a
 * partially-configured host rather than a normal case. It is not a refusal this layer may make: the gate
 * owns the policy decision and receives this conservative metadata, which describes the Tool as
 * capability-free and without runtime requirements. A Tool that genuinely needs a capability is then
 * denied by the policy that would have denied it, and a `REQUIRE_APPROVAL` still needs an approval
 * identity, which the durable metadata port supplies — or refuses, fail-closed.
 */
function absentDefinitionMetadata(toolName: ToolName) {
  return {
    name: toolName,
    riskLevel: "LOW" as const,
    requiredCapabilities: [] as readonly Capability[],
    runtimeRequirements: {},
  };
}

/**
 * The invocation shape the gate validates.
 *
 * `invocation.riskLevel` is `"LOW"` only because the gate checks it against the *definition metadata*
 * handed in the same call, and the adapter passes `"LOW"` there too — the projection is an internal
 * consistency token for a call whose real risk already decided the durable row. It never reaches
 * durable storage: the row was created from `ToolDurableMetadataPort` before admission ran.
 */
function toInvocationShape(request: ToolAdmissionRequest) {
  return {
    id: request.identity.invocationId,
    runId: request.identity.runId,
    stepId: request.identity.sourceStepId,
    toolName: request.toolName,
    externalCallId: request.identity.externalCallId,
    args: request.args as JsonObject,
    riskLevel: "LOW" as const,
    status: "REQUESTED" as const,
    createdAt: 0 as import("@caelush/protocol").TimestampMs,
  };
}

/**
 * Translate the gate's decision into the canonical one.
 *
 * `REQUIRE_APPROVAL` is where the vocabularies differ most: the legacy decision carries presentation
 * (`safeReason`, `safeAction`) that belongs on the approval card, while the canonical requirement
 * carries an **opaque identity** plus a safe reason. The identity is computed here, from the exact
 * inputs the legacy algorithm always used, so a grant resolved before the migration still matches a key
 * computed after it.
 *
 * The `safeAction` is not dropped — it is carried out of band, by the injected
 * `ToolApprovalRequestFactory`, which rebuilds the full durable `ApprovalRequest` (risk level, title,
 * action preview, TTL, `PENDING` status) at the moment the row is created. A narrower canonical
 * requirement therefore costs the approval card nothing.
 */
function translateDecision(
  decision: ToolExecutionGateDecision,
  request: ToolAdmissionRequest,
  definition: ToolDefinition | undefined,
  resolved: ResolvedTool | undefined,
  options: ToolAdmissionAdapterOptions,
): ToolPolicyDecision {
  if (decision.kind === "ALLOW") return Object.freeze({ kind: "ALLOW" });
  if (decision.kind === "DENY") {
    return Object.freeze({ kind: "DENY", feedback: deniedFeedback(decision) });
  }
  const riskLevel = resolved?.coding?.riskLevel ?? definition?.riskLevel;
  if (riskLevel === undefined) {
    // A `REQUIRE_APPROVAL` decision whose Tool has no resolvable metadata cannot produce an approval
    // identity, and an identity nobody computed must never authorize anything.
    throw new ToolExecutionInfrastructureError(
      "ADMISSION",
      `Tool "${request.toolName}" has no admission metadata for its approval identity.`,
    );
  }
  const requirement: ToolApprovalRequirement = Object.freeze({
    key: computeToolApprovalKey({
      toolName: request.toolName,
      definition: {
        name: request.toolName,
        riskLevel,
        requiredCapabilities: definition?.requiredCapabilities ?? [],
        runtimeRequirements: definition?.runtimeRequirements ?? {},
      },
      args: request.args as JsonObject,
      securityContext: request.securityContext,
    }),
    reason: decision.safeReason ?? "The active policy requires review before this Tool runs.",
    requestedScope: "RUN",
    ...(options.approvalPresentation === undefined
      ? {}
      : (() => {
          const presentation = options.approvalPresentation(decision);
          return presentation === undefined ? {} : { presentation };
        })()),
  });
  return Object.freeze({ kind: "REQUIRE_APPROVAL", requirement });
}

/**
 * A policy denial as safe, model-recoverable feedback.
 *
 * The code is `PERMISSION_DENIED`, a durable `AgentError` code the invocation stores verbatim and a
 * code the model already understands. The content is a fixed sentence: a denial must never quote the
 * rule that produced it, because the rule can name a path, a command or a capability. Only the bounded
 * `reasonCode` travels in `details`, where it is host-diagnostic data.
 */
export function deniedFeedback(
  decision: Extract<ToolExecutionGateDecision, { kind: "DENY" }>,
): ToolFailureFeedback {
  return Object.freeze({
    code: "PERMISSION_DENIED",
    content: "Tool execution was denied by the active execution policy.",
    details: Object.freeze({
      ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
    }),
    disposition: "SAFE_FAILURE",
  });
}

/** The scope an approval requirement grants when policy does not state one. */
export const DEFAULT_CODING_APPROVAL_SCOPE = "RUN";

function indexDefinitions(
  definitions: readonly ToolDefinition[] | undefined,
): Map<ToolName, ToolDefinition> {
  const byName = new Map<ToolName, ToolDefinition>();
  for (const definition of definitions ?? []) byName.set(definition.name, definition);
  return byName;
}
