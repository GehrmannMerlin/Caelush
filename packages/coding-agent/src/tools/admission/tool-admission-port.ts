import type { JsonObject, RiskLevel, ToolInvocation, ToolName } from "@caelush/protocol";
import {
  ToolExecutionInfrastructureError,
  assertToolSecurityContext,
  type AgentTool,
  type AgentToolRegistry,
  type ResolvedAgentTool,
  type ToolAdmissionPort,
  type ToolAdmissionRequest,
  type ToolApprovalRequirement,
  type ToolGateMetadata,
  type ToolExecutionGateDecision,
  type ToolExecutionGatePort,
  type ToolFailureFeedback,
  type ToolPolicyDecision,
  type ToolGateSecurityFacts,
  type ToolAdmissionEvaluationContext,
} from "@caelush/agent";

import { computeCodingToolApprovalKey } from "../security/approval-identity.js";
import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { CodingToolCatalog } from "../coding-tool-catalog.js";
import {
  fingerprintPreparedToolArgs,
  projectSafeToolGuardFacts,
  type BeforeToolDispatchInput,
  type ToolGuardDecision,
  type ToolGuardPipeline,
  type ToolGuardPipelineResult,
} from "../../hooks/index.js";

const MAX_MERGED_APPROVAL_REASON_BYTES = 4 * 1024;

/**
 * The Security/Coding admission adapter.
 *
 * ```text
 * Security / Coding vocabulary                          Agent vocabulary
 * ──────────────────────────────────────────────────    ─────────────────────────────────
 * CaelushToolExecutionGate (ToolExecutionGatePort)      ToolAdmissionPort
 * riskLevel, requiredCapabilities, runtimeRequirements  the catalog's Coding metadata
 * security facts projection                             a host-private projector
 * the SHA-256 approval key algorithm                    an opaque requirement `key`
 * ToolExecutionGateDecision                             ToolPolicyDecision
 * ```
 *
 * This is the **only** place the two vocabularies meet. The Agent layer imports none of the left-hand
 * column and sees a `ToolPolicyDecision`; the Security gate never learns what admission is.
 *
 * ## Why it lives in `@caelush/coding-agent`
 *
 * Every input it needs is Coding product metadata: the Tool's risk level, its capabilities, its runtime
 * requirements, its own security-facts projector and the approval-identity algorithm. Phase 4F moved it
 * here from the legacy `@caelush/tools` package for exactly that reason — the translation is *Coding
 * vocabulary → Agent contract*, and the package that owns the vocabulary owns the translation. It is not
 * a compatibility surface, and it did not change behaviour when it moved.
 *
 * ## The invocation the gate needs is bound, not faked
 *
 * The Security gate validates that the invocation it is handed agrees with its definition on Tool name
 * and risk level, and parses it against the Protocol schema. The canonical `ToolAdmissionRequest` carries
 * identity rather than a whole invocation — deliberately, because admission is asked *about a call*, not
 * handed durable state.
 *
 * The production composition therefore binds the durable invocation through
 * {@link createDurableInvocationGatePort}, which is itself a `ToolExecutionGatePort`. The adapter hands
 * the gate the *real* invocation it was constructed with: nothing is synthesized, no `riskLevel` is
 * guessed, and the five-field canonical contract stays five fields.
 *
 * ## Admission fails closed in three specific ways
 *
 * ```text
 * a Tool neither the catalog nor the registry describes   throw ADMISSION
 * a security-facts projector that throws                  DENY — the input is opaque, not safe
 * a broken gate or invocation projection                  throw ADMISSION
 * ```
 *
 * The middle case preserves the existing production behaviour verbatim: a projector failure yields
 * `{ resourceAccesses: [], secretScanInputs: [], opaqueInput: true }`, which the input-aware policy then
 * refuses. Treating it as `undefined` would skip input-aware policy entirely, which is the one outcome
 * that must never happen here.
 */
export interface CodingToolAdmissionPortOptions {
  /** The Security policy evaluator, in the contract `@caelush/security` owns. */
  readonly gate: ToolExecutionGatePort;
  /** The canonical Tool registry the executable Tool is resolved from. */
  readonly registry: Pick<AgentToolRegistry, "resolve">;
  /** The Coding overlay authority, when this host built one. */
  readonly catalog?: Pick<CodingToolCatalog, "get"> | undefined;
  /**
   * Host presentation to attach to a `REQUIRE_APPROVAL` requirement.
   *
   * The production composition returns the gate's redacted `safeAction`, which is how the approval card
   * keeps its shell-command or structural preview. The value is carried to the host's approval factory as
   * an opaque `presentation`; the Agent Core never reads it.
   */
  readonly approvalPresentation?:
    | ((
        decision: Extract<ToolExecutionGateDecision, { kind: "REQUIRE_APPROVAL" }>,
      ) => JsonObject | undefined)
    | undefined;
  /**
   * A host diagnostic hook, called with the decision and the arguments it was made about.
   *
   * Diagnostics are best effort and must never alter execution, so a throw here is swallowed by the
   * caller — but it is called *after* the decision exists, so nothing a diagnostic does can change what
   * was decided.
   */
  readonly onDecision?:
    ((decision: ToolExecutionGateDecision, request: ToolAdmissionRequest) => void) | undefined;
  /** The typed Coding Guard pipeline, already composed over the shared ControlHookRunner. */
  readonly guard?: ToolGuardPipeline | undefined;
}

