import { createHash } from "node:crypto";
import type {
  AgentBudgetBlock,
  AgentToolResult,
  ModelToolFeedbackProjector,
  ProjectedToolFeedback,
  RunExecutionMode,
  ToolBatchCoordinator,
  ToolBatchItemOutcome,
  ToolBatchOutcome,
  ToolBatchRequest,
  ToolCallRequest,
  ToolExecutionEnvironment,
  ToolResultBatchNormalizer,
  ToolSecurityContext,
  ToolTurnCoordinator,
  ToolTurnRequest,
  ToolPreparationFailureFact,
  ToolTurnResult,
  WaitingApprovalBoundary,
} from "@caelush/agent";
import { fingerprintProjection, isModelRejectedCall, modelRejectedArgumentsFeedback } from "@caelush/agent";
import type { ToolBatchCall } from "@caelush/agent";
import {
  AttachmentModelContentReferenceSchema,
  MAX_ATTACHMENT_MODEL_CONTENT_REFERENCES,
} from "@caelush/protocol";
import type { AttachmentModelContentReference } from "@caelush/protocol";
import type { AgentRun, AgentState, TimestampMs } from "@caelush/protocol";
import type { ResourceCorrectionDeliveryRecord } from "@caelush/protocol";

import type { AgentToolCallsDecision } from "./agent-decision.js";
import type { RunContinuationCheckpoint } from "./agent-continuation.js";
import { defaultObservationPolicy, type AgentToolObservationPolicy } from "./agent-tool-batch.js";
import { ResourceGovernor } from "./resource-governor.js";
import { fingerprintToolBatch, fingerprintToolResultBatch } from "./resource-fingerprint.js";
import type {
  ResourceGovernancePort,
  ResourceGovernanceState,
  ResourceProgressBoundary,
} from "./resource-governance-port.js";
import type { RunExecutionSnapshotView as RunExecutionSnapshot } from "./run-execution-store.js";
import type { RunToolFeedbackProjection } from "./run-message-materializer.js";
import {
  describePatternFields as describeSemanticFields,
  preparationFailureFactFromRejection,
  resourceProgressTurn,
} from "./resource-progress-classifier.js";
import {
  acknowledgeResourceReplan,
  acknowledgeV1ResourceNudge,
  applyResourceProgressTurn,
  decideResourceSemanticIntervention,
  emptyResourceSemanticProgress,
  findResourceProgressPattern,
  recordResourceNudgeDelivery,
  resourceProgressPolicyFrom,
  type ResourceCorrectionStage,
  type ResourceSemanticProgress,
} from "./resource-progress-projection.js";
import {
  RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_ID,
  RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_VERSION,
  resourceGovernanceCorrectionContextItemId,
} from "./resource-governance-context-identity.js";
import {
  assertCorrectionRecoveryBelongsToRun,
  createLegacyCorrectionRecoveryRecord,
  type ResourceCorrectionRecoveryPolicy,
} from "./legacy-correction-recovery.js";
import { RunControllerInvariantError } from "./run-controller-errors.js";
import { toTextOnlyAIToolResultContent } from "./ai-message-content.js";
import type { ToolFeedbackContributionApplier } from "./run-controller-ports.js";
import {
  createRunToolTurnObservation,
  rawObservationsOf,
  type RunToolResourceDecision,
  type RunToolTurnObservation,
} from "./run-tool-turn-observation.js";
import { semanticEqual } from "./semantic-equality.js";
import { createToolSecurityContext } from "./tool-security-context.js";

/**
 * The run-scoped Tool turn adapter.
 *
 * ```text
 * frozen ToolTurnRequest            a general contract: which batch, and is it fresh or recovered
 *        +
 * captured Run-scoped host facts    workspace, Runtime, security context, resource policy
 *        ↓
 * the existing durable Tool System  ToolBatchCoordinator over the real Dispatcher
 *        ↓
 * frozen ToolTurnResult             the model-facing answer, and nothing else
 * ```
 *
 * The frozen request deliberately knows no workspace, no Runtime, no permission profile, no approval
 * policy and no resource policy. Every one of those is a fact about *this host and this Run*, and the
 * legacy `ToolBatchCoordinator` needs all of them — so they are **captured** here, at the boundary
 * that already holds them, rather than added to the general contract. A `ToolTurnRequest` that carried
 * a workspace would make every general Agent host describe one.
 *
 * The adapter owns the three host facts the frozen result cannot carry, and reports them through the
 * Core-private {@link RunToolTurnObservation} instead:
 *
 * ```text
 * the effective entry mode   RECOVER may strengthen EXECUTE; it is never downgraded
 * the resource decision      REPLAN, WAIT and HARD_STOP never reach the Tool Layer at all
 * the raw observations       only their projection is model-facing
 * ```
 *
 * It is also the *only* object that translates the frozen Tool turn contract into a legacy
 * `ToolBatchRequest`. {@link captureRunToolTurnFacts} is exported for that reason: the Run Layer needs
 * the same captured facts for its post-commit resource observation, and it may not rebuild a security
 * context, an execution environment or an observation policy for itself.
 */

/** The host facts one Tool turn runs with, captured from a durable Run. */
export interface RunToolTurnFacts {
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly stateRevision: number;
  readonly continuationRevision: number;
  readonly continuation: Extract<
    RunContinuationCheckpoint,
    { readonly type: "WAITING_TOOL_RESULTS" }
  >;
  readonly pendingDecision: AgentToolCallsDecision;
  readonly observationPolicy: AgentToolObservationPolicy;
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
}

/** The captured facts plus the entry mode the caller decided on. */
export interface RunToolTurnContext extends RunToolTurnFacts {
  /**
   * How this batch is actually entered.
   *
   * ```text
   * EXECUTE  a fresh batch, dispatched for the first time
   * RECOVER  a batch that may already be durable, settled through the restart-aware path
   * ```
   *
   * This is Phase 7C's exactly-once protection, carried forward. A durable `RUNNING` invocation must
   * be recovered and never re-dispatched, and only the layer that knows *why* it is driving can say
   * which of the two this is — so it is threaded in explicitly rather than read off the frozen
   * directive, which says which batch is next and not whether its work already happened.
   *
   * Phase 4D kept this fact and changed only what consumes it: it no longer selects
   * `execute()` versus `recover()` on the batch, because the durable coordinator owns per-call
   * recovery. It is still validated, still recorded in the Core-private observation, and still the
   * entry mode the caller declared.
   */
  readonly effectiveMode: RunExecutionMode;
  /** The canonical model feedback projector, bound with the host Context token projection. */
  readonly feedback: ModelToolFeedbackProjector;
  /** The canonical Tool Result batch integrity defense. */
  readonly normalizer: ToolResultBatchNormalizer;
}

/** Everything a run-scoped Tool turn needs from its composition root. */
export interface RunToolTurnDriverDependencies {
  /** The canonical Tool Batch scheduling authority. The adapter drives it; it does not replace it. */
  readonly batches: ToolBatchCoordinator;
  /**
   * The canonical model feedback projector.
   *
   * It is constructed with the host Context runtime's token-projection implementation, so the one
   * observation-budget algorithm is owned by the Agent Tool layer together with the model
   * feedback semantics.
   */
  readonly feedback: ModelToolFeedbackProjector;
  /** The canonical Tool Result batch integrity defense. */
  readonly normalizer: ToolResultBatchNormalizer;
  /** Optional host-owned contribution pass over observation-backed safe feedback. */
  readonly feedbackContributions?: ToolFeedbackContributionApplier;
  /** The durable resource ledger, when this Run's host configured a resource policy. */
  readonly resourceGovernance?: ResourceGovernancePort | undefined;
  readonly resourceCorrectionRecoveryPolicy?: ResourceCorrectionRecoveryPolicy | undefined;
  readonly clock: { now(): TimestampMs };
  /**
   * The Run's own cancellation signal.
   *
   * It is read at execution time rather than captured, because a Run's scope is created when its
   * execution begins and the adapter must forward the signal that is live, unchanged.
   */
  readonly signal: () => AbortSignal;
  /**
   * The host Context runtime's observation policy.
   *
   * A compatibility fallback for a `WAITING_TOOL_RESULTS` checkpoint written before the durable policy
   * existed. It is never consulted when the checkpoint carries one.
   */
  readonly hostObservationPolicy?: (() => AgentToolObservationPolicy | undefined) | undefined;
}

