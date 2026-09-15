import type {
  AgentBudgetBlock,
  RunExecutionMode,
  ToolTurnCoordinator,
  ToolTurnRequest,
  ToolTurnResult,
  WaitingApprovalBoundary,
} from "@caelush/agent";
import type {
  ToolBatchCoordinatorPort,
  ToolBatchItem,
  ToolBatchOutcome,
  ToolBatchRequest,
  ToolBatchItemResult,
  ToolExecutionEnvironment,
  ToolSecurityContext,
} from "@caelush/tools";
import type { AgentRun, AgentState, TimestampMs } from "@caelush/protocol";

import type { AgentToolCallsDecision } from "./agent-decision.js";
import type { RunContinuationCheckpoint } from "./agent-continuation.js";
import {
  defaultObservationPolicy,
  toAgentToolResults,
  type AgentToolObservationPolicy,
} from "./agent-tool-batch.js";
import { ResourceGovernor } from "./resource-governor.js";
import { fingerprintToolBatch, fingerprintToolResultBatch } from "./resource-fingerprint.js";
import type {
  ResourceGovernancePort,
  ResourceGovernanceState,
} from "./resource-governance-port.js";
import type { RunExecutionSnapshotView as RunExecutionSnapshot } from "./run-execution-store.js";
import { RunControllerInvariantError } from "./run-controller-errors.js";
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
   */
  readonly effectiveMode: RunExecutionMode;
}

/** Everything a run-scoped Tool turn needs from its composition root. */
export interface RunToolTurnDriverDependencies {
  /** The legacy durable Tool System. The adapter drives it; it does not replace it. */
  readonly batches: ToolBatchCoordinatorPort;
  /** The durable resource ledger, when this Run's host configured a resource policy. */
  readonly resourceGovernance?: ResourceGovernancePort | undefined;
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

  const items: readonly ToolBatchItem[] = context.pendingDecision.toolRequests;
  const admission = await admitResource(dependencies, context, items.length);
  if (admission.kind === undefined) {
    // No resource policy is configured for this Run. Nothing was decided, so nothing is recorded: an
    // observation that named a decision nobody made would be a fact about work that never ran.
  } else {
    observation.resourceDecision = admission.kind;
    observation.resourceReplanCount = admission.replanCount;
  }