export function createCodingToolAdmissionPort(
  options: CodingToolAdmissionPortOptions,
): ToolAdmissionPort {
  const codingFor = (name: ToolName): CodingToolDefinition | undefined =>
    options.catalog?.get(name);
  const metadataFor = (name: ToolName): ToolGateMetadata =>
    toolDefinitionMetadata(name, options.registry.resolve(name), codingFor(name));

  return {
    async evaluate(
      request: ToolAdmissionRequest,
      evaluationContext?: ToolAdmissionEvaluationContext,
    ): Promise<ToolPolicyDecision> {
      const metadata = metadataFor(request.toolName);
      const facts = projectFacts(codingFor(request.toolName), request.args as JsonObject);
      const guard = await evaluateGuard(options.guard, request, metadata, facts, evaluationContext);
      let decision: ToolExecutionGateDecision;
      try {
        decision = await options.gate.decide({
          invocation: toInvocationShape(request, metadata.riskLevel),
          toolName: request.toolName,
          definition: metadata,
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
      return translateDecision(decision, request, metadata, options, guard);
    },
  };
}

/**
 * The durable metadata the invocation row requires.
 *
 * ```text
 * CodingToolCatalog          the Tool's Coding metadata, when this Tool has any
 *        ↓
 * the registered AgentTool   the fallback for a Tool with no Coding overlay
 * ```
 *
 * Phase 4E made the **Coding catalog** the source of truth for a Coding Tool's `riskLevel`. The catalog
 * is the artifact the Coding product layer builds, so reading the risk from it is what makes a durable
 * `ToolInvocation` row and the policy decision about it describe the same Tool metadata — and it is what
 * stops a second Tool description from becoming a drifting authority for a value that belongs to the
 * Coding overlay.
 *
 * A generic Agent Tool — an echo tool, a plugin tool — has no Coding metadata at all. `catalog.get()`
 * returning `undefined` for it is the designed answer, not a failure, and the fallback to the Tool's own
 * declared risk is what keeps such a Tool a first-class citizen.
 *
 * A Tool that neither the catalog nor the registry can describe is refused: an identity nobody computed
 * must never authorize anything.
 */
export function createCodingToolDurableMetadataPort(options: {
  readonly registry: Pick<AgentToolRegistry, "resolve">;
  /** The Coding overlay authority, when the host has built one. */
  readonly catalog?: Pick<CodingToolCatalog, "get"> | undefined;
}): { get(toolName: ToolName): { readonly riskLevel: RiskLevel } } {
  return {
    get(toolName: ToolName): { readonly riskLevel: RiskLevel } {
      const fromCatalog = options.catalog?.get(toolName)?.security.riskLevel;
      if (fromCatalog !== undefined) return Object.freeze({ riskLevel: fromCatalog });
      const resolved = options.registry.resolve(toolName);
      if (resolved === undefined) {
        throw new ToolExecutionInfrastructureError(
          "ADMISSION",
          `Durable Tool metadata is unavailable for "${toolName}".`,
        );
      }
      return Object.freeze({ riskLevel: declaredRiskLevel(resolved.tool) });
    },
  };
}

/**
 * Wrap a gate with the durable invocation lookup the Security contract requires.
 *
 * ```text
 * ToolAdmissionRequest   identity only        the canonical, five-field view
 *        ↓
 * this port              resolve + project    the durable row the gate validates against
 *        ↓
 * the Security gate      ToolExecutionGateInput
 * ```
 *
 * It is a `ToolExecutionGatePort`, so {@link createCodingToolAdmissionPort} — which is written against
 * that contract — does not change at all. The resolver runs claim-free: it is handed the Tool name and
 * the call identity, and it answers with the durable invocation those describe.
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
    async decide(request) {
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
 * described as **opaque**, which the input-aware policy refuses — exactly what production did before the
 * move, preserved case for case.
 *
 * A Tool with no Coding overlay has no projector and therefore no facts. That is the designed answer for
 * a general Agent Tool, and the gate then applies only its metadata policy.
 */
function projectFacts(
  coding: CodingToolDefinition | undefined,
  args: JsonObject,
): ToolGateSecurityFacts | undefined {
  const projector = coding?.securityFactsProjector;
  if (projector === undefined) return undefined;
  try {
    return projector(args) as unknown as ToolGateSecurityFacts;
  } catch {
    return { resourceAccesses: [], secretScanInputs: [], opaqueInput: true };
  }
}

/**
 * The policy metadata the gate decides about.
 *
 * ```text
 * the Coding catalog's security metadata     the authority for a Coding Tool
 *        ↓ falls back to
 * the registered AgentTool's own declaration a general Agent Tool has no overlay
 *        ↓ falls back to
 * conservative absent metadata               a partially configured host, never a silent allow
 * ```
 *
 * The risk level is read from the catalog for a Coding Tool because that is where Phase 4E put it: the
 * catalog entry *is* the object the Coding product layer built, so the gate and the durable invocation
 * row cannot disagree about which Tool they are describing.
 */
function toolDefinitionMetadata(
  toolName: ToolName,
  resolved: ResolvedAgentTool | undefined,
  coding: CodingToolDefinition | undefined,
): ToolGateMetadata {
  const security = coding?.security;
  if (security !== undefined) {
    return {
      name: toolName,
      riskLevel: security.riskLevel,
      requiredCapabilities: security.requiredCapabilities,
      // The Coding overlay declares its JSON model through `@caelush/ai` and the Agent gate declares
      // its own through `@caelush/protocol`. The same structured runtime requirements, two declarations
      // of one JSON value model — the bridge crosses at the package boundary and nowhere else.
      runtimeRequirements: security.runtimeRequirements as never,
    };
  }
  return {
    name: toolName,
    riskLevel: resolved === undefined ? "LOW" : declaredRiskLevel(resolved.tool),
    requiredCapabilities: [],
    runtimeRequirements: {},
  };
}

/**
 * The risk a Tool declared when it was registered.
 *
 * A general `AgentTool` carries no `riskLevel` field — that is Coding overlay metadata, and the Agent
 * contract deliberately has none — so the declared value is read structurally and defaults to the most
 * permissive level. The default is safe because it is paired with an empty capability list: a Tool that
 * needs a capability is denied by the policy that owns that capability, not by an invented risk.
 */
function declaredRiskLevel(tool: AgentTool): RiskLevel {
  const declared = (tool as { readonly riskLevel?: unknown }).riskLevel;
  return declared === "MEDIUM" || declared === "HIGH" || declared === "CRITICAL" ? declared : "LOW";
}

/**
 * The invocation shape the Security gate validates.
 *
 * `invocation.riskLevel` restates the **definition metadata's** own risk, because the gate's first
 * invariant is that the invocation and the metadata describe the same Tool: it refuses a mismatch rather
 * than choosing one of the two. The projection is an internal consistency token for a call whose real
 * risk already decided the durable row — it never reaches durable storage, because the row was created
 * from `ToolDurableMetadataPort` before admission ran.
 *
 * Phase 4F corrected this from a hard-coded `"LOW"`. Taken literally, that constant made the adapter
 * depend on being wrapped in `createDurableInvocationGatePort`, which replaces the projection with the
 * real durable invocation: a bare `CaelushToolExecutionGate` threw a policy invariant for every non-LOW
 * Tool. The value is now consistent with the metadata in the same call, so both wirings agree.
 */
function toInvocationShape(request: ToolAdmissionRequest, riskLevel: RiskLevel) {
  return {
    id: request.identity.invocationId,
    runId: request.identity.runId,
    stepId: request.identity.sourceStepId,
    toolName: request.toolName,
    externalCallId: request.identity.externalCallId,
    args: request.args as JsonObject,
    riskLevel,
    status: "REQUESTED" as const,
    createdAt: 0 as import("@caelush/protocol").TimestampMs,
  };
}

/**
 * Translate the gate's decision into the canonical one.
 *
 * `REQUIRE_APPROVAL` is where the vocabularies differ most: the gate's decision carries presentation
 * (`safeReason`, `safeAction`) that belongs on the approval card, while the canonical requirement carries
 * an **opaque identity** plus a safe reason. The identity is computed here from the exact inputs the
 * original algorithm always used — the Tool name, its canonical risk, its sorted capabilities, its
 * runtime requirements, the private canonical arguments and the durable security context — so a grant
 * resolved before the migration still matches a key computed after it.
 *
 * The `safeAction` is not dropped — it is carried out of band by the injected
 * `ToolApprovalRequestFactory`, which rebuilds the full durable `ApprovalRequest` (risk level, title,
 * action preview, TTL, `PENDING` status) at the moment the row is created. A narrower canonical
 * requirement therefore costs the approval card nothing.
 */
function translateDecision(
  decision: ToolExecutionGateDecision,
  request: ToolAdmissionRequest,
  metadata: ToolGateMetadata,
  options: CodingToolAdmissionPortOptions,
  guard?: ToolGuardPipelineResult,
): ToolPolicyDecision {
  if (guard?.decision.kind === "BLOCK") return guardDeniedFeedback(guard.decision);
  if (decision.kind === "DENY") {
    return Object.freeze({ kind: "DENY", feedback: deniedFeedback(decision) });
  }
  const guardApproval = guard?.decision.kind === "REQUIRE_APPROVAL" ? guard.decision : undefined;
  if (decision.kind === "ALLOW" && guardApproval === undefined) {
    return Object.freeze({ kind: "ALLOW" });
  }
  const requirement: ToolApprovalRequirement = Object.freeze({
    key: computeCodingToolApprovalKey({
      toolName: request.toolName,
      security: {
        riskLevel: metadata.riskLevel,
        requiredCapabilities: metadata.requiredCapabilities,
        runtimeRequirements: metadata.runtimeRequirements,
      },
      // The canonical request speaks Protocol's JSON model; this algorithm is typed over this package's
      // one. The same arguments, two declarations of the same value model — the cast is at the package
      // boundary, and the value is hashed exactly as it arrives.
      args: request.args as never,
      securityContext: request.securityContext,
      ...(guardApproval === undefined || guard?.approvalFingerprint === undefined
        ? {}
        : { guardDecisionFingerprint: guard.approvalFingerprint }),
    }),
    reason: mergedApprovalReason(
      decision.safeReason ?? "The active policy requires review before this Tool runs.",
      guardApproval?.reason,
    ),
    requestedScope: DEFAULT_CODING_APPROVAL_SCOPE,
    ...(options.approvalPresentation === undefined
      ? {}
      : (() => {
          const presentation =
            decision.kind === "REQUIRE_APPROVAL"
              ? options.approvalPresentation(decision)
              : undefined;
          return presentation === undefined ? {} : { presentation };
        })()),
  });
  return Object.freeze({ kind: "REQUIRE_APPROVAL", requirement });
}

async function evaluateGuard(
  guard: ToolGuardPipeline | undefined,
  request: ToolAdmissionRequest,
  metadata: ToolGateMetadata,
  facts: ToolGateSecurityFacts | undefined,
  evaluationContext: ToolAdmissionEvaluationContext | undefined,
): Promise<ToolGuardPipelineResult | undefined> {
  if (guard === undefined) return undefined;
  if (evaluationContext === undefined) {
    throw new ToolExecutionInfrastructureError(
      "ADMISSION",
      "Tool Guard evaluation requires a live execution context.",
    );
  }
  const input: BeforeToolDispatchInput = {
    runId: request.identity.runId,
    sessionId: request.identity.sessionId,
    sourceStepId: request.identity.sourceStepId,
    externalCallId: request.identity.externalCallId,
    toolName: request.toolName,
    argsFingerprint: fingerprintPreparedToolArgs(request.args as JsonObject),
    safeFacts: projectSafeToolGuardFacts({
      definition: metadata,
      runtimeKind: request.environment.runtime.kind,
      ...(facts === undefined ? {} : { securityFacts: facts }),
    }),
  };
  try {
    return await guard.evaluate(input, {
      identity: { runId: request.identity.runId, sessionId: request.identity.sessionId },
      stepId: request.identity.sourceStepId,
      mode: evaluationContext.mode,
      signal: evaluationContext.signal,
    });
  } catch (error) {
    if (error instanceof ToolExecutionInfrastructureError) throw error;
    throw new ToolExecutionInfrastructureError("ADMISSION", "Tool Guard pipeline failed safely.", {
      cause: error,
    });
  }
}

function guardDeniedFeedback(
  decision: Extract<ToolGuardDecision, { kind: "BLOCK" }>,
): ToolPolicyDecision {
  return Object.freeze({
    kind: "DENY",
    feedback: Object.freeze({
      code: "PERMISSION_DENIED" as const,
      content: "Tool execution was blocked by an active extension policy.",
      details: Object.freeze({ reasonCode: decision.code }),
      disposition: "SAFE_FAILURE" as const,
    }),
  });
}

function mergedApprovalReason(coreReason: string, guardReason: string | undefined): string {
  if (guardReason === undefined) return coreReason;
  const combined = `${coreReason} Guard policy: ${guardReason}`;
  let result = "";
  let bytes = 0;
  for (const character of combined) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_MERGED_APPROVAL_REASON_BYTES) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/**
 * A policy denial as safe, model-recoverable feedback.
 *
 * The code is `PERMISSION_DENIED`, a durable `AgentError` code the invocation stores verbatim and a code
 * the model already understands. The content is a fixed sentence: a denial must never quote the rule that
 * produced it, because the rule can name a path, a command or a capability. Only the bounded `reasonCode`
 * travels in `details`, where it is host-diagnostic data.
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