/** One resolved Tool turn: the facts it runs in, and the coordinator bound to them. */
export interface ResolvedRunToolTurn {
  readonly context: RunToolTurnContext;
  readonly observation: RunToolTurnObservation;
  readonly coordinator: ToolTurnCoordinator;
}

/**
 * The run-scoped Tool turn driver.
 *
 * It is resolved per directive, from the durable snapshot the coordinator decided from, so it can
 * never be handed a batch belonging to a different Run, Step or decision.
 */
export interface RunToolTurnDriver {
  /**
   * Capture the facts one Tool turn runs in and bind a coordinator to them.
   *
   * The entry mode is the caller's fact, not a derivation. Only the layer that knows *why* it is
   * driving can say whether a batch is fresh, and a durable `RUNNING` invocation must be recovered
   * rather than dispatched a second time.
   */
  resolve(snapshot: RunExecutionSnapshot, requestedMode: RunExecutionMode): ResolvedRunToolTurn;
}

/**
 * Capture the Run-scoped facts of the Tool batch a snapshot is waiting on.
 *
 * ```text
 * durable snapshot        the Run, its AgentState, the open Tool continuation
 *        ↓
 * captured facts          workspace, Runtime, security context, observation policy, decision
 * ```
 *
 * This is the one place those facts are derived, so a post-commit observation and an execution can
 * never disagree about which policy a batch was projected under or which policy the Run was allowed to
 * run it with. A snapshot that is not waiting on a Tool continuation has no facts to capture, and that
 * is reported as `undefined` rather than as an empty answer.
 */
export function captureRunToolTurnFacts(input: {
  readonly snapshot: RunExecutionSnapshot;
  readonly hostObservationPolicy?: (() => AgentToolObservationPolicy | undefined) | undefined;
}): RunToolTurnFacts | undefined {
  const state = input.snapshot.state;
  const continuation = input.snapshot.continuation;
  if (state === undefined || continuation?.type !== "WAITING_TOOL_RESULTS") return undefined;
  return {
    run: input.snapshot.run,
    state,
    stateRevision: input.snapshot.stateRevision ?? 0,
    continuationRevision: input.snapshot.continuationRevision ?? 0,
    continuation,
    pendingDecision: continuation.pendingDecision,
    observationPolicy: resolveToolObservationPolicy(continuation, input.hostObservationPolicy),
    environment: {
      workspace: input.snapshot.run.workspace,
      runtime: input.snapshot.run.runtime,
    },
    securityContext: createToolSecurityContext(input.snapshot.run, state),
  };
}

/**
 * Create the run-scoped Tool turn driver factory.
 *
 * The returned function is the composition seam: the RunController hands it a durable snapshot and the
 * entry mode it already knows, and receives a coordinator that speaks the frozen Tool turn contract
 * over the legacy Tool System named by {@link RunToolTurnDriverDependencies.batches}.
 */
export function createRunToolTurnDriverFactory(
  dependencies: RunToolTurnDriverDependencies,
): (snapshot: RunExecutionSnapshot, requestedMode: RunExecutionMode) => ResolvedRunToolTurn {
  return (snapshot, requestedMode) => {
    const facts = captureRunToolTurnFacts({
      snapshot,
      ...(dependencies.hostObservationPolicy === undefined
        ? {}
        : { hostObservationPolicy: dependencies.hostObservationPolicy }),
    });
    if (facts === undefined) {
      throw new RunControllerInvariantError(
        "Tool execution requires an AgentState and an open WAITING_TOOL_RESULTS continuation.",
      );
    }
    // `RECOVER` strengthens `EXECUTE` and never the other way round: a caller that knows this batch
    // may already be durable outranks a directive that only says this batch is next.
    const context: RunToolTurnContext = {
      ...facts,
      effectiveMode: requestedMode === "RECOVER" ? "RECOVER" : "EXECUTE",
      feedback: dependencies.feedback,
      normalizer: dependencies.normalizer,
    };
    const observation = createRunToolTurnObservation({ effectiveMode: context.effectiveMode });
    return {
      context,
      observation,
      coordinator: {
        execute: (request) => executeRunToolTurn(dependencies, context, observation, request),
      },
    };
  };
}

/**
 * The observation policy a Tool projection runs under.
 *
 * ```text
 * durable continuation policy   the authority, and the only durable one
 * host Context runtime policy   the pre-Phase-3D behaviour, for a legacy checkpoint
 * the legacy default            a host that configured no Context policy at all
 * ```
 *
 * A checkpoint that carries a policy is projected under exactly that policy, so a restart that changed
 * the Context configuration cannot retroactively re-truncate a batch the model already asked for.
 */
function resolveToolObservationPolicy(
  continuation: Extract<RunContinuationCheckpoint, { readonly type: "WAITING_TOOL_RESULTS" }>,
  hostObservationPolicy: (() => AgentToolObservationPolicy | undefined) | undefined,
): AgentToolObservationPolicy {
  const durable = continuation.observationPolicy;
  if (durable !== undefined) return durable;
  return hostObservationPolicy?.() ?? defaultObservationPolicy();
}

/* ------------------------------------------------------------ execution */

/**
 * Execute one frozen Tool turn request.
 *
 * ```text
 * verify the request against the durable continuation
 *        ↓
 * resource admission                     (before the first handler)
 *        ↓
 * Tool Layer execute / recover           (the only Tool execution boundary)
 *        ↓
 * observation projection
 *        ↓
 * frozen ToolTurnResult
 * ```
 *
 * The request's identity is **verified against this Run's durable state**, never trusted:
 * `sourceStepId` and the whole pending decision — tool call count, every `externalCallId`, every
 * `toolName` and the argument order — are compared with the continuation the adapter captured. A
 * request that does not match is refused rather than executed, because a mismatched identity would
 * attach this Run's Tool invocation to another Step's decision.
 */