  if (admission.kind === "REPLAN") {
    // The model asked for more than one turn may run, or it repeated itself. Nothing is dispatched:
    // the synthetic results are the whole answer, and the durable replan accounting belongs to the
    // settlement, so a lost Run commit cannot have advanced it.
    return {
      kind: "REPLAN",
      syntheticResults: toAgentToolResults(
        context.pendingDecision.toolRequests,
        ResourceGovernor.replanResults(items),
        context.observationPolicy,
      ),
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

  const batchRequest = toToolBatchRequest(dependencies, context, items);
  const outcome =
    context.effectiveMode === "RECOVER"
      ? await dependencies.batches.recover(batchRequest)
      : await dependencies.batches.execute(batchRequest);
  return toToolTurnResult(context, observation, outcome);
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
  items: readonly ToolBatchItem[],
): ToolBatchRequest {
  return {
    // The Run's live cancellation signal, forwarded unchanged. The adapter never creates an abort
    // scope, never owns a timeout and never reads a deadline: cancellation stays a Run authority.
    signal: dependencies.signal(),
    sessionId: context.run.sessionId,
    runId: context.run.id,
    stepId: context.continuation.sourceStepId,
    environment: context.environment,
    securityContext: context.securityContext,
    items,
  };
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
  | { readonly kind: Exclude<RunToolResourceDecision, "HARD_STOP">; readonly replanCount: number }
  | {
      readonly kind: "HARD_STOP";
      readonly replanCount: number;
      readonly dimension: "TOOL_CALLS";
      readonly accounted: number;
      readonly limit: number;
    };

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

  const state = await repository.createOrGet(context.run.id, {
    policyVersion: "adaptive-resource-governance.v1",
    mode: policy.mode,
    now: dependencies.clock.now(),
  });
  const noProgress = state.consecutiveNoProgressTurns;
  const progressLevel =
    noProgress >= policy.progress.noProgressTurnsBeforeReplan
      ? "FORCED_REPLAN"
      : noProgress >= policy.progress.identicalCallNudgeThreshold
        ? "NUDGE"
        : "HEALTHY";
  const decision = new ResourceGovernor(policy).evaluateToolBatch({
    agentTurnsConsumed: context.state.usage.steps,
    toolOperationsConsumed: state.toolOperationsConsumed,
    requestedToolCalls,
    progressLevel,
    replanCount: state.replanCount,
    currentLeaseEpoch: state.leaseEpoch,
  });
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
    case "ALLOW":
    case "ALLOW_WITH_NUDGE":
    case "RENEW_AND_ALLOW":
    case "REPLAN":
    case "WAIT_FOR_RESOURCE_DECISION":
      return { kind: decision.kind, replanCount };
  }
}

/* --------------------------------------------------------------- outcomes */

function toToolTurnResult(
  context: RunToolTurnContext,
  observation: RunToolTurnObservation,
  outcome: ToolBatchOutcome,
): ToolTurnResult {
  switch (outcome.kind) {
    case "COMPLETED":
      return settleObservation(observation, "COMPLETED", outcome.results, () => ({
        kind: "COMPLETED",
        results: toAgentToolResults(
          context.pendingDecision.toolRequests,
          outcome.results,
          context.observationPolicy,
        ),
      }));
    case "WAITING_APPROVAL":
      return settleObservation(observation, "WAITING_APPROVAL", outcome.completedResults, () => ({
        kind: "WAITING_APPROVAL",
        // The partial results are deliberately *not* reported to the Run Layer: the batch is not
        // complete, so the model is shown none of it. The completed invocations are already durable in
        // the Tool ledger, and that — not a partial model message — is what recovery resumes from, so
        // an approved trailing call can never cause a completed one to run twice.
        completedResults: [],
        waiting: waitingBoundaryOf(outcome),
      }));
    case "BUDGET_EXCEEDED":
      return settleObservation(observation, "BUDGET_EXCEEDED", outcome.completedResults, () => ({
        kind: "BUDGET_EXCEEDED",
        completedResults: [],
        // The exact numbers the Tool budget authority returned. They are reported, never re-derived: a
        // Run Layer that recomputed them would be a second accounting authority.
        block: budgetBlockOf(outcome),
      }));
  }
}

function waitingBoundaryOf(
  outcome: Extract<ToolBatchOutcome, { kind: "WAITING_APPROVAL" }>,
): WaitingApprovalBoundary {
  return {
    invocationId: outcome.waiting.invocationId,
    ...(outcome.waiting.approvalId === undefined ? {} : { approvalId: outcome.waiting.approvalId }),
    externalCallId: outcome.waiting.externalCallId,
    toolName: outcome.waiting.toolName,
  };
}

function budgetBlockOf(
  outcome: Extract<ToolBatchOutcome, { kind: "BUDGET_EXCEEDED" }>,
): Extract<AgentBudgetBlock, { kind: "EXCEEDED" }> {
  return {
    kind: "EXCEEDED",
    dimension: outcome.blocked.dimension,
    accounted: outcome.blocked.accounted,
    limit: outcome.blocked.limit,
  };
}

/**
 * Record what the Tool Layer actually produced, then build the frozen result.
 *
 * The observation is the only place these facts exist: the frozen result reports what the model will
 * be told, and `executionAttempted` distinguishes a batch that ran from one that never reached the
 * Tool Layer at all.
 */
function settleObservation(
  observation: RunToolTurnObservation,
  outcome: ToolTurnResult["kind"],
  results: readonly ToolBatchItemResult[],
  build: () => ToolTurnResult,
): ToolTurnResult {
  observation.executionAttempted = true;
  observation.underlyingOutcome = outcome;
  observation.rawObservations = rawObservationsOf(results);
  return build();
}

/* ---------------------------------------------------- post-commit progress */

/**
 * Record the progress observation of one settled Tool batch.
 *
 * ```text
 * PLAN -> MATERIALIZE -> COMMIT -> NOTIFY -> this
 * ```
 *
 * It runs **after** the Run continuation is durable, and that ordering is the point: resource progress
 * accounts for work the Run *accepted*, so a settlement whose commit lost its compare-and-swap must
 * not have advanced it. The durable Tool invocations remain the recovery authority, and a later
 * recovery reads them instead of replaying a handler.
 */
export async function recordRunToolTurnProgress(input: {
  readonly dependencies: RunToolTurnDriverDependencies;
  readonly facts: RunToolTurnFacts;
  readonly results: readonly { readonly content: string; readonly isError: boolean }[];
}): Promise<void> {
  const repository = input.dependencies.resourceGovernance;
  const policy = input.facts.run.resourcePolicy;
  if (repository === undefined || policy === undefined) return;
  const current = await repository.createOrGet(input.facts.run.id, {
    policyVersion: "adaptive-resource-governance.v1",
    mode: policy.mode,
    now: input.dependencies.clock.now(),
  });
  const requestFingerprint = fingerprintToolBatch(input.facts.pendingDecision.toolRequests);
  const resultFingerprint = fingerprintToolResultBatch(input.results);
  const previous = current.recentFingerprints.at(-1);
  const exactRepeat =
    previous?.request === requestFingerprint && previous?.result === resultFingerprint;
  const now = input.dependencies.clock.now();
  await updateResourceState(input.dependencies, current, {
    ...current,
    agentTurnsConsumed: input.facts.state.usage.steps,
    toolOperationsConsumed: input.facts.state.usage.toolCalls,
    ...(exactRepeat ? {} : { lastProgressAt: now }),
    consecutiveNoProgressTurns: exactRepeat ? current.consecutiveNoProgressTurns + 1 : 0,
    resourceGuardState: exactRepeat ? "NUDGE" : "NONE",
    recentFingerprints: [
      ...current.recentFingerprints,
      { request: requestFingerprint, result: resultFingerprint },
    ].slice(-64),
    revision: current.revision + 1,
    updatedAt: now,
  });
}

/**
 * Record one resource replan against the durable ledger.
 *
 * `REPLAN` writes no Tool invocation at all, so the ledger entry is the *only* durable trace of the
 * decision — and it is what a later `WAITING_RESOURCE` checkpoint reports as `replanCount`.
 */
export async function recordRunToolTurnReplan(input: {
  readonly dependencies: RunToolTurnDriverDependencies;
  readonly facts: RunToolTurnFacts;
}): Promise<void> {
  const repository = input.dependencies.resourceGovernance;
  const policy = input.facts.run.resourcePolicy;
  if (repository === undefined || policy === undefined) return;
  const current = await repository.createOrGet(input.facts.run.id, {
    policyVersion: "adaptive-resource-governance.v1",
    mode: policy.mode,
    now: input.dependencies.clock.now(),
  });
  await updateResourceState(input.dependencies, current, {
    ...current,
    replanCount: current.replanCount + 1,
    resourceGuardState: "REPLAN_REQUIRED",
    revision: current.revision + 1,
    updatedAt: input.dependencies.clock.now(),
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