async function executeRunToolTurn(
  dependencies: RunToolTurnDriverDependencies,
  context: RunToolTurnContext,
  observation: RunToolTurnObservation,
  request: ToolTurnRequest,
): Promise<ToolTurnResult> {
  assertRequestMatchesContext(request, context);

  const requests = context.pendingDecision.toolRequests;
  const admission = await admitResource(dependencies, context, requests.length);
  if (admission.kind === undefined) {
    // No resource policy is configured for this Run. Nothing was decided, so nothing is recorded: an
    // observation that named a decision nobody made would be a fact about work that never ran.
  } else {
    observation.resourceDecision = admission.kind;
    observation.resourceReplanCount = admission.replanCount;
    if (admission.kind !== "HARD_STOP" && admission.correction !== undefined) {
      observation.resourceCorrection = admission.correction;
    }
  }

  if (admission.kind === "REPLAN") {
    // The model asked for more than one turn may run, or it repeated itself. Nothing is dispatched: the
    // synthetic results are the whole answer, and the durable replan accounting belongs to the
    // settlement, so a lost Run commit cannot have advanced it.
    return {
      kind: "REPLAN",
      syntheticResults: await replanResults(dependencies, context, observation, admission),
    };
  }
  if (admission.kind === "WAIT_FOR_RESOURCE_DECISION") {
    return { kind: "RESOURCE_WAIT", reason: "NO_PROGRESS" };
  }
  if (admission.kind === "HARD_STOP") {
    return {
      kind: "BUDGET_EXCEEDED",
      completedResults: [],
      block: {
        kind: "EXCEEDED",
        dimension: admission.dimension,
        accounted: admission.accounted,
        limit: admission.limit,
      },
    };
  }

  const batchRequest = toToolBatchRequest(dependencies, context);
  // `ToolTurnRequest.mode` remains a Run Layer entry fact — it is validated, recorded in the Core-private
  // observation and never deleted — but it no longer selects an entry point. The durable coordinator
  // performs a lookup by `(runId, sourceStepId, externalCallId)` on every call, so a fresh batch and a
  // recovered batch are both entered through the canonical `execute()` and each individual call's
  // fresh-or-recover decision is made against durable truth.
  //
  // An abort during the batch arrives as a throw, and it is deliberately *not* caught: the Run Layer's
  // `executeToolBatchDirective` already routes `executionSignal.aborted` to its cancellation authority,
  // and a Tool System that converted the abort into a result would be making a Run decision.
  const outcome = await dependencies.batches.execute(batchRequest);
  return toToolTurnResult(context, observation, outcome, dependencies);
}

/**
 * The synthetic results of a resource REPLAN.
 *
 * ```text
 * the resource governor's own message   safe, bounded, generated by the governor
 *        ↓
 * ModelToolFeedbackProjector            the same projection every other Tool result goes through
 *        ↓
 * ToolResultBatchNormalizer             the same integrity defense
 * ```
 *
 * `REPLAN` is not a Tool batch outcome, so it never reaches the canonical Batch: no Tool ran and no
 * durable row exists. It still owes the model one result per call, and it discharges that through the
 * identical projector and normalizer — which is what keeps one model-feedback authority rather than a
 * REPLAN-shaped second one.
 */
async function replanResults(
  dependencies: RunToolTurnDriverDependencies,
  context: RunToolTurnContext,
  observation: RunToolTurnObservation,
  admission: Extract<ResourceAdmission, { kind: "REPLAN" }>,
): Promise<readonly AgentToolResult[]> {
  const calls = callsOf(context);
  const messages = ResourceGovernor.replanResultsFor(
    calls.filter((call) => !isModelRejectedCall(call)),
    admission.replanReason,
    { requested: admission.requestedToolCalls, limit: admission.batchLimit },
  );
  let index = 0;
  const items: ToolBatchItemOutcome[] = calls.map((call) => {
    if (isModelRejectedCall(call)) {
      // A rejected request keeps the feedback about its own arguments: the replan says nothing about
      // them, and replacing it would hide the correction the model still owes.
      return Object.freeze({
        kind: "MODEL_REJECTED" as const,
        call,
        feedback: modelRejectedArgumentsFeedback(call),
      });
    }
    const message = messages[index];
    index += 1;
    return {
      kind: "REJECTED" as const,
      call,
      feedback: {
        code: "RESOURCE_REPLAN_REQUIRED",
        content: message?.content ?? "",
        details: {},
        disposition: "SAFE_FAILURE" as const,
      },
    };
  });
  const projected = await projectAndNormalize(dependencies, context, observation, calls, items);
  return projected.map(({ message }) => ({
    externalCallId: message.toolCallId,
    toolName: message.toolName,
    content: toTextOnlyAIToolResultContent(message.content),
    isError: message.isError,
  }));
}

/** Refuse a request whose identity is not this Run's durable batch. */
function assertRequestMatchesContext(request: ToolTurnRequest, context: RunToolTurnContext): void {
  if (request.sourceStepId !== context.continuation.sourceStepId) {
    throw new RunControllerInvariantError(
      "A Tool turn request named a source Step the Run's Tool continuation does not.",
    );
  }
  if (!semanticEqual(request.pendingDecision, context.pendingDecision)) {
    throw new RunControllerInvariantError(
      "A Tool turn request carried a Tool decision the Run's Tool continuation does not.",
    );
  }
  const durablePolicy = context.continuation.observationPolicy;
  if (
    request.observationPolicy !== undefined &&
    durablePolicy !== undefined &&
    !semanticEqual(request.observationPolicy, durablePolicy)
  ) {
    throw new RunControllerInvariantError(
      "A Tool turn request carried an observation policy the Run's Tool continuation does not.",
    );
  }
}

function toToolBatchRequest(
  dependencies: RunToolTurnDriverDependencies,
  context: RunToolTurnContext,
): ToolBatchRequest {
  return {
    // The Run's live cancellation signal, forwarded unchanged. The adapter never creates an abort
    // scope, never owns a timeout and never reads a deadline: cancellation stays a Run authority.
    signal: dependencies.signal(),
    sessionId: context.run.sessionId,
    runId: context.run.id,
    sourceStepId: context.continuation.sourceStepId,
    calls: callsOf(context),
    environment: context.environment,
    securityContext: context.securityContext,
  };
}

/**
 * The model's Tool requests, projected onto the Tool Layer's canonical call shape.
 *
 * ```text
 * externalCallId  carried unchanged — never regenerated
 * toolName        carried unchanged
 * args            carried unchanged, and absent for a rejected request
 * order           assistant source order, preserved exactly
 * ```
 *
 * The order comes from the assistant message, because that is the only record of how the model
 * interleaved valid and rejected requests. The two decision arrays are the *sets*; the message is the
 * *sequence*. Reading the sequence from anywhere else would let a result answer a call at the wrong
 * position.
 *
 * The identity is the load-bearing part: `(runId, sourceStepId, externalCallId)` is what decides whether
 * a call has already run, so a projection that minted a new id would make every recovery look like a
 * fresh batch.
 */
function callsOf(context: RunToolTurnContext): readonly ToolBatchCall[] {
  const decision = context.pendingDecision;
  const rejectedById = new Map(
    (decision.rejectedToolRequests ?? []).map((request) => [request.externalCallId, request]),
  );
  const executableById = new Map(
    decision.toolRequests.map((request) => [request.externalCallId, request]),
  );
  const ordered: ToolBatchCall[] = [];
  for (const part of decision.modelTurn.assistantMessage.content) {
    if (part.type === "tool-call") {
      const request = executableById.get(part.toolCallId);
      if (request === undefined) {
        throw new RunControllerInvariantError(
          "A Tool continuation announced a call that its decision does not contain.",
        );
      }
      executableById.delete(part.toolCallId);
      ordered.push({
        externalCallId: request.externalCallId,
        toolName: request.toolName,
        args: request.args,
      });
      continue;
    }
    if (part.type === "tool-call-rejected") {
      const request = rejectedById.get(part.toolCallId);
      if (request === undefined) {
        // A rejected part whose decision entry is missing is a broken continuation, not an ordinary
        // argument error: there is no result to give and no invocation that could have run.
        throw new RunControllerInvariantError(
          "A Tool continuation announced a rejected call that its decision does not contain.",
        );
      }
      rejectedById.delete(part.toolCallId);
      ordered.push({
        externalCallId: request.externalCallId,
        toolName: request.toolName,
        issue: { code: request.issue.code, argumentBytes: request.issue.argumentBytes },
      });
    }
  }
  if (executableById.size > 0 || rejectedById.size > 0) {
    throw new RunControllerInvariantError(
      "A Tool continuation decision contains requests its assistant message does not announce.",
    );
  }
  return ordered;
}

/* ------------------------------------------------------ resource admission */

/**
 * What the resource governor decided about one batch.
 *
 * The `HARD_STOP` arm carries the exact dimension, accounted count and limit the resource authority
 * reported, so the budget settlement reports them rather than re-deriving them.
 */
type ResourceAdmission =
  | { readonly kind: undefined }
  | {
      readonly kind: "REPLAN";
      readonly replanCount: number;
      /** The reason the governor actually returned; the model feedback names it. */
      readonly replanReason: "BATCH_TOO_LARGE" | "NO_PROGRESS";
      readonly requestedToolCalls: number;
      readonly batchLimit: number;
      readonly correction?: RunToolCorrection | undefined;
    }
  | {
      readonly kind: Exclude<RunToolResourceDecision, "HARD_STOP" | "REPLAN">;
      readonly replanCount: number;
      /** The corrective advice this admission produced, when it produced one. */
      readonly correction?: RunToolCorrection | undefined;
    }
  | {
      readonly kind: "HARD_STOP";
      readonly replanCount: number;
      readonly dimension: "TOOL_CALLS";
      readonly accounted: number;
      readonly limit: number;
    };

/** A corrective intervention this admission decided to tell the model about. */
export interface RunToolCorrection {
  readonly interventionId: string;
  readonly stage: ResourceCorrectionStage;
  readonly patternKey: string;
  readonly toolName: string;
  readonly code: string;
  readonly occurrences: number;
  readonly guidance: string;
  readonly sourceStepId: string;
}

/**
 * The strongest progress signal the Run has, without inventing a new lifecycle state.
 *
 * A semantic decision is evidence about *this* Tool, gathered from accepted results; the counter
 * based level is evidence about the Run as a whole. The stronger of the two wins, and the existing
 * governor still owns what each level means. `WAITING_RESOURCE` is only ever raised from semantic
 * evidence under the V1 discipline, so a long but productive Run cannot reach it — and under V2 the
 * semantic projection never produces it at all.
 */
function semanticProgressLevel(
  decision: ReturnType<typeof decideResourceSemanticIntervention>,
  fallback: "HEALTHY" | "NUDGE" | "FORCED_REPLAN",
): "HEALTHY" | "NUDGE" | "FORCED_REPLAN" | "WAITING_RESOURCE" {
  switch (decision.kind) {
    case "WAITING_RESOURCE":
      return "WAITING_RESOURCE";
    case "REPLAN":
      return "FORCED_REPLAN";
    case "NUDGE":
      return fallback === "HEALTHY" ? "NUDGE" : fallback;
    default:
      return fallback;
  }
}

/**
 * A reminder that names the mistake instead of asking the model to reflect.
 *
 * It quotes only what the schema declared - the Tool, the stable rejection code, how many times it
 * happened and which fields were wrong - and states the part that matters most: nothing ran. The
 * later rungs say what to change about the *approach*, because by then the fields have been named
 * once and repeating that sentence would be noise.
 */
function semanticGuidanceFor(
  decision: Extract<ReturnType<typeof decideResourceSemanticIntervention>, { kind: "NUDGE" }>,
  progress: ResourceSemanticProgress | undefined,
): string {
  const pattern =
    progress === undefined ? undefined : findResourceProgressPattern(progress, decision.patternKey);
  const fields = describeSemanticFields(pattern?.fields ?? []);
  const counts = `The last ${String(decision.occurrences)} calls to ${decision.toolName} were rejected before execution with ${decision.code}: ${fields}. Nothing was executed.`;
  switch (decision.stage) {
    case "INPUT_CORRECTION":
      return (
        `${counts} Use the declared argument shape from the Tool guidance and change exactly these fields; ` +
        `if the call still cannot be formed, choose a different approach.`
      );
    case "REVIEW_APPROACH":
      return (
        `${counts} The corrected argument shape has already been described and the same rejection continues. ` +
        `Re-read the current goal and the step you are on, restate what you are trying to observe, and ` +
        `choose a different call or a different Tool rather than resending this one.`
      );
    case "REBUILD_WORK_STATE":
      return (
        `${counts} This has now survived two specific corrections. Before the next call, update the plan ` +
        `with what you currently understand, which requirement is still unmet, and the single next action — ` +
        `then send one call that can actually be formed. Do not resend the rejected call.`
      );
  }
}

/** The newest accepted batch identity in a window, used as an episode boundary. */
function lastTurnId(progress: ResourceSemanticProgress): string | undefined {
  return progress.turns.at(-1)?.turnId;
}

/**
 * Admit a Tool batch against the Run's resource policy.
 *
 * The order is the contract and is preserved exactly:
 *
 * ```text
 * EXECUTE_TOOL_BATCH
 *        ↓
 * resource admission      ← here, before the first Tool handler
 *        ↓
 * Tool execution
 * ```
 *
 * `RENEW_AND_ALLOW` commits its lease through the ledger's compare-and-swap *before* the batch is
 * allowed to run, so a lease that could not be renewed never becomes an execution.
 */
async function admitResource(
  dependencies: RunToolTurnDriverDependencies,
  context: RunToolTurnContext,
  requestedToolCalls: number,
): Promise<ResourceAdmission> {
  const policy = context.run.resourcePolicy;
  const repository = dependencies.resourceGovernance;
  if (policy === undefined || repository === undefined) return { kind: undefined };

  let effectivePolicy = policy;
  const canUpgradeHistoricalPolicy =
    policy.correctionVersion !== "AUTONOMOUS_CORRECTION_V2" &&
    dependencies.resourceCorrectionRecoveryPolicy !== undefined;
  let state = await repository.createOrGet(context.run.id, {
    policyVersion:
      policy.correctionVersion === "AUTONOMOUS_CORRECTION_V2" || canUpgradeHistoricalPolicy
        ? "adaptive-resource-governance.v2"
        : "adaptive-resource-governance.v1",
    mode: policy.mode,
    now: dependencies.clock.now(),
  });
  if (state.correctionRecovery !== undefined) {
    assertCorrectionRecoveryBelongsToRun(context.run.id, state.correctionRecovery);
    effectivePolicy = { ...policy, correctionVersion: "AUTONOMOUS_CORRECTION_V2" };
  } else if (canUpgradeHistoricalPolicy) {
    const now = dependencies.clock.now();
    const recovery = createLegacyCorrectionRecoveryRecord({
      runId: context.run.id,
      sourceStepId: String(context.continuation.sourceStepId),
      stateRevision: context.stateRevision,
      continuationRevision: context.continuationRevision,
      committedAt: now,
      authority: dependencies.resourceCorrectionRecoveryPolicy!.authority,
    });
    state = await repository.compareAndSwap(context.run.id, state.revision, {
      ...state,
      policyVersion: "adaptive-resource-governance.v2",
      correctionRecovery: recovery,
      revision: state.revision + 1,
      updatedAt: now,
    });
    effectivePolicy = { ...policy, correctionVersion: "AUTONOMOUS_CORRECTION_V2" };
  }
  const progressPolicy = resourceProgressPolicyFrom(effectivePolicy);
  const noProgress = state.consecutiveNoProgressTurns;
  const semantic = state.semanticProgress;
  const semanticDecision = decideResourceSemanticIntervention(
    progressPolicy,
    semantic ?? emptyResourceSemanticProgress(),
  );
  const progressLevel = semanticProgressLevel(
    semanticDecision,
    noProgress >= effectivePolicy.progress.noProgressTurnsBeforeReplan
      ? "FORCED_REPLAN"
      : noProgress >= effectivePolicy.progress.identicalCallNudgeThreshold
        ? "NUDGE"
        : "HEALTHY",
  );
  const semanticGuidance =
    semanticDecision.kind === "NUDGE" ? semanticGuidanceFor(semanticDecision, semantic) : undefined;
  const decision = new ResourceGovernor(effectivePolicy).evaluateToolBatch({
    cumulativeAgentTurns: context.state.usage.steps,
    cumulativeToolOperations: state.toolOperationsConsumed,
    turnsInLease: leaseDelta(context.state.usage.steps, state.leaseStartAgentTurns),
    toolsInLease: leaseDelta(state.toolOperationsConsumed, state.leaseStartToolCalls),
    requestedToolCalls,
    progressLevel,
    replanCount: state.replanCount,
    currentLeaseEpoch: state.leaseEpoch,
    ...(semanticGuidance === undefined ? {} : { guidance: semanticGuidance }),
    ...(semanticDecision.kind === "NUDGE" ? { correctionStage: semanticDecision.stage } : {}),
  });
  const correction = await recordCorrectionAtAdmission({
    dependencies,
    state,
    semantic,
    semanticDecision,
    decision,
    guidance: semanticGuidance,
    sourceStepId: String(context.continuation.sourceStepId),
  });
  if (decision.kind === "REPLAN" && semanticDecision.kind === "REPLAN" && semantic !== undefined) {
    // The re-plan is being produced now, so this is the moment the episode advances. Counting it at
    // record time would advance an episode that a cancellation might never have reached.
    const acknowledged = acknowledgeResourceReplan(semantic, lastTurnId(semantic));
    await updateResourceState(dependencies, state, {
      ...state,
      semanticProgress: acknowledged,
      revision: state.revision + 1,
      updatedAt: dependencies.clock.now(),
    });
  }
  if (decision.kind === "RENEW_AND_ALLOW") {
    await updateResourceState(dependencies, state, {
      ...state,
      leaseEpoch: decision.nextLeaseEpoch,
      leaseStartAgentTurns: context.state.usage.steps,
      leaseStartToolCalls: state.toolOperationsConsumed,
      resourceGuardState: "NONE",
      revision: state.revision + 1,
      updatedAt: dependencies.clock.now(),
    });
  }
  // The count is read from the state the decision was made against, which is the same durable number
  // `WAITING_RESOURCE` has always persisted. The frozen `RESOURCE_WAIT` result carries a reason and
  // nothing else, so this observation is its only authority.
  const replanCount = (await repository.get(context.run.id))?.replanCount ?? state.replanCount;
  switch (decision.kind) {
    case "HARD_STOP":
      // The exact numbers the resource authority returned, reported and never re-derived.
      return {
        kind: "HARD_STOP",
        replanCount,
        dimension: decision.dimension,
        accounted: decision.accounted,
        limit: decision.limit,
      };
    case "REPLAN":
      return {
        kind: "REPLAN",
        replanCount,
        replanReason: decision.reason,
        requestedToolCalls: decision.requestedToolCalls,
        batchLimit: effectivePolicy.batch.maxToolCallsPerTurn,
        ...(correction === undefined ? {} : { correction }),
      };
    case "ALLOW":
    case "ALLOW_WITH_NUDGE":
    case "RENEW_AND_ALLOW":
    case "WAIT_FOR_RESOURCE_DECISION":
      return {
        kind: decision.kind,
        replanCount,
        ...(correction === undefined ? {} : { correction }),
      };
  }
}

/**
 * `cumulative - leaseStart`, floored at zero.
 *
 * A lease start that is somehow ahead of the cumulative count is a corrupt ledger, and refusing to go
 * negative keeps the *lease* from wrapping into an immediate renewal. It cannot happen through the
 * writers in this file; it is floored so that a corrupted row degrades into "this lease has not
 * started spending yet" rather than into a renewal storm.
 */
function leaseDelta(cumulative: number, leaseStart: number): number {
  return Math.max(0, cumulative - leaseStart);
}

/**
 * Persist the corrective intervention this admission produced, once.
 *
 * ```text
 * detected at admission   the guidance exists and is about to be offered
 * delivered at settlement  a model request built from a Context carrying it settled
 * ```
 *
 * Writing it here is what makes it *reachable*: the Run's Context authority reads this ledger on every
 * turn, so the advice is in the next request instead of being a value a function returned and a caller
 * dropped. Writing it only once — keyed by the intervention identity — keeps a recovered or retried
 * admission from appending a second copy of the same advice.
 */
async function recordCorrectionAtAdmission(input: {
  readonly dependencies: RunToolTurnDriverDependencies;
  readonly state: ResourceGovernanceState;
  readonly semantic: ResourceSemanticProgress | undefined;
  readonly semanticDecision: ReturnType<typeof decideResourceSemanticIntervention>;
  readonly decision: ReturnType<ResourceGovernor["evaluateToolBatch"]>;
  readonly guidance: string | undefined;
  readonly sourceStepId: string;
}): Promise<RunToolCorrection | undefined> {
  if (input.semanticDecision.kind !== "NUDGE" || input.guidance === undefined) return undefined;
  // Only an admission that actually offers the advice records it. A hard stop, a wait or a re-plan
  // dispatched nothing, and recording advice for a batch that never ran would describe work nobody did.
  if (input.decision.kind !== "ALLOW_WITH_NUDGE") return undefined;
  const decision = input.semanticDecision;
  const episodeId =
    input.semantic?.active?.episodeId ??
    `${decision.patternKey}:${input.semantic?.turns.at(-1)?.turnId ?? input.sourceStepId}`;
  const interventionId = createHash("sha256")
    .update(
      JSON.stringify([
        episodeId,
        decision.stage,
        decision.deliveredInterventions,
        input.sourceStepId,
      ]),
      "utf8",
    )
    .digest("hex");
  const correction: RunToolCorrection = Object.freeze({
    interventionId,
    stage: decision.stage,
    patternKey: decision.patternKey,
    toolName: decision.toolName,
    code: decision.code,
    occurrences: decision.occurrences,
    guidance: input.guidance,
    sourceStepId: input.sourceStepId,
  });
  const semantic = input.semantic;
  if (semantic === undefined) return correction;
  if (semantic.correction?.interventionId === interventionId) return correction;
  await updateResourceState(input.dependencies, input.state, {
    ...input.state,
    semanticProgress: Object.freeze({
      ...semantic,
      correction: {
        interventionId,
        stage: decision.stage,
        patternKey: decision.patternKey,
        toolName: decision.toolName,
        code: decision.code,
        occurrences: decision.occurrences,
        guidance: input.guidance,
        sourceStepId: input.sourceStepId,
        episodeId,
        sourceBoundaryId: input.sourceStepId,
      },
    }),
    revision: input.state.revision + 1,
    updatedAt: input.dependencies.clock.now(),
  });
  return correction;
}

/* --------------------------------------------------------------- outcomes */

/**
 * Map one canonical Batch outcome onto the frozen Tool turn result.
 *
 * ```text
 * COMPLETED         projector -> normalizer -> frozen COMPLETED
 * WAITING_APPROVAL  stop before the trailing calls; no partial model result
 * BUDGET_EXCEEDED   stop; no partial model result
 * CANCELLED         never a ToolTurnResult — Run cancellation authority owns it
 * ```
 *
 * ## Why a cancelled batch does not become a result
 *
 * The frozen `ToolTurnResult` has five discriminants and `CANCELLED` is not one of them; adding it would
 * change a Phase 3 contract, and its absence is deliberate. Cancellation is a **Run** authority, so:
 *
 * ```text
 * signal aborted      the run-scoped abort is allowed to propagate to
 *                     `executeToolBatchDirective`, which already routes `executionSignal.aborted` to
 *                     `finalizeAbortedExecution` — the Tool System never writes a Run status
 * signal not aborted  fail closed, because the frozen Tool turn has no safe arm to express a cancelled
 *                     batch under a live signal, and every available forgery (COMPLETED, an error Tool
 *                     result, an automatic Run cancel) would invent an authority
 * ```
 */
async function toToolTurnResult(
  context: RunToolTurnContext,
  observation: RunToolTurnObservation,
  outcome: ToolBatchOutcome,
  dependencies: RunToolTurnDriverDependencies,
): Promise<ToolTurnResult> {
  switch (outcome.kind) {
    case "COMPLETED":
      return settleObservation(observation, "COMPLETED", outcome.items, async () =>
        completedToolTurnResult(dependencies, context, observation, outcome),
      );
    case "WAITING_APPROVAL":
      return settleObservation(observation, "WAITING_APPROVAL", outcome.items, async () => ({
        kind: "WAITING_APPROVAL",
        // The partial item outcomes are deliberately *not* reported to the Run Layer: the batch is not
        // complete, so the model is shown none of it. The completed invocations are already durable in
        // the Tool ledger, and that — not a partial model message — is what recovery resumes from, so an
        // approved trailing call can never cause a completed one to run twice.
        completedResults: [],
        waiting: waitingBoundaryOf(outcome),
      }));
    case "BUDGET_EXCEEDED":
      return settleObservation(observation, "BUDGET_EXCEEDED", outcome.items, async () => ({
        kind: "BUDGET_EXCEEDED",
        completedResults: [],
        // The exact numbers the Tool budget authority returned. They are reported, never re-derived: a
        // Run Layer that recomputed them would be a second accounting authority.
        block: budgetBlockOf(outcome),
      }));
    case "CANCELLED":
      // `CANCELLED` is only ever reported on an aborted signal, and that case never reaches here: the
      // adapter rethrows the run-scoped abort before this mapping runs. A batch that cancelled itself
      // while the Run's signal says execution is still wanted is a contradiction with no safe arm in
      // the frozen result, so it fails closed.
      throw new RunControllerInvariantError(
        `Tool batch reported CANCELLED (${String(outcome.items.length)} final item(s)) with a live Run signal.`,
      );
  }
}

/**
 * Build the frozen `COMPLETED` result from a complete canonical batch.
 *
 * ```text
 * ToolBatchOutcome.COMPLETED
 *        ↓
 * ModelToolFeedbackProjector.project({ calls, items, policy })
 *        ↓
 * AIToolResultMessage[]                    the safe, token-bounded model view
 *        ↓
 * ToolResultBatchNormalizer.normalize({ requests, results })
 *        ↓
 * normalized ordered AIToolResultMessage[] the final identity/order/integrity defense
 * ```
 *
 * The projector *builds* the safe view and the normalizer *proves* it. Neither reads a durable
 * observation on the other's behalf, and the normalizer is never asked to recover a missing result.
 *
 * The last step is a one-field-wide compatibility conversion onto the frozen Phase 3
 * `AgentToolResult`. It does **not** truncate, sanitize, read an observation or reorder: the safe
 * projection already happened, and a second pass here would be a second projection authority.
 */
async function completedToolTurnResult(
  dependencies: RunToolTurnDriverDependencies,
  context: RunToolTurnContext,
  observation: RunToolTurnObservation,
  outcome: Extract<ToolBatchOutcome, { kind: "COMPLETED" }>,
): Promise<ToolTurnResult> {
  const calls = callsOf(context);
  const projected = await projectAndNormalize(
    dependencies,
    context,
    observation,
    calls,
    outcome.items,
  );
  return {
    kind: "COMPLETED",
    results: projected.map(({ message, preparationFailure }) => ({
      externalCallId: message.toolCallId,
      toolName: message.toolName,
      content: toTextOnlyAIToolResultContent(message.content),
      isError: message.isError,
      ...(preparationFailure === undefined ? {} : { preparationFailure }),
    })),
  };
}

/**
 * Run the single feedback projection and the single batch normalizer, retaining the same ordered
 * wrapper objects for the Core-private durable materializer. The wrapper is never widened into the
 * public ToolTurnResult: receipts and observation identity belong to the durable message boundary.
 */
async function projectAndNormalize(
  dependencies: RunToolTurnDriverDependencies,
  context: RunToolTurnContext,
  observation: RunToolTurnObservation,
  calls: readonly ToolBatchCall[],
  items: readonly ToolBatchItemOutcome[],
): Promise<readonly RunToolFeedbackProjection[]> {
  const projected = context.feedback.project({
    calls,
    items,
    policy: context.observationPolicy,
  });
  const contributed =
    dependencies.feedbackContributions === undefined
      ? projected
      : await dependencies.feedbackContributions.apply({
          runId: context.run.id,
          sessionId: context.run.sessionId,
          sourceStepId: context.continuation.sourceStepId,
          mode: context.effectiveMode,
          signal: dependencies.signal(),
          items,
          projected,
        });
  assertFeedbackContributionInvariants(projected, contributed);
  const normalized = context.normalizer.normalize({
    requests: calls,
    results: contributed.map(({ message }) => message),
  });
  const attachmentReferences = attachmentReferencesByCall(items);
  const preparationFailures = preparationFailuresByCall(items);
  const byCallId = new Map(projected.map((item) => [item.message.toolCallId, item] as const));
  const ordered = normalized.map((message) => {
    const item = byCallId.get(message.toolCallId);
    if (item === undefined) {
      throw new RunControllerInvariantError(
        "The normalized Tool feedback lost the projection receipt for a requested call.",
      );
    }
    const fingerprint = fingerprintProjection([message]);
    const withMessage =
      fingerprint === item.receipt.fingerprint && item.message === message
        ? item
        : {
            ...item,
            message,
            receipt: Object.freeze({ ...item.receipt, fingerprint }),
          };
    const references = message.isError ? undefined : attachmentReferences.get(message.toolCallId);
    const preparationFailure = preparationFailures.get(message.toolCallId);
    return Object.freeze({
      ...withMessage,
      ...(references === undefined || references.length === 0
        ? {}
        : { attachmentReferences: references }),
      ...(preparationFailure === undefined ? {} : { preparationFailure }),
    }) satisfies RunToolFeedbackProjection;
  });
  observation.projectedFeedback = Object.freeze(ordered);
  return observation.projectedFeedback;
}

/**
 * The trusted preparation-failure fact of every refused call in this batch.
 *
 * Only `REJECTED` items qualify. A `SKIPPED` call was never prepared, and a synthetic replan result
 * never reached the Tool Layer at all, so neither can become evidence that the model repeated a
 * schema mistake.
 */
function preparationFailuresByCall(
  items: readonly ToolBatchItemOutcome[],
): ReadonlyMap<string, ToolPreparationFailureFact> {
  const byCall = new Map<string, ToolPreparationFailureFact>();
  for (const item of items) {
    if (item.kind !== "REJECTED") continue;
    const fact = preparationFailureFactFromRejection(item.feedback);
    if (fact !== undefined) byCall.set(item.call.externalCallId, fact);
  }
  return byCall;
}

/** Keep only bounded, schema-checked image pointers from successful real observations. */
function attachmentReferencesByCall(
  items: readonly ToolBatchItemOutcome[],
): ReadonlyMap<string, readonly AttachmentModelContentReference[]> {
  const referencesByCall = new Map<string, readonly AttachmentModelContentReference[]>();
  for (const item of items) {
    if (item.kind !== "OBSERVATION" || item.observation.isError) continue;
    const value = item.observation.details?.["imageReferences"];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_MODEL_CONTENT_REFERENCES) {
      throw new RunControllerInvariantError(
        "A successful Tool observation carried invalid attachment image references.",
      );
    }
    try {
      const references = Object.freeze(
        value.map((reference) => AttachmentModelContentReferenceSchema.parse(reference)),
      );
      if (references.length > 0) {
        referencesByCall.set(item.call.externalCallId, references);
      }
    } catch {
      throw new RunControllerInvariantError(
        "A successful Tool observation carried invalid attachment image references.",
      );
    }
  }
  return referencesByCall;
}

function assertFeedbackContributionInvariants(
  projected: readonly ProjectedToolFeedback[],
  contributed: readonly ProjectedToolFeedback[],
): void {
  if (projected.length !== contributed.length) {
    throw new RunControllerInvariantError(
      "The Tool feedback contribution pass changed the requested result count.",
    );
  }
  const baselineByCallId = new Map(
    projected.map((item) => [item.message.toolCallId, item] as const),
  );
  for (const candidate of contributed) {
    const baseline = baselineByCallId.get(candidate.message.toolCallId);
    if (
      baseline === undefined ||
      baseline.message.toolName !== candidate.message.toolName ||
      baseline.message.isError !== candidate.message.isError ||
      baseline.observation.kind !== candidate.observation.kind ||
      (baseline.observation.kind === "OBSERVATION" &&
        candidate.observation.kind === "OBSERVATION" &&
        baseline.observation.observationId !== candidate.observation.observationId)
    ) {
      throw new RunControllerInvariantError(
        "The Tool feedback contribution pass changed Tool execution truth.",
      );
    }
  }
}

/**
 * Refuse a cancelled batch that the Run's own signal does not explain.
 *
 * The abort case never reaches here: it propagates out of the canonical batch call so the Run Layer's
 * existing cancellation path settles the Run. This function is only for the contradiction — a batch that
 * cancelled itself while the Run's signal says execution is still wanted — and it fails closed. A Run
 * that silently treated this as `COMPLETED` would hand the model a batch it never received; one that
 * treated it as a Tool error would tell the model a Tool failed when nothing ran; one that cancelled the
 * Run would forge a decision only the user or the deadline may make.
 */

function waitingBoundaryOf(
  outcome: Extract<ToolBatchOutcome, { kind: "WAITING_APPROVAL" }>,
): WaitingApprovalBoundary {
  return {
    // The approval owns the invocation it is about; the pending call owns the model-facing identity.
    invocationId: outcome.approval.toolInvocationId,
    approvalId: outcome.approval.id,
    externalCallId: outcome.pendingCall.externalCallId,
    toolName: outcome.pendingCall.toolName,
  };
}

function budgetBlockOf(
  outcome: Extract<ToolBatchOutcome, { kind: "BUDGET_EXCEEDED" }>,
): Extract<AgentBudgetBlock, { kind: "EXCEEDED" }> {
  const block = outcome.block;
  if (block.kind !== "EXCEEDED") {
    // The frozen `ToolTurnResult.BUDGET_EXCEEDED` carries the accounting of an exhausted budget. An
    // `UNAVAILABLE` block is a *different* statement — enforcement could not be established — and the
    // Run Layer reports it through its own budget error path rather than as a spent budget.
    throw new RunControllerInvariantError(
      "Tool budget enforcement was unavailable rather than exhausted.",
    );
  }
  return {
    kind: "EXCEEDED",
    dimension: block.dimension,
    accounted: block.accounted,
    limit: block.limit,
  };
}

/**
 * Record what the Tool Layer actually produced, then build the frozen result.
 *
 * The observation is the only place these facts exist: the frozen result reports what the model will be
 * told, and `executionAttempted` distinguishes a batch that ran from one that never reached the Tool
 * Layer at all.
 */
async function settleObservation(
  observation: RunToolTurnObservation,
  outcome: ToolTurnResult["kind"],
  items: readonly ToolBatchItemOutcome[],
  build: () => Promise<ToolTurnResult>,
): Promise<ToolTurnResult> {
  observation.executionAttempted = true;
  observation.underlyingOutcome = outcome;
  observation.rawObservations = rawObservationsOf(items);
  return build();
}

/* ---------------------------------------------------- post-commit progress */

/** Project progress from the exact batch the same Run transaction is about to accept. */
export async function projectRunToolTurnProgress(input: {
  readonly dependencies: RunToolTurnDriverDependencies;
  readonly facts: RunToolTurnFacts;
  /** The durable identity of this batch: the Step that requested it. */
  readonly turnId: string;
  readonly boundary: ResourceProgressBoundary;
  readonly replan: boolean;
  /** A transactionally staged ledger row, for callers accepting a first legacy-upgrade boundary. */
  readonly baseProgress?: ResourceGovernanceState | undefined;
  readonly results: readonly {
    readonly toolName: string;
    readonly isError: boolean;
    readonly content?: string;
    readonly preparationFailure?: ToolPreparationFailureFact | undefined;
  }[];
}): Promise<
  | {
      readonly expectedProgressRevision: number | null;
      readonly nextProgress: ResourceGovernanceState;
    }
  | undefined
> {
  const repository = input.dependencies.resourceGovernance;
  const policy = input.facts.run.resourcePolicy;
  if (repository === undefined || policy === undefined) return undefined;
  const loaded = input.baseProgress ?? (await repository.get(input.facts.run.id));
  if (loaded?.correctionRecovery !== undefined) {
    assertCorrectionRecoveryBelongsToRun(input.facts.run.id, loaded.correctionRecovery);
  }
  const progressPolicy = resourceProgressPolicyFrom(
    loaded?.correctionRecovery === undefined
      ? policy
      : { ...policy, correctionVersion: "AUTONOMOUS_CORRECTION_V2" },
  );
  const now = input.dependencies.clock.now();
  const current: ResourceGovernanceState =
    loaded ??
    Object.freeze({
      runId: input.facts.run.id,
      policyVersion:
        policy.correctionVersion === "AUTONOMOUS_CORRECTION_V2"
          ? "adaptive-resource-governance.v2"
          : "adaptive-resource-governance.v1",
      mode: policy.mode,
      leaseEpoch: 1,
      leaseStartAgentTurns: 0,
      leaseStartToolCalls: 0,
      agentTurnsConsumed: 0,
      toolOperationsConsumed: 0,
      consecutiveNoProgressTurns: 0,
      replanCount: 0,
      resourceGuardState: "NONE",
      recentFingerprints: Object.freeze([]),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
  if (
    current.lastAcceptedBoundary?.sourceStepId === input.boundary.sourceStepId &&
    current.lastAcceptedBoundary.kind === input.boundary.kind
  ) {
    const sameMessages =
      JSON.stringify(current.lastAcceptedBoundary.messageIds) ===
      JSON.stringify(input.boundary.messageIds);
    if (!sameMessages) {
      throw new RunControllerInvariantError("Accepted progress boundary identity was reused.");
    }
    return undefined;
  }
  const requestFingerprint = fingerprintToolBatch(input.facts.pendingDecision.toolRequests);
  const resultFingerprint = fingerprintToolResultBatch(
    input.results.map((result) => ({
      content: result.content ?? "",
      isError: result.isError,
    })),
  );
  const previous = current.recentFingerprints.at(-1);
  const exactRepeat =
    previous?.request === requestFingerprint && previous?.result === resultFingerprint;

  // The semantic window is a projection of accepted results, folded once per batch identity. A
  // repeated post-commit update after a crash finds its own turn already recorded and changes
  // nothing, so evidence cannot be counted twice.
  const turn = resourceProgressTurn({ turnId: input.turnId, results: input.results });
  const semantic =
    turn === undefined
      ? current.semanticProgress
      : applyResourceProgressTurn(
          progressPolicy,
          current.semanticProgress ?? emptyResourceSemanticProgress(),
          turn,
        );
  const decision = decideResourceSemanticIntervention(
    progressPolicy,
    semantic ?? emptyResourceSemanticProgress(),
  );
  // Under V1 a reminder is acknowledged when it is recorded, because the counter *is* the reminder
  // state and V1 has no delivery channel of its own. Under V2 the ladder advances only when a model
  // request that carried the advice settles — so recording a result here must leave it alone, or the
  // same detection would be recorded as a delivery before it was ever delivered.
  const withAcknowledgement =
    decision.kind === "NUDGE" && semantic !== undefined && progressPolicy.correctionVersion === "V1"
      ? acknowledgeV1ResourceNudge(semantic)
      : semantic;

  const nextProgress: ResourceGovernanceState = {
    ...current,
    lastAcceptedBoundary: input.boundary,
    agentTurnsConsumed: input.facts.state.usage.steps,
    toolOperationsConsumed: input.facts.state.usage.toolCalls,
    ...(exactRepeat ? {} : { lastProgressAt: now }),
    consecutiveNoProgressTurns: exactRepeat ? current.consecutiveNoProgressTurns + 1 : 0,
    resourceGuardState: semanticGuardState(decision, exactRepeat),
    recentFingerprints: [
      ...current.recentFingerprints,
      { request: requestFingerprint, result: resultFingerprint },
    ].slice(-64),
    ...(withAcknowledgement === undefined ? {} : { semanticProgress: withAcknowledgement }),
    replanCount: current.replanCount + (input.replan ? 1 : 0),
    revision: loaded === null ? 0 : current.revision + 1,
    updatedAt: now,
  };
  return Object.freeze({
    expectedProgressRevision: loaded?.revision ?? null,
    nextProgress: Object.freeze(nextProgress),
  });
}

/** The durable guard label a semantic decision corresponds to. */
function semanticGuardState(
  decision: ReturnType<typeof decideResourceSemanticIntervention>,
  exactRepeat: boolean,
): ResourceGovernanceState["resourceGuardState"] {
  switch (decision.kind) {
    case "WAITING_RESOURCE":
      return "WAITING_RESOURCE";
    case "REPLAN":
      return "REPLAN_REQUIRED";
    case "NUDGE":
      return "NUDGE";
    default:
      return exactRepeat ? "NUDGE" : "NONE";
  }
}

/**
 * Record one resource replan against the durable ledger.
 *
 * `REPLAN` writes no Tool invocation at all, so the ledger entry is the *only* durable trace of the
 * decision — and it is what a later `WAITING_RESOURCE` checkpoint reports as `replanCount`.
 */
/**
 * Record that one model turn settled with a corrective intervention in its Context.
 *
 * ```text
 * prepared at admission   the advice is in the ledger, and the next Context carries it
 * delivered here          a model result bound to a Context that carried it committed
 * ```
 *
 * It runs **after** the assistant message is durable, and the ordering is deliberate: a request that
 * failed, was cancelled or never started did not deliver anything, and advancing the ladder for it
 * would spend an escalation step on a message the model never saw. The write is idempotent by
 * intervention identity and fails in the safe direction — if it is lost, the same advice is offered
 * again rather than silently retired.
 *
 * The Step check is what makes "this request" precise: the correction was prepared from the evidence of
 * Step S, so only a *later* Step's settlement can be the request that carried it. A settlement of S
 * itself (which cannot happen after admission, but is cheap to exclude) is not a delivery.
 */
export async function projectRunResourceCorrectionDelivery(input: {
  readonly repository: ResourceGovernancePort | undefined;
  readonly run: AgentRun;
  readonly result: Extract<
    import("@caelush/agent").AgentLoopAdvanceResult,
    { readonly kind: "TOOL_REQUESTS" | "FINAL_CANDIDATE" }
  >;
  readonly assistantMessageId: string;
  readonly now: TimestampMs;
}): Promise<
  | {
      readonly expectedProgressRevision: number | null;
      readonly nextProgress: ResourceGovernanceState;
    }
  | undefined
> {
  const repository = input.repository;
  const policy = input.run.resourcePolicy;
  if (repository === undefined || policy === undefined) return undefined;
  const current = await repository.get(input.run.id);
  const correction = current?.semanticProgress?.correction;
  const sources = input.result.context.selectedContextSources ?? [];
  const provider = sources.find(
    (source) =>
      source.providerId === RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_ID &&
      source.providerVersion === RESOURCE_GOVERNANCE_CORRECTION_PROVIDER_VERSION,
  );
  if (
    current === null ||
    correction === undefined ||
    correction.guidance.length === 0 ||
    correction.sourceStepId === String(input.result.turn.stepId) ||
    provider === undefined ||
    input.result.context.contextFingerprint === undefined ||
    !/^(?:sha256:)?[a-f0-9]{64}$/u.test(input.result.context.contextFingerprint)
  ) {
    return undefined;
  }
  const selectedSourceItemId = resourceGovernanceCorrectionContextItemId(correction.interventionId);
  if (!provider.selectedItemIds.includes(selectedSourceItemId)) return undefined;
  const contextArtifactId =
    input.result.context.contextArtifactId ?? input.result.context.contextFingerprint;
  if (contextArtifactId.length === 0 || contextArtifactId.length > 256) return undefined;

  const receipt: ResourceCorrectionDeliveryRecord = Object.freeze({
    interventionId: correction.interventionId,
    episodeId:
      correction.episodeId ??
      `${correction.patternKey}:${correction.sourceBoundaryId ?? correction.sourceStepId}`,
    consumerStepId: String(input.result.turn.stepId),
    contextArtifactId,
    contextFingerprint: input.result.context.contextFingerprint,
    selectedSourceItemId,
    selectedSourceProviderId: provider.providerId,
    selectedSourceProviderVersion: provider.providerVersion,
    callId: input.result.modelTurn.callId,
    assistantMessageId: input.assistantMessageId,
    createdAt: input.now,
  });
  const delivered = recordResourceNudgeDelivery(current.semanticProgress!, receipt);
  if (delivered === current.semanticProgress) return undefined;
  return Object.freeze({
    expectedProgressRevision: current.revision,
    nextProgress: Object.freeze({
      ...current,
      policyVersion:
        policy.correctionVersion === "AUTONOMOUS_CORRECTION_V2"
          ? "adaptive-resource-governance.v2"
          : "adaptive-resource-governance.v1",
      semanticProgress: delivered,
      lastAcceptedBoundary: {
        kind: "MODEL_TURN" as const,
        sourceStepId: String(input.result.turn.stepId),
        messageIds: Object.freeze([input.assistantMessageId]),
      },
      revision: current.revision + 1,
      updatedAt: input.now,
    }),
  });
}

async function updateResourceState(
  dependencies: RunToolTurnDriverDependencies,
  current: ResourceGovernanceState,
  next: ResourceGovernanceState,
): Promise<void> {
  const repository = dependencies.resourceGovernance;
  if (repository === undefined) return;
  await repository.compareAndSwap(current.runId, current.revision, next);
}
