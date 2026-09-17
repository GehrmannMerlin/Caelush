import type { LLMToolResultMessage } from "@caelush/llm/messages";
import {
  createAgentDecisionClassifier,
  createRunExecutionCoordinator,
  createRunExecutionDriver,
  createRunTransitionPlanner,
  type AdvanceAgentDirective,
  type AgentLoopAdvanceResult,
  type AgentLoopFailedResult,
  type CompletionGateDecision,
  type EvaluateCompletionDirective,
  type ExecuteToolBatchDirective,
  type ModelRequestAdmissionPort,
  type RunExecutionCoordinator,
  type RunExecutionEffectResult,
  type RunExecutionMode,
  type RunTransitionPlanner,
  type ToolTurnResult,
} from "@caelush/agent";
import { ToolBatchInputError, type ToolBatchCoordinatorPort } from "@caelush/tools";
import {
  AgentRunSchema,
  ApprovalResolutionSchema,
  createTimestampMs,
  type ApprovalRequestId,
  type AgentRun,
  type AgentError,
  type AgentState,
  type AgentStep,
  type RunId,
  type StepId,
} from "@caelush/protocol";
import {
  beginAgentStepState,
  cancelAgentStepState,
  createInitialAgentState,
  markAgentStateCancelled,
  markAgentStateWaitingResource,
  markAgentStateMaxStepsReached,
  markAgentStateBudgetExceeded,
  markAgentStateVerifying,
  resumeAgentStateFromApproval,
  resumeAgentStateFromResource,
  settleAgentStepState,
  resumeAgentStateFromVerificationRepair,
  startAgentState,
} from "./agent-state.js";
import { cancelAgentStep, completeAgentStep, failAgentStep } from "./agent-step.js";
import { normalizeToolResultBatch } from "./agent-tool-results.js";
import type { AgentToolObservationPolicy } from "./agent-tool-batch.js";
import {
  markAgentRunFailed,
  markAgentRunCancelled,
  markAgentRunTimedOut,
  markAgentRunBudgetExceeded,
  markAgentRunWaitingResource,
  resumeAgentRunFromVerificationRepair,
  resumeAgentRunFromApproval,
  resumeAgentRunFromResource,
  markAgentStateFailed,
  assertRunExecutionInvariant,
} from "./run-execution-state.js";
import { markAgentStateTimedOut } from "./agent-state.js";
import { RunExecutionScopeRegistry } from "./run-execution-scope.js";
import { RunDeadlineRegistry } from "./run-deadline-registry.js";
import { semanticEqual } from "./semantic-equality.js";
import { deriveRunDeadline, isRunDeadlineExceeded } from "./run-deadline.js";
import { resolveRunTerminationAuthority } from "./run-termination-authority.js";
import { toAgentExecutionSnapshot } from "./run-execution-facts.js";
import {
  createAgentModelTurnBoundary,
  createAgentTurnObservation,
  createObservingModelTurnExecutor,
  requiresBoundaryRepair,
  type AgentTurnObservation,
  type PendingAgentTurn,
} from "./run-model-turn-boundary.js";
import {
  createRunCommitEventMaterializer,
  type RunCommitEventMaterializer,
} from "./run-commit-event-materializer.js";
import { classifyAgentEffectSettlement } from "./run-agent-effect-settlement.js";
import type { AgentProviderTurnState } from "./agent-loop-ports.js";
import {
  MISROUTED_COMPLETION_GATE,
  MISROUTED_TOOL_TURN_COORDINATOR,
} from "./run-agent-deferred-ports.js";
import {
  createRunCandidateBoundaryPlanner,
  createRunCompletionGate,
  CompletionGateIdentityError,
  type RunCompletionGate,
} from "./run-completion-gate.js";
import type { RunCompletionGateDependencies } from "./run-completion-context.js";
import type { CompletionGateObservation } from "./run-completion-observation.js";
import {
  classifyCompletionEffectSettlement,
  type CompletionEffectSettlementRoute,
} from "./run-completion-effect-settlement.js";
import type {
  RunCandidateBoundaryCommit,
  RunCompletionPersistencePort,
} from "./run-completion-store.js";
import {
  captureRunToolTurnFacts,
  createRunToolTurnDriverFactory,
  recordRunToolTurnProgress,
  recordRunToolTurnReplan,
  type ResolvedRunToolTurn,
  type RunToolTurnDriverDependencies,
} from "./run-tool-turn-coordinator.js";
import { classifyToolEffectSettlement } from "./run-tool-effect-settlement.js";
import type { RunToolTurnObservation } from "./run-tool-turn-observation.js";
import {
  RunControllerBusyError,
  RunControllerConflictError,
  RunControllerInfrastructureError,
  RunControllerInputError,
  RunControllerInvariantError,
} from "./run-controller-errors.js";
import { allocateRunAgentStep, createRunAgentLoop } from "./run-agent-execution.js";
import { projectRunAgentHistory } from "./run-agent-history.js";
import { summarizeAgentDecision } from "./agent-summary.js";
import {
  RunExecutionConflictError,
  RunExecutionInvariantError,
  type RunExecutionCommitView as RunExecutionCommit,
  type RunExecutionSnapshotView as RunExecutionSnapshot,
} from "./run-execution-store.js";
import { RetryController } from "./retry-controller.js";
import { RunRetryRegistry } from "./run-retry-registry.js";
import type {
  DurableAgentEvent,
  DurableEventDraft,
  RunExecutionCommitResult,
} from "./run-execution-store.js";
import type { CompletionEventEvidence } from "./run-commit-event-materializer.js";
import type { RunControllerResult } from "./run-controller-input.js";
import {
  createRunControllerEventFactory,
  type RunControllerEventFactory,
} from "./run-controller-events.js";
import type { RunControllerDependencies } from "./run-controller-ports.js";
import { TaskAcceptanceReviewer } from "./task-acceptance-reviewer.js";
import { toDurableRetryCode } from "./ai-invocation-projection.js";
import type { AgentBudgetBlock } from "./agent-errors.js";
import { compileVerificationRepairContext } from "@caelush/verification";

export {
  RunControllerBusyError,
  RunControllerConflictError,
  RunControllerInfrastructureError,
  RunControllerInputError,
  RunControllerInvariantError,
};

/**
 * The single-Tool-turn guard the Agent driver is constructed with.
 *
 * The frozen `RunExecutionDriver` requires all three collaborators, and the Agent path of this
 * controller drives exactly one directive kind. Reaching this port means a Tool directive was
 * routed into an Agent turn — which would be a second Tool execution authority — so it refuses
 * loudly instead of approximating work nobody performed.
 */
const MISROUTED_AGENT_LOOP: import("@caelush/agent").AgentLoop = {
  async advance(): Promise<never> {
    throw new RunControllerInvariantError(
      "An AgentLoop was driven for a Tool directive; the Run Layer owns Tool execution.",
    );
  },
};

/**
 * The model descriptor one Tool turn's effect context carries.
 *
 * The frozen effect context is a general Reason's context and requires a resolved model, but a Tool
 * effect resolves no model and the driver reads none of it. Supplying the Run's own `ModelRef` with
 * a minimal, truthful limit pair keeps the value *about* this Run rather than fabricated, and the
 * non-zero limits keep it a legal descriptor.
 */
function unresolvedToolTurnModel(ref: AgentRun["model"]): import("@caelush/ai").ModelDescriptor {
  return {
    ref,
    api: "caelush.none",
    limits: { contextWindowTokens: 1, maxOutputTokens: 1 },
    capabilities: {
      streaming: "UNKNOWN",
      toolCalling: "UNKNOWN",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    source: "FALLBACK",
  };
}

/**
 * How a stale in-flight Step is explained.
 *
 * A `RUNNING` Step that a restart interrupted has no known outcome: the provider may or may not
 * have answered. It is settled once as an internal error rather than resent, because resending it
 * would be a second provider turn for one durable attempt.
 */
const STALE_STEP_ERROR = {
  code: "INTERNAL_ERROR" as const,
  message: "An in-flight agent step was interrupted before durable settlement.",
  retryable: false,
  phase: "RUNTIME" as const,
};

/** What one driven Tool directive produced. Exactly one arm is set. */
type ToolBatchDirectiveExecution =
  | { readonly result: ToolTurnResult; readonly observation: RunToolTurnObservation }
  | { readonly aborted: RunControllerResult }
  | { readonly failed: RunControllerResult };

/**
 * Whether a driven Tool directive produced a frozen result to settle.
 *
 * The three arms are told apart by an explicit guard rather than by reading an optional field: the
 * execution either has a frozen result, or the termination authority already settled it, or it
 * already failed — and there is no fourth state to guess at.
 */
function isToolTurnResult(
  execution: ToolBatchDirectiveExecution,
): execution is Extract<ToolBatchDirectiveExecution, { readonly result: ToolTurnResult }> {
  return "result" in execution;
}

/** How one Tool effect settles. */
type ToolEffectSettlement =
  | { readonly kind: "SNAPSHOT"; readonly snapshot: RunExecutionSnapshot }
  | { readonly kind: "RESULT"; readonly result: RunControllerResult };

/** One resolved completion evaluation: the gate and the facts it was assembled from. */
interface ResolvedCompletionGate {
  readonly completion: RunCompletionGate;
  readonly dependencies: RunCompletionGateDependencies;
}

/** What one driven completion directive produced. Exactly one arm is set. */
type CompletionDirectiveExecution =
  | {
      readonly decision: CompletionGateDecision;
      readonly observation: CompletionGateObservation;
    }
  | { readonly outcome: RunControllerResult };

/**
 * Whether a driven completion directive produced a decision to settle.
 *
 * Told apart by an explicit guard rather than by reading an optional field: the evaluation either has
 * a decision, or the termination authority already settled the Run.
 */
function isCompletionDecision(
  execution: CompletionDirectiveExecution,
): execution is Extract<
  CompletionDirectiveExecution,
  { readonly decision: CompletionGateDecision }
> {
  return "decision" in execution;
}

/**
 * The model descriptor one completion effect's context carries.
 *
 * The frozen `RunExecutionEffectContext` is a general Reason's context and requires a resolved model,
 * but a completion evaluation resolves no model and the driver reads none of it. Supplying the Run's own
 * `ModelRef` with a minimal, truthful limit pair keeps the value *about* this Run rather than
 * fabricated.
 */
function unresolvedCompletionModel(ref: AgentRun["model"]): import("@caelush/ai").ModelDescriptor {
  return {
    ref,
    api: "caelush.none",
    limits: { contextWindowTokens: 1, maxOutputTokens: 1 },
    capabilities: {
      streaming: "UNKNOWN",
      toolCalling: "UNKNOWN",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
      promptCaching: "UNKNOWN",
      usageReporting: "UNKNOWN",
    },
    source: "FALLBACK",
  };
}

export class RunController {
  private readonly activeRuns = new Set<RunId>();
  private readonly scopes: RunExecutionScopeRegistry;
  private readonly deadlineRegistry: RunDeadlineRegistry;
  private readonly retryRegistry: RunRetryRegistry;
  private readonly retryController: RetryController;
  private readonly eventFactory: RunControllerEventFactory;
  /**
   * The durable Run execution coordinator.
   *
   * Phase 3C made "what does durable execution do next" a pure, deterministic decision that is
   * separate from "who makes it durable". The coordinator plans; this controller is still the only
   * object that commits a lifecycle transition.
   */
  private readonly coordinator: RunExecutionCoordinator;
  /**
   * The frozen transition planner.
   *
   * Phase 3C checkpoint 5 made this the settlement authority for every Agent effect the frozen
   * contract can express. It is pure: it describes the transition, it never writes one, and this
   * controller remains the only object that commits.
   */
  private readonly transitionPlanner: RunTransitionPlanner;
  /**
   * The transitional event boundary for a planned commit.
   *
   * The planner owns no `EventId` factory, so it plans `events: []` and this fills them in. It may
   * change nothing else, and it runs between planning and committing.
   */
  private readonly eventMaterializer: RunCommitEventMaterializer;

  constructor(private readonly dependencies: RunControllerDependencies) {
    this.eventFactory = createRunControllerEventFactory();
    this.scopes = dependencies.scopes ?? new RunExecutionScopeRegistry();
    this.deadlineRegistry =
      dependencies.deadlineRegistry ?? new RunDeadlineRegistry({ clock: dependencies.clock });
    this.retryRegistry =
      dependencies.retryRegistry ?? new RunRetryRegistry({ clock: dependencies.clock });
    this.coordinator = dependencies.coordinator ?? createRunExecutionCoordinator();
    this.transitionPlanner = dependencies.transitionPlanner ?? createRunTransitionPlanner();
    this.eventMaterializer =
      dependencies.eventMaterializer ??
      createRunCommitEventMaterializer({ eventFactory: this.eventFactory });
    this.retryController = new RetryController({
      ...(dependencies.retryPolicy === undefined ? {} : { policy: dependencies.retryPolicy }),
      ...(dependencies.retryJitter === undefined ? {} : { jitter: dependencies.retryJitter }),
    });
  }

  dispose(): void {
    this.deadlineRegistry.dispose();
    this.retryRegistry.dispose();
  }

  async start(runId: RunId): Promise<RunControllerResult> {
    return this.withLock(runId, () => this.startLocked(runId));
  }

  async submitToolResults(
    runId: RunId,
    results: readonly LLMToolResultMessage[],
  ): Promise<RunControllerResult> {
    return this.withLock(runId, () => this.submitToolResultsLocked(runId, results));
  }

  async recover(runId: RunId): Promise<RunControllerResult> {
    return this.withLock(runId, () => this.recoverLocked(runId));
  }

  async resolveApproval(
    runId: RunId,
    approvalId: ApprovalRequestId,
    resolution: unknown,
  ): Promise<RunControllerResult> {
    return this.withLock(runId, () => this.resolveApprovalLocked(runId, approvalId, resolution));
  }

  async continueResourceGuard(runId: RunId): Promise<RunControllerResult> {
    return this.withLock(runId, () => this.continueResourceGuardLocked(runId));
  }

  async cancel(runId: RunId): Promise<RunControllerResult> {
    const loaded = await this.load(runId);
    if (loaded.run.status === "CANCELLED" || isTerminal(loaded.run.status)) {
      return this.resultFromSnapshot(loaded);
    }
    const requestedAt = this.dependencies.clock.now();
    await this.dependencies.executionStore.requestCancellation(runId, {
      runId,
      cause: "USER_REQUESTED",
      requestedAt,
    });
    const scope = this.scopes.get(runId);
    if (scope !== undefined) {
      scope.abort("USER_REQUESTED");
      await scope.settled;
    }
    return this.withTerminationLock(runId, () => this.cancelLocked(runId));
  }

  private async cancelLocked(runId: RunId): Promise<RunControllerResult> {
    const loaded = await this.load(runId);
    if (isTerminal(loaded.run.status)) return this.resultFromSnapshot(loaded);
    return this.finalizeCancellation(loaded);
  }

  private async resolveApprovalLocked(
    runId: RunId,
    approvalId: ApprovalRequestId,
    resolution: unknown,
  ): Promise<RunControllerResult> {
    const approvals = this.dependencies.approvals;
    if (approvals === undefined) {
      throw new RunControllerInfrastructureError("Approval resolution is not configured.");
    }
    const parsed = ApprovalResolutionSchema.parse(resolution);
    const loaded = await this.load(runId);
    if (isTerminal(loaded.run.status)) return this.resultFromSnapshot(loaded);
    if (loaded.cancellationIntent !== undefined) return this.finalizeCancellation(loaded);
    if (this.isExpired(loaded)) return this.finalizeTimeout(loaded);
    if (loaded.run.status !== "WAITING_APPROVAL" || loaded.state === undefined) {
      throw new RunControllerInputError("Approval resolution requires a WAITING_APPROVAL Run.");
    }
    if (
      loaded.continuation?.type !== "WAITING_TOOL_RESULTS" ||
      loaded.continuation.waitingApproval === undefined ||
      loaded.continuation.waitingApproval.approvalId !== approvalId
    ) {
      throw new RunControllerInputError("Approval does not match the Run approval boundary.");
    }
    const approval = await approvals.getById(approvalId);
    if (
      approval === null ||
      approval.runId !== runId ||
      approval.toolInvocationId !== loaded.continuation.waitingApproval.invocationId
    ) {
      throw new RunControllerInputError("Approval does not belong to the Run Tool invocation.");
    }
    if (parsed.action === "APPROVE" && approval.scope === "ONCE" && parsed.scope === "RUN") {
      throw new RunControllerInputError("Approval resolution scope exceeds the request scope.");
    }
    const resolved = await approvals.resolve(approvalId, parsed);
    return this.resumeResolvedApprovalLocked(loaded, resolved);
  }

  private async continueResourceGuardLocked(runId: RunId): Promise<RunControllerResult> {
    const loaded = await this.load(runId);
    if (loaded.cancellationIntent !== undefined) return this.finalizeCancellation(loaded);
    if (this.isExpired(loaded)) return this.finalizeTimeout(loaded);
    if (
      loaded.run.status !== "WAITING_RESOURCE" ||
      loaded.state === undefined ||
      loaded.continuation?.type !== "WAITING_RESOURCE"
    ) {
      throw new RunControllerInputError(
        "Resource continuation requires a Run waiting for a resource decision.",
      );
    }
    const now = this.dependencies.clock.now();
    const run = resumeAgentRunFromResource(loaded.run);
    const state = resumeAgentStateFromResource(loaded.state, now);
    const checkpoint = {
      type: "WAITING_TOOL_RESULTS" as const,
      runId: loaded.continuation.runId,
      sourceStepId: loaded.continuation.sourceStepId,
      pendingDecision: loaded.continuation.pendingDecision,
    };
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: loaded.stateRevision ?? null,
      expectedContinuationRevision: loaded.continuationRevision ?? null,
      stepWrites: [],
      messagesToAppend: [],
      continuation: { operation: "SET", checkpoint, updatedAt: now },
      events: [
        this.eventFactory.statusChanged(
          loaded.run,
          "WAITING_RESOURCE",
          "RUNNING",
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    return this.driveRunExecutionLocked(commit.snapshot, "RECOVER");
  }

  private async resumeResolvedApprovalLocked(
    loaded: RunExecutionSnapshot,
    resolved: import("@caelush/protocol").ApprovalRequest,
  ): Promise<RunControllerResult> {
    if (loaded.state === undefined || loaded.continuation?.type !== "WAITING_TOOL_RESULTS") {
      throw new RunControllerInvariantError(
        "Approval resume requires a pending Tool continuation.",
      );
    }
    const continuationWithoutApproval = {
      type: loaded.continuation.type,
      runId: loaded.continuation.runId,
      sourceStepId: loaded.continuation.sourceStepId,
      pendingDecision: loaded.continuation.pendingDecision,
      ...(loaded.continuation.receivedResults === undefined
        ? {}
        : { receivedResults: loaded.continuation.receivedResults }),
    };
    const now = this.dependencies.clock.now();
    const run = resumeAgentRunFromApproval(loaded.run);
    const state = resumeAgentStateFromApproval(loaded.state, now);
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: loaded.stateRevision ?? null,
      expectedContinuationRevision: loaded.continuationRevision ?? null,
      stepWrites: [],
      messagesToAppend: [],
      continuation: {
        operation: "SET",
        checkpoint: continuationWithoutApproval,
        updatedAt: now,
      },
      events: [
        this.eventFactory.statusChanged(
          loaded.run,
          "WAITING_APPROVAL",
          "RUNNING",
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    if (resolved.status === "PENDING") {
      throw new RunControllerInvariantError("Approval resolution left a pending ApprovalRequest.");
    }
    return this.driveRunExecutionLocked(commit.snapshot, "RECOVER");
  }

  private async startLocked(runId: RunId): Promise<RunControllerResult> {
    const loaded = await this.load(runId);
    if (isTerminal(loaded.run.status)) return this.resultFromSnapshot(loaded);
    if (loaded.cancellationIntent !== undefined) return this.finalizeCancellation(loaded);
    if (loaded.run.status !== "PENDING") {
      if (this.isExpired(loaded)) return this.finalizeTimeout(loaded);
      return this.resumeKnownBoundary(loaded);
    }
    if (loaded.state !== undefined) {
      throw new RunControllerInputError("PENDING Run cannot already have AgentState");
    }
    const now = this.dependencies.clock.now();
    const initialState = createInitialAgentState(loaded.run, now);
    const state = startAgentState(initialState, now);
    const run = AgentRunSchema.parse({ ...loaded.run, status: "RUNNING", startedAt: now });
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: null,
      expectedContinuationRevision: null,
      stepWrites: [],
      messagesToAppend: [],
      events: [
        this.eventFactory.runStarted(loaded.run, this.nextEventId(), now),
        this.eventFactory.statusChanged(loaded.run, "PENDING", "RUNNING", this.nextEventId(), now),
      ],
    });
    this.notify(commit.events);
    if (run.resourcePolicy !== undefined && this.dependencies.resourceGovernance !== undefined) {
      await this.dependencies.resourceGovernance.createOrGet(run.id, {
        policyVersion: "adaptive-resource-governance.v1",
        mode: run.resourcePolicy.mode,
        now,
      });
    }
    if (this.isExpired(commit.snapshot)) return this.finalizeTimeout(commit.snapshot);
    return this.driveRunExecutionLocked(commit.snapshot, "RECOVER");
  }

  private async submitToolResultsLocked(
    runId: RunId,
    results: readonly LLMToolResultMessage[],
  ): Promise<RunControllerResult> {
    const loaded = await this.load(runId);
    if (loaded.cancellationIntent !== undefined) return this.finalizeCancellation(loaded);
    if (this.isExpired(loaded)) return this.finalizeTimeout(loaded);
    if (loaded.run.status !== "RUNNING" || loaded.state === undefined) {
      throw new RunControllerInputError("Tool Results require a RUNNING Run");
    }
    const continuation = loaded.continuation;
    if (
      continuation?.type !== "WAITING_TOOL_RESULTS" ||
      continuation.waitingApproval !== undefined
    ) {
      throw new RunControllerInputError("Run is not waiting for Tool Results");
    }
    return this.acceptToolResultsLocked(loaded, results);
  }

  private async acceptToolResultsLocked(
    loaded: RunExecutionSnapshot,
    results: readonly LLMToolResultMessage[],
  ): Promise<RunControllerResult> {
    if (loaded.state === undefined || loaded.continuation?.type !== "WAITING_TOOL_RESULTS") {
      throw new RunControllerInputError("Run is not waiting for Tool Results");
    }
    let normalized: readonly LLMToolResultMessage[];
    try {
      normalized = normalizeToolResultBatch(
        loaded.continuation.pendingDecision.toolRequests,
        results,
      );
    } catch {
      const failed = markAgentStateFailed(
        loaded.state,
        {
          code: "TOOL_OUTPUT_ERROR",
          message: "The supplied Tool Results were invalid.",
          retryable: false,
          phase: "TOOL",
        },
        this.dependencies.clock.now(),
      );
      const failedRun = markAgentRunFailed(loaded.run, this.dependencies.clock.now());
      const commit = await this.commitFailure(loaded, failedRun, failed, undefined);
      this.notify(commit.events);
      return this.resultFromSnapshot(commit.snapshot);
    }
    if (
      loaded.continuation.receivedResults !== undefined &&
      !semanticEqual(loaded.continuation.receivedResults, normalized)
    ) {
      throw new RunControllerConflictError("A different Tool Result batch was already accepted");
    }
    let accepted = loaded;
    if (loaded.continuation.receivedResults === undefined) {
      const commit = await this.commit({
        run: loaded.run,
        state: loaded.state,
        expectedStateRevision: loaded.stateRevision ?? null,
        expectedContinuationRevision: loaded.continuationRevision ?? null,
        stepWrites: [],
        messagesToAppend: [],
        continuation: {
          operation: "SET",
          checkpoint: { ...loaded.continuation, receivedResults: normalized },
          updatedAt: this.dependencies.clock.now(),
        },
        events: [],
      });
      accepted = commit.snapshot;
    }
    return this.driveRunExecutionLocked(accepted, "EXECUTE");
  }

  private async recoverLocked(runId: RunId): Promise<RunControllerResult> {
    const loaded = await this.load(runId);
    // Legacy retry provenance is normalized *durably* before anything is routed, so the coordinator
    // only ever sees a state it can decide on and no runtime special case is needed for it.
    const normalized = await this.normalizeLegacyRetryProvenance(loaded);
    // The coordinator owns the governance priority — terminal, cancellation, deadline, exception,
    // step budget, boundary — so the ordering cannot drift between call sites.
    const coordinated = this.coordinatedBoundary(normalized);
    if (coordinated !== undefined) return coordinated;
    if (normalized.cancellationIntent !== undefined) return this.finalizeCancellation(normalized);
    if (this.isExpired(normalized)) return this.finalizeTimeout(normalized);
    if (normalized.run.status === "RUNNING" && normalized.continuation?.type === "WAITING_RETRY") {
      return this.resumeRetryLocked(normalized);
    }
    if (normalized.run.status === "RUNNING" && normalized.activeStep !== undefined) {
      return this.recoverStaleStep(normalized);
    }
    if (normalized.run.status === "WAITING_APPROVAL") {
      const approvalId =
        normalized.continuation?.type === "WAITING_TOOL_RESULTS"
          ? normalized.continuation.waitingApproval?.approvalId
          : undefined;
      const approvals = this.dependencies.approvals;
      if (approvalId !== undefined && approvals !== undefined) {
        const approval = await approvals.getById(approvalId);
        if (approval !== null && approval.status !== "PENDING") {
          return this.resumeResolvedApprovalLocked(normalized, approval);
        }
      }
      return this.resumeKnownBoundary(normalized);
    }
    if (normalized.run.status === "WAITING_RESOURCE") {
      return this.resumeKnownBoundary(normalized);
    }
    if (
      normalized.run.status === "RUNNING" &&
      normalized.state !== undefined &&
      (normalized.continuation?.type === "WAITING_TOOL_RESULTS" ||
        (normalized.continuation === undefined && normalized.conversation.length === 0))
    ) {
      return this.driveRunExecutionLocked(normalized, "RECOVER");
    }
    if (normalized.run.status === "VERIFYING") {
      // The coordinator decides `EVALUATE_COMPLETION` from this state, so recovery enters the same
      // production loop as every other action rather than a verification path of its own.
      return this.driveRunExecutionLocked(normalized, "RECOVER");
    }
    if (
      normalized.run.status === "RUNNING" &&
      normalized.continuation?.type === "WAITING_VERIFICATION_REPAIR"
    ) {
      return this.driveRunExecutionLocked(normalized, "RECOVER");
    }
    return this.resumeKnownBoundary(normalized);
  }

  /**
   * Normalize a legacy retry checkpoint's missing Tool provenance, durably.
   *
   * ```text
   * load the WAITING_RETRY checkpoint
   *        ↓
   * recover sourceStepId from the durable ledger
   *        ↓
   * atomic continuation update
   *        ↓
   * reload
   * ```
   *
   * A checkpoint written before the retry continuation carried `sourceStepId` has no recorded
   * provenance, and the coordinator refuses to route it — correctly, because fabricating a Step
   * identity would open a Tool resume against a Step the Run never wrote. The recovery is a real
   * durable write from data this Run already holds, so after it the coordinator sees an ordinary
   * normalized state and needs no special case of its own.
   *
   * When the ledger cannot determine the Step, this fails closed. Guessing from `failedStepId`, the
   * latest Step, a model call id or a Tool call id is never acceptable: none of them is the Step
   * that requested the batch.
   */
  private async normalizeLegacyRetryProvenance(
    snapshot: RunExecutionSnapshot,
  ): Promise<RunExecutionSnapshot> {
    const continuation = snapshot.continuation;
    if (
      continuation?.type !== "WAITING_RETRY" ||
      continuation.mode !== "TOOL_RESULTS" ||
      continuation.sourceStepId !== undefined
    ) {
      return snapshot;
    }
    const sourceStepId = recoverToolRequestSourceStep(snapshot, continuation.pendingDecision);
    const commit = await this.commit({
      run: snapshot.run,
      ...(snapshot.state === undefined ? {} : { state: snapshot.state }),
      expectedStateRevision: snapshot.stateRevision ?? null,
      expectedContinuationRevision: snapshot.continuationRevision ?? null,
      stepWrites: [],
      messagesToAppend: [],
      continuation: {
        operation: "SET",
        checkpoint: { ...continuation, sourceStepId },
        updatedAt: this.dependencies.clock.now(),
      },
      events: [],
    });
    return commit.snapshot;
  }

  private async resumeRetryLocked(loaded: RunExecutionSnapshot): Promise<RunControllerResult> {
    if (loaded.continuation?.type !== "WAITING_RETRY") {
      return this.resultFromSnapshot(loaded);
    }
    if (loaded.cancellationIntent !== undefined) return this.finalizeCancellation(loaded);
    if (this.isExpired(loaded)) return this.finalizeTimeout(loaded);
    if (loaded.state === undefined) {
      throw new RunControllerInvariantError("Retry boundary requires an AgentState");
    }
    const now = this.dependencies.clock.now();
    if (now < loaded.continuation.nextAttemptAt) {
      this.scheduleRetry(loaded.run.id, loaded.continuation.nextAttemptAt);
      return this.resultFromSnapshot(loaded);
    }
    if (loaded.state.usage.steps >= loaded.run.limits.maxSteps) {
      const state = markAgentStateMaxStepsReached(loaded.state, now);
      const run = AgentRunSchema.parse({
        ...loaded.run,
        status: "MAX_STEPS_REACHED",
        finishedAt: now,
      });
      const commit = await this.commit({
        run,
        state,
        expectedStateRevision: loaded.stateRevision ?? null,
        expectedContinuationRevision: loaded.continuationRevision ?? null,
        stepWrites: [],
        messagesToAppend: [],
        continuation: { operation: "CLEAR" },
        events: [
          this.eventFactory.maxSteps(
            loaded.run,
            state,
            {
              type: "MAX_STEPS_REACHED",
              stepsCompleted: state.usage.steps,
              maxSteps: loaded.run.limits.maxSteps,
            },
            this.nextEventId(),
            now,
          ),
          this.eventFactory.statusChanged(
            loaded.run,
            "RUNNING",
            "MAX_STEPS_REACHED",
            this.nextEventId(),
            now,
          ),
        ],
      });
      this.notify(commit.events);
      return this.resultFromSnapshot(commit.snapshot);
    }
    this.retryRegistry.disarm(loaded.run.id);
    // The retry resume runs through the same production loop as every other action: the coordinator
    // decides `ADVANCE_AGENT(RETRY)` from the normalized durable state, and the Run Layer allocates a
    // *new* Step for the new attempt. The failed Step is never reopened.
    return this.driveRunExecutionLocked(loaded, "RECOVER");
  }

  /**
   * The production Run execution loop.
   *
   * ```text
   * Coordinator.next()          the only routing authority
   *        ↓
   * ADVANCE_AGENT               → Run Layer Step allocation → RunExecutionDriver
   * EXECUTE_TOOL_BATCH          → the run-scoped Tool turn adapter → RunExecutionDriver
   * FINALIZE                    → the terminal settlement for the reason it carries
   * anything else               → the boundary is already durable
   * ```
   *
   * Both executable directives go through the *same* frozen driver; what differs is the port the
   * driver is given for that effect. Nothing here re-derives which action to take from a continuation
   * type, a Run status or an execution epoch, so the action that runs is the action that was decided.
   *
   * A state the coordinator refuses to route is not guessed at. An active Step and a legacy retry
   * checkpoint without recorded provenance are resolved by the recovery paths before this loop is
   * entered, so reaching one here is a lifecycle violation rather than something to route around —
   * the coordinator's refusal is propagated rather than swallowed.
   */
  private async driveRunExecutionLocked(
    initial: RunExecutionSnapshot,
    initialMode: "EXECUTE" | "RECOVER" = "EXECUTE",
  ): Promise<RunControllerResult> {
    let snapshot = initial;
    /**
     * How the *next* Tool batch is entered.
     *
     * The frozen coordinator decides *which* batch is next; whether that batch is a fresh execution
     * or the settlement of one a restart interrupted is a fact only this layer holds, because it is
     * the layer that knows why it is driving at all. It is threaded explicitly rather than read off
     * the directive: a durable `RUNNING` invocation must be recovered — never re-dispatched — and
     * only this caller can say that this is a recovery.
     *
     * The intent is spent once a batch has been dispatched: a batch re-entered after accepted results
     * is a fresh execution of the model's next request.
     */
    let mode = initialMode;
    while (true) {
      if (snapshot.cancellationIntent !== undefined) return this.finalizeCancellation(snapshot);
      if (this.isExpired(snapshot)) return this.finalizeTimeout(snapshot);
      if (snapshot.run.status === "WAITING_APPROVAL" || snapshot.run.status === "WAITING_RESOURCE")
        return this.resultFromSnapshot(snapshot);
      if (isTerminal(snapshot.run.status)) return this.resultFromSnapshot(snapshot);

      const directive = this.coordinator.next(
        toAgentExecutionSnapshot(snapshot),
        this.dependencies.clock.now(),
      );

      if (directive.kind === "EXECUTE_TOOL_BATCH") {
        // The coordinator has decided a Tool batch is next; whether this Run Layer can run one is a
        // composition question, and a Run whose host composed Tool execution out simply waits on
        // its durable boundary.
        const turnDriver = this.toolTurnDriver(snapshot, mode);
        if (turnDriver === undefined) return this.resultFromSnapshot(snapshot);

        // ```text
        // RunExecutionDriver.execute(EXECUTE_TOOL_BATCH)
        //        ↓
        // the real, run-scoped ToolTurnCoordinator
        //        ↓
        // the existing durable Tool System
        // ```
        //
        // The Tool effect is executed by the *same* frozen driver that executes a model turn. The
        // directive is the coordinator's own decision, carried in verbatim; nothing here re-decides
        // which batch is next, and nothing here talks to the Tool Layer directly.
        const execution = await this.executeToolBatchDirective(snapshot, directive, turnDriver);
        if (!isToolTurnResult(execution)) {
          return "aborted" in execution ? execution.aborted : execution.failed;
        }

        // Tool settlement may have advanced AgentState in its own atomic transaction: a validated
        // Tool effect (`changedFiles`, `activeProcesses`) is projected into the durable AgentState
        // snapshot inside the Tool store's commit, which bumps its revision. Always continue from
        // the durable revision before planning a continuation, an approval boundary or a failure.
        snapshot = await this.load(snapshot.run.id);
        if (this.executionSignal(snapshot.run.id).aborted) {
          return this.finalizeAbortedExecution(snapshot);
        }

        const settled = await this.settleToolEffect(snapshot, directive, {
          result: execution.result,
          observation: execution.observation,
        });
        if (settled.kind === "RESULT") return settled.result;
        snapshot = settled.snapshot;
        // An accepted — or synthetic — result set is durable, so the next batch the model's own
        // turn requests is a fresh execution of it rather than a settlement of this one.
        mode = "EXECUTE";
        continue;
      }

      if (directive.kind === "ADVANCE_AGENT") {
        const execution = await this.executeAgentDirective(snapshot, directive);
        if (execution.status !== "WAITING_TOOL_RESULTS") return execution;
        snapshot = await this.load(snapshot.run.id);
        // The turn produced a *new* Tool request, so the next batch is a fresh execution of it.
        mode = "EXECUTE";
        continue;
      }

      if (directive.kind === "EVALUATE_COMPLETION") {
        // ```text
        // RunExecutionDriver.execute(EVALUATE_COMPLETION)
        //        ↓
        // the real coding CompletionGate
        //        ↓
        // a frozen decision, plus the Core-private record of what verification established
        // ```
        //
        // The completion effect travels the *same* frozen driver as a model turn and a Tool batch. The
        // directive is the coordinator's own decision, carried in verbatim; nothing here re-decides
        // what to evaluate, and nothing here runs verification itself.
        const resolved = this.completionGate({ snapshot, mode });
        if (resolved === undefined) return this.resultFromSnapshot(snapshot);

        const execution = await this.executeCompletionDirective(snapshot, directive, resolved);
        if (!isCompletionDecision(execution)) return execution.outcome;

        // Verification may have advanced the durable AgentState and the plan inside their own
        // transactions (check settlements, evidence). Always continue from the durable revision the
        // gate actually left behind before planning a completion transition.
        snapshot = await this.load(snapshot.run.id);
        if (this.executionSignal(snapshot.run.id).aborted) {
          return this.finalizeAbortedExecution(snapshot);
        }

        const settled = await this.settleCompletionEffect(snapshot, directive, {
          decision: execution.decision,
          observation: execution.observation,
        });
        if (settled.kind === "RESULT") return settled.result;
        snapshot = settled.snapshot;
        // A repair returned the Run to RUNNING, so the next effect is a fresh Reason rather than
        // another completion evaluation of the plan that just failed.
        mode = "EXECUTE";
        continue;
      }

      if (directive.kind === "FINALIZE") {
        // A terminal settlement the coordinator decided is committed here rather than left for a
        // later recovery: the structural step budget and the deadline are governance decisions, not
        // effects, and a caller that reached the end of the batch budget must see the settled Run
        // rather than a `RUNNING` snapshot that only the next `recover()` would resolve.
        switch (directive.reason) {
          case "CANCELLED":
            return this.finalizeCancellation(snapshot);
          case "TIMEOUT":
            return this.finalizeTimeout(snapshot);
          case "MAX_STEPS_REACHED":
            return this.finalizeMaxSteps(snapshot);
        }
      }

      // Every other directive is a state the Run Layer does not act on here: the boundary is
      // already durable and only an external resolution, a commit or a fresh recovery moves it.
      return this.resultFromSnapshot(snapshot);
    }
  }

  /**
   * The run-scoped Tool turn driver for one directive.
   *
   * ```text
   * durable snapshot        the facts the coordinator decided from
   * + entry mode            whether this batch may already have run
   * ↓
   * RunToolTurnDriver       a real frozen ToolTurnCoordinator over the durable Tool System
   * ```
   *
   * A host that composed Tool execution out returns `undefined` and the Run waits on its durable
   * boundary. Otherwise the adapter captures the host facts the frozen request deliberately does
   * not carry — workspace, Runtime, security context, resource policy — so the general Agent
   * contract never has to.
   *
   * The entry mode is threaded in, never derived. A durable `RUNNING` invocation must be recovered
   * and never re-dispatched, and only this layer knows whether the batch it is driving is fresh.
   */
  private toolTurnDriver(
    snapshot: RunExecutionSnapshot,
    requestedMode: RunExecutionMode,
  ): ReturnType<ReturnType<typeof createRunToolTurnDriverFactory>> | undefined {
    const batches = this.dependencies.toolCoordinator;
    if (batches === undefined) return undefined;
    return createRunToolTurnDriverFactory(this.toolTurnDependencies(batches, snapshot.run.id))(
      snapshot,
      requestedMode,
    );
  }

  /**
   * The host facts the Tool turn adapter is assembled from.
   *
   * The RunController names a `ToolBatchCoordinatorPort` and a resource ledger — nothing narrower.
   * It does not know a `ToolBatchItem`, a security context, an execution environment or a
   * `ResourceGovernor`: those belong to the adapter, which is the only object that translates the
   * frozen Tool turn contract into the legacy Tool batch request.
   */
  private toolTurnDependencies(
    batches: ToolBatchCoordinatorPort,
    runId: RunId,
  ): RunToolTurnDriverDependencies {
    const contextRuntime = this.dependencies.contextRuntime;
    return {
      batches,
      ...(this.dependencies.resourceGovernance === undefined
        ? {}
        : { resourceGovernance: this.dependencies.resourceGovernance }),
      clock: this.dependencies.clock,
      // The Run's live cancellation signal, read when the batch runs. The adapter never creates an
      // abort scope, never owns a timeout and never reads a deadline: it forwards this unchanged.
      signal: () => this.executionSignal(runId),
      ...(contextRuntime?.getContextPolicy === undefined
        ? {}
        : { hostObservationPolicy: () => contextRuntime.getContextPolicy?.(runId) }),
    };
  }

  /**
   * Drive one `EXECUTE_TOOL_BATCH` directive through the frozen Run execution driver.
   *
   * ```text
   * createRunExecutionDriver({ agentLoop, toolTurns: <run-scoped adapter>, completionGate })
   *        ↓
   * driver.execute(directive, context)
   *        ↓
   * the real ToolTurnCoordinator
   *        ↓
   * the existing durable Tool System
   * ```
   *
   * The driver's `toolTurns` port is the run-scoped adapter resolved from *the snapshot the
   * coordinator decided from*, so the batch that runs is the batch that was decided and its
   * captured facts are the Run's own. A Tool infrastructure exception is never turned into a
   * model-facing Tool result: it settles as a sanitized Run failure, and an abort is left for the
   * termination authority.
   */
  private async executeToolBatchDirective(
    snapshot: RunExecutionSnapshot,
    directive: ExecuteToolBatchDirective,
    turnDriver: ResolvedRunToolTurn,
  ): Promise<ToolBatchDirectiveExecution> {
    const driver = createRunExecutionDriver({
      // A Tool turn never advances the model, so this port is never reached. It refuses rather
      // than looping a Run nobody asked for.
      agentLoop: MISROUTED_AGENT_LOOP,
      toolTurns: turnDriver.coordinator,
      // The Agent path never evaluates completion: the Run Layer's own completion effect owns that,
      // and a completion directive arriving here would be a misrouted effect.
      completionGate: MISROUTED_COMPLETION_GATE,
    });
    try {
      const effect = await driver.execute(directive, {
        identity: {
          runId: snapshot.run.id,
          sessionId: snapshot.run.sessionId,
          goal: snapshot.run.goal,
        },
        // The frozen effect context describes *the effect being executed*, and a Tool effect has no
        // model turn of its own. The Step is the one that **requested** the batch — the same Step
        // the Tool Layer records its invocations against — and the history, model and catalog are
        // supplied minimally because the driver reads none of them for a Tool directive.
        turn: { stepId: directive.sourceStepId, sequence: 0 },
        history: [],
        model: unresolvedToolTurnModel(snapshot.run.model),
        tools: [],
        signal: this.executionSignal(snapshot.run.id),
      });
      if (effect.kind !== "TOOLS") {
        throw new RunControllerInvariantError(
          `The Tool driver produced a ${effect.kind} effect for an EXECUTE_TOOL_BATCH directive.`,
        );
      }
      return { result: effect.result, observation: turnDriver.observation };
    } catch (error) {
      // An aborted execution has no settlement of its own: the cancellation and deadline
      // authorities own what happens to the Run, and this layer only reports it upward.
      if (this.executionSignal(snapshot.run.id).aborted) {
        return { aborted: await this.finalizeAbortedExecution(snapshot) };
      }
      // The adapter's own identity refusal is a lifecycle violation, not a Tool failure: a request
      // that does not match the Run's durable batch means the wrong batch was about to run, and
      // settling that as a Tool error would hide it behind a model-facing message.
      if (error instanceof RunControllerInvariantError) throw error;
      const agentError =
        error instanceof ToolBatchInputError
          ? {
              code: "MODEL_ERROR" as const,
              message: "The model produced an invalid Tool Call batch.",
              retryable: false,
              phase: "LLM" as const,
            }
          : {
              code: "RUNTIME_ERROR" as const,
              message:
                "Tool execution infrastructure failed before a complete Tool Result batch was available.",
              retryable: false,
              phase: "TOOL" as const,
            };
      // A Tool infrastructure exception is never turned into a model-facing Tool result: it is a
      // sanitized terminal failure for the Run, and the internal exception text stays out of it.
      return { failed: await this.failBoundaryLocked(snapshot, agentError, error) };
    }
  }

  /**
   * Settle one executed Tool effect through exactly one typed authority.
   *
   * ```text
   * classifyToolEffectSettlement()
   *        ↓
   * CANONICAL_TOOL_EFFECT     PLAN -> MATERIALIZE -> COMMIT -> NOTIFY
   * RESOURCE_COMPATIBILITY    the durable WAITING_RESOURCE checkpoint
   * BUDGET_AUTHORITY          the existing budget termination settlement
   * ```
   *
   * The route is chosen by typed discriminant only and there is no generic fallback: a planner
   * error propagates instead of being caught and re-settled by a second authority.
   */
  private async settleToolEffect(
    snapshot: RunExecutionSnapshot,
    directive: ExecuteToolBatchDirective,
    execution: Extract<ToolBatchDirectiveExecution, { result: ToolTurnResult }>,
  ): Promise<ToolEffectSettlement> {
    const current = await this.load(snapshot.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "CANCELLED") {
      return { kind: "RESULT", result: await this.finalizeCancellation(current) };
    }
    if (authority === "TIMEOUT") {
      return { kind: "RESULT", result: await this.finalizeTimeout(current) };
    }
    if (authority === "TERMINAL") {
      return { kind: "RESULT", result: this.resultFromSnapshot(current) };
    }
    if (authority === "UNEXPECTED_ABORT") {
      return { kind: "RESULT", result: await this.finalizeAbortedExecution(current) };
    }

    const route = classifyToolEffectSettlement({
      result: execution.result,
      observation: execution.observation,
    });
    switch (route.route) {
      case "BUDGET_AUTHORITY":
        return {
          kind: "RESULT",
          result: await this.finalizeBudgetExceeded(current, route.block),
        };
      case "RESOURCE_COMPATIBILITY": {
        const resource = await this.settleWaitingResource(current, directive, route.replanCount);
        return { kind: "SNAPSHOT", snapshot: resource };
      }
      case "CANONICAL_TOOL_EFFECT": {
        const canonical = await this.settleCanonicalToolTurn(current, directive, route.result);
        return { kind: "SNAPSHOT", snapshot: canonical };
      }
    }
  }

  /**
   * Settle a Tool effect the frozen planner can express.
   *
   * ```text
   * PLAN -> MATERIALIZE -> COMMIT -> NOTIFY -> post-commit resource observation
   * ```
   *
   * The order is the contract, and the last step is ordered as carefully as the rest: resource
   * progress accounts for work the Run *accepted*, so it is recorded only after the continuation
   * is durable. A settlement whose commit lost its compare-and-swap leaves the progress ledger
   * where it was, and the durable Tool invocations remain the recovery authority — the next
   * recovery reads them instead of replaying a handler.
   *
   * A `REPLAN` is the one route that also advances the durable replan count, and it does so after
   * its synthetic results are durable for the same reason.
   */
  private async settleCanonicalToolTurn(
    current: RunExecutionSnapshot,
    directive: ExecuteToolBatchDirective,
    result: Exclude<ToolTurnResult, { kind: "RESOURCE_WAIT" | "BUDGET_EXCEEDED" }>,
  ): Promise<RunExecutionSnapshot> {
    const now = this.dependencies.clock.now();
    const snapshot = toAgentExecutionSnapshot(current);
    const effect: RunExecutionEffectResult = { kind: "TOOLS", result };

    const planned = this.transitionPlanner.plan({ snapshot, directive, effect, now });
    const materialized = this.eventMaterializer.materialize({
      snapshot: current,
      directive,
      effect,
      plannedCommit: planned,
      now,
      // A Tool turn performs no provider turn: the Tool Layer's own lifecycle is what it reports,
      // and a provider state here would be a claim about a model call this effect never made.
      providerTurnState: "NOT_STARTED",
      ownership: { eventIds: this.dependencies.eventIdFactory },
    });

    const committed = await this.commit(materialized);
    this.notify(committed.events);
    await this.recordToolTurnProgress(committed.snapshot, result);
    return committed.snapshot;
  }

  /**
   * The post-commit resource progress of one settled Tool batch.
   *
   * It runs for the two routes whose results the Run accepted — `COMPLETED` and `REPLAN` — and for
   * nothing else. An approval boundary accepted no complete batch, and a budget settlement is
   * terminal: recording progress for either would account for work the Run never took.
   *
   * The context is rebuilt from the durable continuation the settlement just committed, which is
   * the same record the execution was built from, so the progress fingerprint and the observation
   * policy cannot disagree with the batch that actually ran.
   */
  private async recordToolTurnProgress(
    settled: RunExecutionSnapshot,
    result: Exclude<ToolTurnResult, { kind: "RESOURCE_WAIT" | "BUDGET_EXCEEDED" }>,
  ): Promise<void> {
    const batches = this.dependencies.toolCoordinator;
    if (batches === undefined) return;
    // The facts come from the adapter, which is the only object that derives a security context, an
    // execution environment or an observation policy for a Tool turn. Rebuilding them here would be a
    // second capture of the same facts, free to disagree with the batch that actually ran.
    const facts = captureRunToolTurnFacts({
      snapshot: settled,
      ...this.hostObservationPolicy(settled.run.id),
    });
    if (facts === undefined) return;
    const dependencies = this.toolTurnDependencies(batches, settled.run.id);
    const results =
      result.kind === "COMPLETED"
        ? result.results
        : result.kind === "REPLAN"
          ? result.syntheticResults
          : [];
    // A REPLAN writes no Tool invocation at all, so the ledger entry is the only durable trace of the
    // decision — and it is what a later `WAITING_RESOURCE` reports as `replanCount`.
    if (result.kind === "REPLAN") await recordRunToolTurnReplan({ dependencies, facts });
    if (results.length === 0) return;
    await recordRunToolTurnProgress({ dependencies, facts, results });
  }

  /**
   * The host Context runtime's observation policy, when it has one.
   *
   * It is a compatibility fallback the adapter consults only for a Tool continuation written before the
   * durable policy existed. A Run whose Context runtime configures no policy contributes nothing, and
   * the adapter's own default applies.
   */
  private hostObservationPolicy(runId: RunId): {
    readonly hostObservationPolicy?: () => AgentToolObservationPolicy | undefined;
  } {
    const getPolicy = this.dependencies.contextRuntime?.getContextPolicy;
    if (getPolicy === undefined) return {};
    return { hostObservationPolicy: () => getPolicy.call(this.dependencies.contextRuntime, runId) };
  }

  /**
   * The durable `WAITING_RESOURCE` boundary.
   *
   * The frozen planner refuses this transition on purpose: the checkpoint has always persisted a
   * `replanCount` and the frozen `RESOURCE_WAIT` result carries a reason and nothing else. The
   * count therefore comes from the Core-private observation — the number the admission decision
   * actually read from the resource ledger — and from nowhere else. It is never re-derived,
   * counted again or defaulted.
   */
  private async settleWaitingResource(
    loaded: RunExecutionSnapshot,
    directive: ExecuteToolBatchDirective,
    replanCount: number,
  ): Promise<RunExecutionSnapshot> {
    if (loaded.state === undefined) {
      throw new RunControllerInvariantError("Resource guard requires an AgentState");
    }
    const continuation = loaded.continuation;
    if (continuation?.type !== "WAITING_TOOL_RESULTS") {
      throw new RunControllerInvariantError(
        "A resource boundary requires an open WAITING_TOOL_RESULTS continuation.",
      );
    }
    const now = this.dependencies.clock.now();
    const run = markAgentRunWaitingResource(loaded.run);
    const state = markAgentStateWaitingResource(loaded.state, now);
    const checkpoint = {
      type: "WAITING_RESOURCE" as const,
      runId: continuation.runId,
      sourceStepId: continuation.sourceStepId,
      pendingDecision: continuation.pendingDecision,
      reason: "NO_PROGRESS" as const,
      replanCount,
    };
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: loaded.stateRevision ?? null,
      expectedContinuationRevision: loaded.continuationRevision ?? null,
      stepWrites: [],
      messagesToAppend: [],
      continuation: { operation: "SET", checkpoint, updatedAt: now },
      events: [
        this.eventFactory.statusChanged(
          loaded.run,
          "RUNNING",
          "WAITING_RESOURCE",
          this.nextEventId(),
          now,
        ),
        this.eventFactory.resourceGuard(
          loaded.run,
          replanCount,
          directive.pendingDecision.toolRequests.length,
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    return commit.snapshot;
  }

  private async failBoundaryLocked(
    loaded: RunExecutionSnapshot,
    error: AgentError,
    cause?: unknown,
  ): Promise<RunControllerResult> {
    if (loaded.state === undefined) {
      throw new RunControllerInfrastructureError("Tool boundary failure has no AgentState", {
        cause,
      });
    }
    const failedState = markAgentStateFailed(loaded.state, error, this.dependencies.clock.now());
    const failedRun = markAgentRunFailed(loaded.run, this.dependencies.clock.now());
    const commit = await this.commitFailure(loaded, failedRun, failedState, undefined);
    this.notify(commit.events);
    return this.resultFromSnapshot(commit.snapshot);
  }

  /**
   * Drive one `ADVANCE_AGENT` directive through the frozen Run execution driver.
   *
   * ```text
   * Run Layer allocates the Step
   *        ↓
   * createAgentLoop(...)  →  createRunExecutionDriver(...)  →  driver.execute(directive)
   *        ↓
   * frozen AgentLoop.advance()
   *        ↓  Context → Admission → durable ModelTurnBoundary → Provider
   * AgentLoopAdvanceResult  →  canonical settlement
   * ```
   *
   * The directive is the *only* Reason authority here. It is not re-derived from a Loop epoch, from
   * the continuation type, from the Run goal or from the outcome: the coordinator's own decision is
   * carried into the driver verbatim, and a directive that is not an `ADVANCE_AGENT` fails closed
   * rather than being silently reinterpreted.
   *
   * The Step this effect runs as is allocated **before** `advance()` and is deliberately not durable
   * yet. It becomes durable exactly once, in `openAgentTurn`, which the durable
   * `ModelTurnBoundaryPort` enters after admission and before any provider I/O. A context failure, a
   * budget refusal or a cancellation before that boundary therefore leaves zero durable Step rows —
   * the pending Step is an in-memory execution fact, not a new persisted state.
   *
   * `decision` is the durable snapshot the coordinator decided *from*, and it is the CAS the first
   * open commits against. Using the state the decision was made from — rather than whatever the
   * ledger happens to hold when the boundary is entered — is what stops a snapshot that moved after
   * the decision from being opened as if it had not.
   */
  private async executeAgentDirective(
    decision: RunExecutionSnapshot,
    directive: AdvanceAgentDirective,
  ): Promise<RunControllerResult> {
    const snapshot = decision;
    const state = snapshot.state;
    if (state === undefined) throw new RunControllerInputError("Run execution has no AgentState");

    const execution = await this.dependencies.agentExecution.resolve(snapshot.run);
    const signal = this.executionSignal(snapshot.run.id);
    const step = allocateRunAgentStep({
      state,
      runId: snapshot.run.id,
      stepId: execution.stepIds.create(),
      now: this.dependencies.clock.now(),
    });

    // The directive's own turn input, projected against the durable conversation through the frozen
    // kernel validators. Nothing here re-derives *which* turn this is.
    const history = projectRunAgentHistory({
      input: directive.input,
      conversation: snapshot.conversation,
      ...(execution.historyPrefix === undefined ? {} : { historyPrefix: execution.historyPrefix }),
    });

    // The Core-private record of what the boundary, the context engine and the provider actually
    // did. The frozen result deliberately reports none of it, so this is the only channel through
    // which a boundary commit failure stays distinguishable from a model failure.
    const observation = createAgentTurnObservation();
    const pendingTurn = this.pendingAgentTurn(
      decision,
      directive,
      step,
      toolRequestStepOf(snapshot),
    );
    const boundary = createAgentModelTurnBoundary({
      observation,
      pendingTurn: () => pendingTurn,
      openTurn: (turn) => this.openAgentTurn(turn),
    });

    const contextEngine = execution.createContextEngine(
      snapshot.run,
      await this.verificationRepairContext(snapshot),
    );
    const modelAdmission = this.modelAdmissionPort(observation, snapshot.run, step);
    const loop = createRunAgentLoop(
      this.captureContextErrors(contextEngine, observation),
      createAgentDecisionClassifier(),
      {
        // The observation decorator wraps the host's executor without changing it, so the frozen
        // union the kernel receives is the one the host composed.
        modelTurnExecutor: createObservingModelTurnExecutor(
          execution.modelTurnExecutor,
          observation,
        ),
        ...(modelAdmission === undefined ? {} : { modelAdmission }),
        modelTurnBoundary: boundary,
      },
    );
    const driver = createRunExecutionDriver({
      agentLoop: loop,
      // The Agent path never hands the driver a Tool directive — the Run Layer's Tool turn owns
      // that — but the driver's contract requires the port. A misrouted Tool directive is refused
      // here rather than executed a second time through an Agent turn.
      toolTurns: MISROUTED_TOOL_TURN_COORDINATOR,
      // Phase 3E owns the real completion adapter. The production Agent path never hands it an
      // `EVALUATE_COMPLETION` directive, and the placeholder throws rather than approximating work
      // nobody performed.
      // The Agent path never evaluates completion: the Run Layer's own completion effect owns that,
      // and a completion directive arriving here would be a misrouted effect.
      completionGate: MISROUTED_COMPLETION_GATE,
    });

    const effect = await driver.execute(directive, {
      identity: {
        runId: snapshot.run.id,
        sessionId: snapshot.run.sessionId,
        goal: snapshot.run.goal,
      },
      turn: { stepId: step.id, sequence: step.sequence },
      history: history.history,
      model: execution.models.resolve(snapshot.run.model),
      tools: execution.tools,
      ...(execution.modelSettings === undefined ? {} : { modelSettings: execution.modelSettings }),
      signal,
    });

    if (effect.kind !== "AGENT") {
      throw new RunControllerInvariantError(
        `The Agent driver produced a ${effect.kind} effect for an ADVANCE_AGENT directive.`,
      );
    }
    if (requiresBoundaryRepair(observation)) {
      // The durable open-Step commit did not succeed. No provider call was allowed, no Agent effect
      // exists, and settling this as a model failure would durably record an answer the model never
      // gave. The Run stays recoverable and the caller repairs or retries.
      throw new RunControllerInfrastructureError("Unable to durably open the model turn", {
        cause: observation.boundaryError,
      });
    }

    return this.settle(snapshot, directive, effect.result, observation);
  }

  /**
   * The pending Step one Agent effect is opened with.
   *
   * It is built from the effect-start snapshot the coordinator decided on: the revisions are the CAS
   * the first open must compare against, and the Step is the one the Run Layer allocated. No mutable
   * copy of the Run or the AgentState crosses into the boundary — the boundary commits the *current*
   * durable snapshot, so a stale pre-provider copy can never become the committed state.
   */
  private pendingAgentTurn(
    snapshot: RunExecutionSnapshot,
    directive: AdvanceAgentDirective,
    step: AgentStep,
    toolRequestStepId: StepId | undefined,
  ): PendingAgentTurn {
    return {
      identity: {
        runId: snapshot.run.id,
        sessionId: snapshot.run.sessionId,
        goal: snapshot.run.goal,
      },
      model: snapshot.run.model,
      step,
      advanceReason: directive.reason,
      // The revisions the decision was made from. `null` is the unset marker the commit vocabulary
      // already uses for "this Run has no revision yet", so the two agree by construction.
      expectedStateRevision: snapshot.stateRevision ?? null,
      expectedContinuationRevision: snapshot.continuationRevision ?? null,
      // The Tool-request Step is the durable continuation's own provenance, never one read back out
      // of the frozen turn input: it is a fact of the Run's ledger, and the boundary refuses a turn
      // whose continuation does not record the same Step.
      ...(toolRequestStepId === undefined ? {} : { sourceStepId: toolRequestStepId }),
    };
  }

  /**
   * The frozen admission port for one turn.
   *
   * It is the Run Layer's budget authority, and it runs exactly where the frozen loop puts it: after
   * the context is prepared and the request is built, and strictly before the durable boundary. A
   * refusal therefore costs no durable Step and no provider call, and the exact block it reported —
   * dimension, accounted and limit — travels back through the Core-private observation rather than
   * being reconstructed from the frozen error.
   */
  private modelAdmissionPort(
    observation: AgentTurnObservation,
    run: AgentRun,
    step: AgentStep,
  ): ModelRequestAdmissionPort | undefined {
    const budget = this.dependencies.budget;
    if (budget === undefined) return undefined;
    return {
      admit: async ({ request }) => {
        try {
          const estimatedInputTokens = this.dependencies.tokenEstimator?.estimate(request);
          const admission = await budget.admitLLM({
            run,
            step,
            admission: {
              ...(estimatedInputTokens === undefined ? {} : { estimatedInputTokens }),
              ...(request.settings?.maxOutputTokens === undefined
                ? {}
                : { configuredMaxOutputTokens: request.settings.maxOutputTokens }),
            },
          });
          if (admission.kind !== "ALLOWED") {
            observation.admissionBlock = toBudgetBlock(admission);
            return { kind: "BLOCKED", reason: "BUDGET", block: toFrozenBudgetBlock(admission) };
          }
          if (admission.effectiveMaxOutputTokens === undefined) {
            return { kind: "ALLOWED", request };
          }
          return {
            kind: "ALLOWED",
            request: {
              ...request,
              settings: {
                ...request.settings,
                maxOutputTokens: admission.effectiveMaxOutputTokens,
              },
            },
          };
        } catch (error) {
          observation.admissionError = error;
          throw error;
        }
      },
    };
  }

  /**
   * Record the Context Engine's own failure without letting it cross the frozen boundary.
   *
   * The kernel reports only that preparation failed. The value itself may quote a path, a document
   * or a prompt, so it is kept here — in the layer that owns the engine — and used to classify the
   * durable failure.
   */
  private captureContextErrors(
    engine: import("@caelush/agent").ContextEnginePort,
    observation: AgentTurnObservation,
  ): import("@caelush/agent").ContextEnginePort {
    return {
      prepare: async (input) => {
        try {
          return await engine.prepare(input);
        } catch (error) {
          observation.contextError = error;
          throw error;
        }
      },
    };
  }

  /**
   * The verification-repair context of the turn about to run, when the Run is parked on a repair.
   *
   * Still compiled by the existing verification authority and still handed to the frozen loop only
   * through the Context Engine supplier — never as a field of an `@caelush/agent` contract.
   */
  private async verificationRepairContext(
    snapshot: RunExecutionSnapshot,
  ): Promise<import("@caelush/context").VerificationRepairContextInput | undefined> {
    const repairContinuation =
      snapshot.continuation?.type === "WAITING_VERIFICATION_REPAIR"
        ? snapshot.continuation
        : undefined;
    if (repairContinuation === undefined) return undefined;
    const recovery = this.verificationRecoveryStore();
    if (recovery === undefined) {
      throw new RunControllerInfrastructureError("Verification repair recovery is not configured.");
    }
    const failed = await recovery.getPlanExecutionSnapshot(repairContinuation.failedPlanId);
    if (failed === null) {
      throw new RunControllerInfrastructureError("Verification repair plan is unavailable.");
    }
    const failedCheckIds = new Set(repairContinuation.failedCheckIds);
    const repairContext = compileVerificationRepairContext({
      originalGoal: snapshot.run.goal,
      failedPlan: failed.plan,
      failedChecks: failed.plan.checks.filter((check) => failedCheckIds.has(check.id)),
      evidence: failed.evidence.filter((item) => repairContinuation.evidenceIds.includes(item.id)),
      changedFiles: snapshot.state?.changedFiles ?? [],
      repairCycle: repairContinuation.repairCycle,
    });
    return { text: repairContext.text };
  }

  /**
   * The RunController-owned durable open-Step commit.
   *
   * ```text
   * this is the only place a model turn's Step becomes durable
   * and it happens before any provider I/O
   * ```
   *
   * The boundary calls it; it is not the boundary's own commit. That is what keeps a single
   * lifecycle committer: a boundary object that held a store would be a second authority able to
   * write a Run status, and nothing would record which of the two actually did.
   *
   * It commits against the **effect-start revisions** the coordinator's decision was made from, so a
   * durable snapshot that moved after the decision cannot be opened as if it had not. The one
   * exception is an exact durable replay of the same turn, which resolves without committing: a
   * second commit would insert a second Step and publish a second `llm.started`.
   */
  private async openAgentTurn(pending: PendingAgentTurn): Promise<void> {
    const current = await this.load(pending.identity.runId);
    if (current.state === undefined) {
      throw new RunControllerInfrastructureError("Run state disappeared before provider turn");
    }

    const active = current.activeStep;
    const alreadyOpen =
      active !== undefined &&
      active.id === pending.step.id &&
      active.sequence === pending.step.sequence &&
      active.status === "RUNNING" &&
      current.run.currentStepId === pending.step.id &&
      current.state.currentStepId === pending.step.id;
    // An exact replay of a turn this ledger already opened. Resolving without committing is the
    // whole point: a second commit would insert a second Step and publish a second `llm.started`.
    if (alreadyOpen) return;

    this.assertBoundaryAuthority(current, pending);

    if (
      current.run.currentStepId !== undefined ||
      active !== undefined ||
      current.state.currentStepId !== undefined
    ) {
      throw new RunExecutionInvariantError(
        "A model turn cannot open while a different Step is already active.",
      );
    }

    // The Step becomes durable here, and only here. The Run and the AgentState are projected from
    // the *current* durable records, never from a pre-provider copy carried into the boundary.
    const activeRun = AgentRunSchema.parse({ ...current.run, currentStepId: pending.step.id });
    const activeState = beginAgentStepState(current.state, pending.step.id, pending.step.startedAt);
    const consumption = this.continuationConsumption(current, pending);

    const commit = await this.commit({
      run: activeRun,
      state: activeState,
      expectedStateRevision: pending.expectedStateRevision,
      expectedContinuationRevision: pending.expectedContinuationRevision,
      stepWrites: [{ operation: "INSERT", step: pending.step }],
      messagesToAppend: [],
      ...(consumption === "CONSUME" ? { continuation: { operation: "CLEAR" as const } } : {}),
      events: [
        ...(consumption === "CONSUME" && current.continuation?.type === "WAITING_RETRY"
          ? [
              this.eventFactory.retryStarted(
                current.run,
                pending.step,
                current.continuation.attempt,
                current.continuation.maxAttempts,
                this.nextEventId(),
                this.dependencies.clock.now(),
              ),
            ]
          : []),
        this.eventFactory.llmStarted(
          activeRun,
          pending.step,
          this.nextEventId(),
          this.dependencies.clock.now(),
        ),
      ],
    });
    this.notify(commit.events);
  }

  /**
   * Whether opening this turn consumes the durable continuation.
   *
   * ```text
   * RETRY              + WAITING_RETRY                -> consume
   * COMPLETION_REPAIR  + WAITING_VERIFICATION_REPAIR  -> consume
   * TOOL_RESULTS       + WAITING_TOOL_RESULTS         -> DO NOT consume
   * INITIAL / STEERING + any continuation             -> fail closed
   * ```
   *
   * A `TOOL_RESULTS` continuation is deliberately *not* cleared: it is the durable provenance the
   * effect settlement still needs, and clearing it would lose the source Step a later retry
   * inherits. Every other pairing is a mismatch between why the turn was advanced and what the Run
   * was actually parked on, so it fails closed rather than consuming a boundary nobody asked for.
   */
  private continuationConsumption(
    current: RunExecutionSnapshot,
    pending: PendingAgentTurn,
  ): "CONSUME" | "PRESERVE" {
    const continuation = current.continuation;
    switch (pending.advanceReason) {
      case "RETRY":
        if (continuation?.type !== "WAITING_RETRY") {
          throw new RunExecutionInvariantError(
            "A retry turn requires a WAITING_RETRY continuation to consume.",
          );
        }
        return "CONSUME";
      case "COMPLETION_REPAIR":
        if (continuation?.type !== "WAITING_VERIFICATION_REPAIR") {
          throw new RunExecutionInvariantError(
            "A completion-repair turn requires a WAITING_VERIFICATION_REPAIR continuation.",
          );
        }
        return "CONSUME";
      case "TOOL_RESULTS":
        if (continuation?.type !== "WAITING_TOOL_RESULTS") {
          throw new RunExecutionInvariantError(
            "A Tool-results turn requires an open WAITING_TOOL_RESULTS continuation.",
          );
        }
        return "PRESERVE";
      case "INITIAL":
      case "STEERING":
        if (continuation !== undefined) {
          throw new RunExecutionInvariantError(
            `An ${pending.advanceReason} turn must not hold a durable continuation.`,
          );
        }
        return "PRESERVE";
      default:
        return assertNeverAdvanceReason(pending.advanceReason);
    }
  }

  /**
   * Refuse a first open whose effect-start snapshot is no longer the durable state.
   *
   * The coordinator decided on one snapshot and the boundary commits against it. If the Run moved
   * under the effect — a different status, a different model, a different revision, a different Tool
   * provenance — opening the old turn would durably settle a Step the Run never allocated.
   */
  private assertBoundaryAuthority(current: RunExecutionSnapshot, pending: PendingAgentTurn): void {
    if (current.run.status !== "RUNNING") {
      throw new RunExecutionInvariantError(
        `A model turn cannot open against a ${current.run.status} Run.`,
      );
    }
    if (
      current.run.model.provider !== pending.model.provider ||
      current.run.model.model !== pending.model.model
    ) {
      throw new RunExecutionInvariantError(
        "Model turn boundary model does not match the Run's durable model.",
      );
    }
    // The CAS compares the revision *values* the decision was made from. An absent revision and an
    // unset marker are the same fact — "this Run has never had one" — so they are normalized rather
    // than distinguished: the granularity of the field is not part of what the boundary guards.
    if (current.stateRevision !== (pending.expectedStateRevision ?? undefined)) {
      throw new RunExecutionConflictError(
        "The AgentState moved between the execution decision and the durable boundary.",
      );
    }
    if (current.continuationRevision !== (pending.expectedContinuationRevision ?? undefined)) {
      throw new RunExecutionConflictError(
        "The Run continuation moved between the execution decision and the durable boundary.",
      );
    }
    if (pending.sourceStepId !== undefined) {
      const continuation = current.continuation;
      // A Tool resume is entered from either boundary that records one: an ordinary open Tool turn,
      // or a retry checkpoint whose preserved batch is being re-sent. Both must name the same
      // request Step — never the attempt that failed, and never the turn being opened.
      const recorded =
        continuation?.type === "WAITING_TOOL_RESULTS"
          ? continuation.sourceStepId
          : continuation?.type === "WAITING_RETRY" && continuation.mode === "TOOL_RESULTS"
            ? continuation.sourceStepId
            : undefined;
      if (recorded !== pending.sourceStepId) {
        throw new RunExecutionInvariantError(
          "A Tool-results turn must resume the Tool-request Step the continuation recorded.",
        );
      }
    }
  }

  private async settle(
    before: RunExecutionSnapshot,
    directive: AdvanceAgentDirective,
    result: AgentLoopAdvanceResult,
    observation: AgentTurnObservation,
  ): Promise<RunControllerResult> {
    const route = classifyAgentEffectSettlement({ result, directive, observation });

    // The canonical branch is planned or it fails loudly. A planner error is never caught and turned
    // into a compatibility settlement: that would leave two authorities able to settle one effect,
    // with nothing recording which of them actually did.
    switch (route.route) {
      case "CANONICAL_AGENT_EFFECT":
        return this.settleCanonicalAgentEffect(before, directive, route.result, observation);
      case "BUDGET_AUTHORITY": {
        const block = observation.admissionBlock;
        if (block === undefined || block.kind !== "EXCEEDED") {
          throw new RunControllerInvariantError(
            "A budget settlement requires the exact durable block the admission authority returned.",
          );
        }
        const current = await this.load(before.run.id);
        return this.finalizeBudgetExceeded(current, block);
      }
      case "TERMINATION_AUTHORITY":
        return this.finalizeAbortedExecution(before);
      case "VERIFICATION_COMPATIBILITY":
        return this.openCompletionBoundary(
          before,
          result as Extract<AgentLoopAdvanceResult, { kind: "FINAL_CANDIDATE" }>,
          observation,
        );
      case "RETRY_COMPATIBILITY":
        return this.settleRetryCompatibility(before, result as AgentLoopFailedResult, observation);
    }
  }

  /**
   * Settle an Agent effect the frozen planner can express.
   *
   * ```text
   * PLAN -> MATERIALIZE -> COMMIT -> NOTIFY
   * ```
   *
   * The order is the contract. Events are materialized into the commit and the commit is durable
   * before anything is published, so a failed write can never leave a subscriber holding an event
   * for a transition that did not happen.
   *
   * Nothing here re-decides the transition. The planner derives the next Run, AgentState, Step
   * settlement, continuation and append list from the durable snapshot and the frozen result; this
   * method only gives it a fresh snapshot, commits what it returns, and reports the outcome.
   *
   * Whether a provider turn actually ran comes from the Core-private `AgentTurnObservation`, never
   * from a legacy facade and never inferred from the outcome: a classifier that refuses a model's
   * output completes a provider turn *and* fails the Reason, and the ledger records both.
   */
  private async settleCanonicalAgentEffect(
    before: RunExecutionSnapshot,
    directive: AdvanceAgentDirective,
    result: AgentLoopAdvanceResult,
    observation: AgentTurnObservation,
  ): Promise<RunControllerResult> {
    // The revision the commit is planned against is the one that is durable *now*, not the one the
    // effect started from: a provider turn is long enough for the Run to have moved under it.
    const current = await this.load(before.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "CANCELLED") return this.finalizeCancellation(current);
    if (authority === "TIMEOUT") return this.finalizeTimeout(current);
    if (authority === "TERMINAL") return this.resultFromSnapshot(current);
    if (authority === "UNEXPECTED_ABORT") {
      throw new RunControllerInvariantError("Run execution aborted without a known authority");
    }
    // Budget governance runs before the transition: a turn that spent the budget settles the Run as
    // exceeded instead of planning a transition.
    const budgetSettlement = await this.settleBudgetAttempt(current, result);
    if (budgetSettlement !== undefined) {
      return this.finalizeBudgetExceeded(current, budgetSettlement);
    }

    const now = this.dependencies.clock.now();
    const snapshot = toAgentExecutionSnapshot(current);
    const effect: RunExecutionEffectResult = { kind: "AGENT", result };

    const planned = this.transitionPlanner.plan({ snapshot, directive, effect, now });
    const materialized = this.eventMaterializer.materialize({
      snapshot: current,
      directive,
      effect,
      plannedCommit: this.agentTurnProvenance(
        this.observationPolicyProvenance(planned, result),
        result,
      ),
      now,
      providerTurnState: observation.providerTurnState,
      ownership: { eventIds: this.dependencies.eventIdFactory },
    });

    const committed = await this.commit(materialized);
    this.notify(committed.events);
    return this.resultFromSnapshot(committed.snapshot);
  }

  /**
   * Snapshot the observation policy a Tool-requesting turn was prepared under.
   *
   * ```text
   * TRANSITIONAL — Core-only settlement sidecar
   * ```
   *
   * The frozen planner plans the durable `WAITING_TOOL_RESULTS` checkpoint from the directive it
   * was given, and the frozen directive carries the *requesting* Run's policy rather than the one
   * the Context Engine actually prepared the turn under. Those are the same value whenever a turn
   * is prepared and settled in one process — and they are exactly what can differ across a
   * restart, which is the case the durable field exists for.
   *
   * So the one authoritative source is applied here, narrowly, to the checkpoint the planner
   * already wrote: the `observationPolicy` that travelled with this turn's `PreparedModelContext`.
   * It may set that field and nothing else — no transition, no Step, no message and no event is
   * touched — and a non-Tool-requesting effect, or a checkpoint that already carries a policy, is
   * returned unchanged.
   *
   * A later Tool projection therefore uses the policy that was in force when the model asked for
   * the batch, not whatever the restarted process happens to default to.
   */
  private observationPolicyProvenance(
    commit: RunExecutionCommit,
    result: AgentLoopAdvanceResult,
  ): RunExecutionCommit {
    if (result.kind !== "TOOL_REQUESTS") return commit;
    if (commit.continuation?.operation !== "SET") return commit;
    const checkpoint = commit.continuation.checkpoint;
    if (checkpoint.type !== "WAITING_TOOL_RESULTS") return commit;
    if (checkpoint.observationPolicy !== undefined) return commit;
    return {
      ...commit,
      continuation: {
        operation: "SET",
        checkpoint: {
          ...checkpoint,
          observationPolicy: result.context.observationPolicy,
        },
        updatedAt: commit.continuation.updatedAt,
      },
    };
  }

  /**
   * Preserve the durable reasoning summary the planner cannot produce.
   *
   * ```text
   * TRANSITIONAL — Core-only settlement sidecar
   * ```
   *
   * `summarizeAgentDecision` is a real projection of the frozen decision, and the Step has always
   * persisted it. The planner cannot produce it: the frozen `AgentLoopAdvanceResult` reports a
   * decision, not prose, and inventing a sentence the model never said is not an option. So the one
   * authoritative source Core does have is applied here, narrowly, to the Step the planner already
   * settled — and to nothing else.
   *
   * A result without a settled Step — a failure the planner did not settle one for — is returned
   * unchanged, with no summary and no invention.
   */
  private agentTurnProvenance(
    commit: RunExecutionCommit,
    result: AgentLoopAdvanceResult,
  ): RunExecutionCommit {
    if (result.kind !== "TOOL_REQUESTS" && result.kind !== "FINAL_CANDIDATE") return commit;
    const settled = commit.stepWrites.find((write) => write.step.status === "COMPLETED");
    if (settled === undefined) return commit;

    const reasoningSummary = summarizeAgentDecision(result.decision);
    return {
      ...commit,
      stepWrites: commit.stepWrites.map((write) =>
        write === settled ? { ...write, step: { ...write.step, reasoningSummary } } : write,
      ),
    };
  }

  /**
   * Settle a `FINAL_CANDIDATE` through the verification compatibility bridge.
   *
   * ```text
   * TRANSITIONAL — Phase 3E owns completion authority
   * ```
   *
   * The frozen planner refuses this branch on purpose: moving a Run to `VERIFYING` needs a real
   * `VerificationPlanId`, and a pure planner that minted one would be a second completion authority.
   * So the bridge consumes the **canonical** result — the exact object `advance()` returned — rather
   * than a legacy projection of it:
   *
   * ```text
   * current durable snapshot        the Step comes from current.activeStep, never from an execution copy
   * AdvanceAgentDirective           why this turn ran
   * AgentLoopFinalCandidateResult   the decision, the turn, the usage and the messages to append
   * AgentTurnObservation            whether a provider turn actually completed
   * projectFacts                    the host's fresh verification profile
   * ```
   *
   * The Run moves to `VERIFYING` with `AWAITING_VERIFICATION`. It never completes here, and no
   * `CompletionGate` implementation exists anywhere in this path.
   */
  /**
   * Open the durable completion boundary of a final candidate.
   *
   * ```text
   * settle the candidate's Agent Step          exactly once
   * append the candidate's own messages        exactly once
   * create the verification plan               identity minted here, by the host
   * commit Run + AgentState + Step + plan      one transaction
   *        ↓
   * return to the Run execution loop           the coordinator decides what runs next
   * ```
   *
   * This is the whole of what a `FINAL_CANDIDATE` does. It used to continue straight into the
   * verification workflow; Phase 3E ends that ownership here. Verification is an *effect* now, and the
   * only authority that decides which effect runs next is the coordinator — so this method commits the
   * boundary and returns, and the loop asks the coordinator again.
   *
   * It is a compatibility bridge in one respect and one only: the frozen planner cannot mint a
   * `VerificationPlanId`, so the plan is created here by the host-side completion gate and travels into
   * the commit on the completion persistence port. Every other part of the transition — the Step
   * settlement, the state, the status, the continuation, the candidate messages — is described by the
   * planner, exactly as it is for every other Agent effect.
   */
  private async openCompletionBoundary(
    before: RunExecutionSnapshot,
    result: Extract<AgentLoopAdvanceResult, { kind: "FINAL_CANDIDATE" }>,
    observation: AgentTurnObservation,
  ): Promise<RunControllerResult> {
    const current = await this.load(before.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "CANCELLED") return this.finalizeCancellation(current);
    if (authority === "TIMEOUT") return this.finalizeTimeout(current);
    if (authority === "TERMINAL") return this.resultFromSnapshot(current);
    if (authority === "UNEXPECTED_ABORT") {
      throw new RunControllerInvariantError("Run execution aborted without a known authority");
    }
    // Budget governance runs before the boundary: an attempt that spent the budget settles the Run as
    // exceeded instead of opening a verification nobody can afford to run.
    const budgetSettlement = await this.settleBudgetAttempt(current, result);
    if (budgetSettlement !== undefined) {
      return this.finalizeBudgetExceeded(current, budgetSettlement);
    }
    if (current.state === undefined) {
      throw new RunControllerInfrastructureError("Run state disappeared during settlement");
    }

    const now = this.dependencies.clock.now();
    const step = this.requireExecutedStep(current, result.turn.stepId, "A final candidate");
    const settledState = this.settleExecutedStepState(current.state, step, result, now);
    const completedStep = completeAgentStep(step, {
      finishedAt: now,
      reasoningSummary: summarizeAgentDecision(result.decision),
    });
    // The Run holds a candidate and is about to verify it, so its AgentState is VERIFYING. The step
    // count settles exactly once, on this same transition.
    const decisionState = markAgentStateVerifying(settledState, now);
    const run = AgentRunSchema.parse({
      ...current.run,
      status: "VERIFYING",
      currentStepId: undefined,
    });
    const continuation = {
      type: "AWAITING_VERIFICATION" as const,
      runId: run.id,
      sourceStepId: step.id,
      verificationPlanId: "" as never,
      finalDecision: result.decision,
    };

    const planner = createRunCandidateBoundaryPlanner({
      run: current.run,
      state: decisionState,
      continuation: { ...continuation, verificationPlanId: "" as never },
      clock: this.dependencies.clock,
      ...(this.dependencies.verificationPlanner === undefined
        ? {}
        : { planner: this.dependencies.verificationPlanner }),
      ...(this.dependencies.verificationPlanIdFactory === undefined
        ? {}
        : { planIdFactory: () => this.dependencies.verificationPlanIdFactory!.create() }),
      ...(this.dependencies.verificationCheckIdFactory === undefined
        ? {}
        : { checkIdFactory: () => this.dependencies.verificationCheckIdFactory!.create() }),
    });
    const opening = planner.planCandidateBoundary(result.decision);

    const commit = await this.commitCandidateBoundary({
      run,
      state: decisionState,
      verificationPlan: opening.plan,
      continuation: { ...continuation, verificationPlanId: opening.plan.id },
      expectedStateRevision: current.stateRevision ?? null,
      expectedContinuationRevision: current.continuationRevision ?? null,
      stepWrites: [{ operation: "UPDATE", step: completedStep }],
      messagesToAppend: appendMessages(current, result.messagesToAppend, step.id, now),
      events: [
        ...this.successEvents(current.run, decisionState, completedStep, observation, now),
        this.eventFactory.statusChanged(
          current.run,
          "RUNNING",
          "VERIFYING",
          this.nextEventId(),
          now,
        ),
        this.eventFactory.verificationPlanned(current.run, opening.plan, this.nextEventId(), now),
      ],
    });
    void commit;
    // The boundary is durable. The loop asks the coordinator again, which decides
    // `EVALUATE_COMPLETION` from the state this commit just wrote.
    return this.driveRunExecutionLocked(commit.snapshot, "EXECUTE");
  }

  /**
   * Settle a retryable provider failure through the Run Retry Policy bridge.
   *
   * ```text
   * TRANSITIONAL — Phase 10C owns the provider retry policy
   * ```
   *
   * The attempt's Step is settled **before** the policy is asked, because the direct AgentLoop does
   * not settle a Step itself: one provider turn is one Agent Step attempt, and `UsageState.steps`
   * counts settled attempts including failed ones.
   *
   * ```text
   * failedStep   = failAgentStep(current.activeStep, now)
   * settledState = settleAgentStepState(current.state, { stepId, usage, now })
   * ```
   *
   * `settledState.usage.steps` is therefore the count *after* this attempt, which is exactly the
   * number the policy's `maxSteps` gate must compare against. The Step is never a legacy
   * `execution.step`: the source of truth is the Run's own active Step, and `result.turn.stepId`
   * must name it.
   */
  private async settleRetryCompatibility(
    before: RunExecutionSnapshot,
    result: AgentLoopFailedResult,
    observation: AgentTurnObservation,
  ): Promise<RunControllerResult> {
    const current = await this.load(before.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "CANCELLED") return this.finalizeCancellation(current);
    if (authority === "TIMEOUT") return this.finalizeTimeout(current);
    if (authority === "TERMINAL") return this.resultFromSnapshot(current);
    if (authority === "UNEXPECTED_ABORT") {
      throw new RunControllerInvariantError("Run execution aborted without a known authority");
    }
    const budgetSettlement = await this.settleBudgetAttempt(current, result);
    if (budgetSettlement !== undefined) {
      return this.finalizeBudgetExceeded(current, budgetSettlement);
    }
    if (current.state === undefined) {
      throw new RunControllerInfrastructureError("Run state disappeared during settlement");
    }

    const now = this.dependencies.clock.now();
    const step = this.requireExecutedStep(current, result.turn.stepId, "A provider failure");
    const failedStep = failAgentStep(step, now);
    const settledState = this.settleExecutedStepState(current.state, step, result, now);
    const retry = toDurableRetryMetadata(result.retry);
    if (retry === undefined) {
      throw new RunControllerInvariantError(
        "A retryable provider failure carried no durable retry code.",
      );
    }

    const deadline = deriveRunDeadline(current.run);
    const attempt = before.continuation?.type === "WAITING_RETRY" ? before.continuation.attempt : 1;
    const decision = this.retryController.decide({
      retryable: true,
      attempt,
      steps: settledState.usage.steps,
      maxSteps: current.run.limits.maxSteps,
      now,
      ...(deadline === undefined ? {} : { deadlineAt: deadline.deadlineAt }),
      ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs }),
    });
    const retryContext = this.retryResumeContext(before.continuation);

    /* The step budget. The Step settlement is committed on this path too, so no attempt is lost. */
    if (decision.kind === "STOP" && decision.reason === "MAX_STEPS_REACHED") {
      const state = markAgentStateMaxStepsReached(settledState, now);
      const run = AgentRunSchema.parse({
        ...current.run,
        status: "MAX_STEPS_REACHED",
        currentStepId: undefined,
        finishedAt: now,
      });
      const commit = await this.commit({
        run,
        state,
        expectedStateRevision: current.stateRevision ?? null,
        expectedContinuationRevision: current.continuationRevision ?? null,
        stepWrites: [{ operation: "UPDATE", step: failedStep }],
        messagesToAppend: [],
        ...(current.continuation === undefined ? {} : { continuation: { operation: "CLEAR" } }),
        events: [
          this.eventFactory.llmFailed(
            current.run,
            failedStep,
            result.error,
            this.nextEventId(),
            now,
          ),
          this.eventFactory.maxSteps(
            current.run,
            state,
            {
              type: "MAX_STEPS_REACHED",
              stepsCompleted: state.usage.steps,
              maxSteps: current.run.limits.maxSteps,
            },
            this.nextEventId(),
            now,
          ),
          this.eventFactory.statusChanged(
            current.run,
            "RUNNING",
            "MAX_STEPS_REACHED",
            this.nextEventId(),
            now,
          ),
        ],
      });
      this.notify(commit.events);
      return this.resultFromSnapshot(commit.snapshot);
    }

    /* The original deadline, chunked to the deadline itself rather than a fresh attempt time. */
    if (decision.kind === "STOP" && decision.reason === "DEADLINE_EXCEEDED") {
      if (deadline === undefined) {
        throw new RunControllerInvariantError(
          "A deadline-exceeded retry decision has no Run deadline",
        );
      }
      const run = AgentRunSchema.parse({ ...current.run, currentStepId: undefined });
      const commit = await this.commit({
        run,
        state: settledState,
        expectedStateRevision: current.stateRevision ?? null,
        expectedContinuationRevision: current.continuationRevision ?? null,
        stepWrites: [{ operation: "UPDATE", step: failedStep }],
        messagesToAppend: [],
        continuation: {
          operation: "SET",
          checkpoint: {
            type: "WAITING_RETRY",
            runId: run.id,
            failedStepId: step.id,
            attempt: attempt + 1,
            maxAttempts: this.retryController.maxAttempts,
            nextAttemptAt: deadline.deadlineAt,
            errorCode: toDurableRetryCode(retry.code),
            ...retryContext,
          },
          updatedAt: now,
        },
        events: [
          this.eventFactory.llmFailed(
            current.run,
            failedStep,
            result.error,
            this.nextEventId(),
            now,
          ),
        ],
      });
      this.notify(commit.events);
      return this.resultFromSnapshot(commit.snapshot);
    }

    /* Attempts exhausted: the Run fails, with the same event vocabulary as the planner's branch. */
    if (decision.kind === "STOP") {
      const state = markAgentStateFailed(settledState, result.error, now);
      const failedRun = markAgentRunFailed(
        AgentRunSchema.parse({ ...current.run, currentStepId: undefined }),
        now,
      );
      const commit = await this.commit({
        run: failedRun,
        state,
        expectedStateRevision: current.stateRevision ?? null,
        expectedContinuationRevision: current.continuationRevision ?? null,
        stepWrites: [{ operation: "UPDATE", step: failedStep }],
        // The caller's turn input is real work the ledger already carries: it is persisted so a
        // failed Run records the user turn it failed on, exactly as the canonical planner's own
        // `FAILED` branch does. No *provider* output is appended — the attempt produced none.
        messagesToAppend: appendMessages(current, result.messagesToAppend, undefined, now),
        ...(current.continuation === undefined ? {} : { continuation: { operation: "CLEAR" } }),
        events: this.failureEvents(
          current.run,
          failedRun,
          result.error,
          failedStep,
          now,
          observation.providerTurnState,
        ),
      });
      this.notify(commit.events);
      return this.resultFromSnapshot(commit.snapshot);
    }

    const nextAttemptAt = addTimestamp(now, decision.delayMs);
    const run = AgentRunSchema.parse({ ...current.run, currentStepId: undefined });
    const commit = await this.commit({
      run,
      state: settledState,
      expectedStateRevision: current.stateRevision ?? null,
      expectedContinuationRevision: current.continuationRevision ?? null,
      stepWrites: [{ operation: "UPDATE", step: failedStep }],
      // A failed provider attempt contributes no message. Appending the turn input here would make
      // the next attempt's request duplicate its own `USER_INPUT` or `TOOL_RESULTS`.
      messagesToAppend: [],
      continuation: {
        operation: "SET",
        checkpoint: {
          type: "WAITING_RETRY",
          runId: run.id,
          failedStepId: step.id,
          attempt: decision.attempt,
          maxAttempts: this.retryController.maxAttempts,
          nextAttemptAt,
          errorCode: toDurableRetryCode(retry.code),
          ...retryContext,
        },
        updatedAt: now,
      },
      events: [
        this.eventFactory.llmFailed(current.run, failedStep, result.error, this.nextEventId(), now),
        this.eventFactory.retryScheduled(
          current.run,
          failedStep,
          decision.attempt,
          this.retryController.maxAttempts,
          decision.delayMs,
          nextAttemptAt,
          toDurableRetryCode(retry.code),
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    this.scheduleRetry(run.id, nextAttemptAt, deadline?.deadlineAt);
    return this.resultFromSnapshot(commit.snapshot);
  }

  /**
   * The retry provenance a new checkpoint carries forward.
   *
   * A first retry of a Tool resume captures the original Tool request's Step on the way in, so it
   * can never be confused with `failedStepId`. A later retry carries the same value forward
   * unchanged — never re-derived, and never replaced by the attempt that just failed.
   */
  private retryResumeContext(
    previous: RunExecutionSnapshot["continuation"],
  ): WaitingRetryResumeContext {
    if (previous?.type === "WAITING_TOOL_RESULTS" && previous.receivedResults !== undefined) {
      return {
        mode: "TOOL_RESULTS",
        pendingDecision: previous.pendingDecision,
        receivedResults: previous.receivedResults,
        sourceStepId: previous.sourceStepId,
      };
    }
    if (previous?.type === "WAITING_RETRY" && previous.mode === "TOOL_RESULTS") {
      return {
        mode: "TOOL_RESULTS",
        pendingDecision: previous.pendingDecision,
        receivedResults: previous.receivedResults,
        ...(previous.sourceStepId === undefined ? {} : { sourceStepId: previous.sourceStepId }),
      };
    }
    return { mode: "START" };
  }

  /**
   * The Step a canonical Agent effect actually ran as.
   *
   * It comes from the Run's own durable `activeStep`, never from a legacy execution copy, and it
   * must be the Step the frozen result names. A mismatch means the Run's ledger and the effect
   * disagree about which attempt this was, which is not something to settle around.
   */
  private requireExecutedStep(
    current: RunExecutionSnapshot,
    stepId: StepId,
    what: string,
  ): AgentStep {
    const active = current.activeStep;
    if (active === undefined) {
      throw new RunControllerInvariantError(`${what} requires the Run's active Step.`);
    }
    if (active.id !== stepId) {
      throw new RunControllerInvariantError(
        `${what} ran as Step ${stepId} but the Run's active Step is ${active.id}.`,
      );
    }
    if (active.status !== "RUNNING") {
      throw new RunControllerInvariantError(
        `${what} requires a RUNNING Step, found ${active.status}.`,
      );
    }
    return active;
  }

  /** Clear the active Step and settle the attempt's usage, exactly once. */
  private settleExecutedStepState(
    state: AgentState,
    step: AgentStep,
    result: Extract<AgentLoopAdvanceResult, { kind: "FINAL_CANDIDATE" | "FAILED" }>,
    now: AgentRun["createdAt"],
  ): AgentState {
    const usage = resolveResultUsage(result);
    return settleAgentStepState(state, {
      stepId: step.id,
      ...(usage === undefined ? {} : { usage }),
      now,
    });
  }

  /**
   * Settle the provider attempt's durable budget entry.
   *
   * The Step is the Run's own active Step, which is the identity the reservation was made under. A
   * cancelled attempt is settled conservatively rather than released: the reservation was made
   * before the provider could answer, so releasing it would under-count real spend.
   */
  private async settleBudgetAttempt(
    current: RunExecutionSnapshot,
    result: AgentLoopAdvanceResult,
  ): Promise<Extract<AgentBudgetBlock, { kind: "EXCEEDED" }> | undefined> {
    const budget = this.dependencies.budget;
    const step = current.activeStep;
    if (budget === undefined || step === undefined) return undefined;
    if (result.kind === "CANCELLED") {
      await budget.markLLMConservative?.({
        runId: current.run.id,
        stepId: step.id,
        settledAt: this.dependencies.clock.now(),
      });
      return undefined;
    }
    const usage = resolveResultUsage(result);
    const settlement = await budget.settleLLM({
      runId: current.run.id,
      stepId: step.id,
      ...(usage === undefined ? {} : { usage }),
      settledAt: this.dependencies.clock.now(),
    });
    return settlement?.kind === "EXCEEDED" ? settlement : undefined;
  }

  private async finalizeCancellation(before: RunExecutionSnapshot): Promise<RunControllerResult> {
    const current = await this.load(before.run.id);
    this.retryRegistry.disarm(current.run.id);
    if (current.run.status === "CANCELLED") return this.resultFromSnapshot(current);
    const cleanup = await this.cancelOwnedResources(current.run.id);
    if (!cleanup.confirmed) {
      return {
        status: "CANCELLATION_PENDING",
        run: current.run,
        ...(current.state === undefined ? {} : { state: current.state }),
      };
    }
    const now = this.dependencies.clock.now();
    // The Step the termination authority settles is the Run's own active Step, never a copy a
    // legacy execution carried: the direct AgentLoop does not settle a Step itself, so there is
    // exactly one place that does (§88).
    let state = current.state;
    let step: AgentStep | undefined;
    if (state !== undefined && state.currentStepId !== undefined) {
      const activeStep = current.activeStep;
      if (activeStep === undefined || activeStep.id !== state.currentStepId) {
        throw new RunControllerInvariantError("Cancellation cannot reconcile the active Step");
      }
      step = cancelAgentStep(activeStep, now);
      state = cancelAgentStepState(state, {
        stepId: state.currentStepId,
        now,
        countAttempt: true,
      });
    }
    if (state !== undefined && state.status !== "CANCELLED") {
      state = markAgentStateCancelled(state, now);
    }
    if (state === undefined && current.run.status !== "PENDING") {
      throw new RunControllerInvariantError("non-PENDING cancellation has no AgentState");
    }
    const run = markAgentRunCancelled(
      AgentRunSchema.parse({ ...current.run, currentStepId: undefined }),
      now,
    );
    const approvals = this.dependencies.approvals;
    if (approvals?.cancelPendingByRun !== undefined) {
      await approvals.cancelPendingByRun(run.id);
    }
    const commit = await this.commit({
      run,
      ...(state === undefined ? {} : { state }),
      expectedStateRevision: current.stateRevision ?? null,
      expectedContinuationRevision: current.continuationRevision ?? null,
      stepWrites: step === undefined ? [] : [{ operation: "UPDATE", step }],
      messagesToAppend: [],
      ...(current.continuation === undefined
        ? {}
        : { continuation: { operation: "CLEAR" as const } }),
      events: [
        this.eventFactory.statusChanged(
          current.run,
          current.run.status,
          "CANCELLED",
          this.nextEventId(),
          now,
        ),
        this.eventFactory.cancelled(current.run, this.nextEventId(), now),
      ],
    });
    this.notify(commit.events);
    return this.resultFromSnapshot(commit.snapshot);
  }

  private async finalizeAbortedExecution(
    before: RunExecutionSnapshot,
  ): Promise<RunControllerResult> {
    const current = await this.load(before.run.id);
    const authority = this.resolveAuthority(current, true);
    if (authority === "CANCELLED") return this.finalizeCancellation(current);
    if (authority === "TIMEOUT") return this.finalizeTimeout(current);
    if (authority === "TERMINAL") return this.resultFromSnapshot(current);
    throw new RunControllerInvariantError("Run execution aborted without a known authority");
  }

  private async finalizeTimeout(before: RunExecutionSnapshot): Promise<RunControllerResult> {
    const current = await this.load(before.run.id);
    this.retryRegistry.disarm(current.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "TERMINAL") return this.resultFromSnapshot(current);
    if (authority === "CANCELLED") return this.finalizeCancellation(current);
    if (authority !== "TIMEOUT") {
      throw new RunControllerInvariantError("Timeout finalization requires an expired Run");
    }
    const cleanup = await this.cancelOwnedResources(current.run.id);
    if (!cleanup.confirmed) {
      return {
        status: "TIMEOUT_PENDING",
        run: current.run,
        ...(current.state === undefined ? {} : { state: current.state }),
      };
    }
    const latest = await this.load(current.run.id);
    if (isTerminal(latest.run.status)) return this.resultFromSnapshot(latest);
    if (latest.cancellationIntent !== undefined) return this.finalizeCancellation(latest);
    if (!this.isExpired(latest)) return this.resultFromSnapshot(latest);

    const now = this.dependencies.clock.now();
    let state = latest.state;
    let step: AgentStep | undefined;
    if (state !== undefined && state.currentStepId !== undefined) {
      const activeStep = latest.activeStep;
      if (activeStep === undefined || activeStep.id !== state.currentStepId) {
        throw new RunControllerInvariantError("Timeout cannot reconcile the active Step");
      }
      step = cancelAgentStep(activeStep, now);
      state = cancelAgentStepState(state, {
        stepId: state.currentStepId,
        now,
        countAttempt: true,
      });
    }
    if (state !== undefined && state.status !== "TIMEOUT") {
      state = markAgentStateTimedOut(state, now);
    }
    if (state === undefined) {
      throw new RunControllerInvariantError("non-PENDING timeout has no AgentState");
    }
    const deadline = deriveRunDeadline(latest.run);
    if (deadline === undefined) {
      throw new RunControllerInvariantError("timed out Run has no durable start timestamp");
    }
    const run = markAgentRunTimedOut(
      AgentRunSchema.parse({ ...latest.run, currentStepId: undefined }),
      now,
    );
    const approvals = this.dependencies.approvals;
    if (approvals?.cancelPendingByRun !== undefined) {
      await approvals.cancelPendingByRun(run.id);
    }
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: latest.stateRevision ?? null,
      expectedContinuationRevision: latest.continuationRevision ?? null,
      stepWrites: step === undefined ? [] : [{ operation: "UPDATE", step }],
      messagesToAppend: [],
      ...(latest.continuation === undefined
        ? {}
        : { continuation: { operation: "CLEAR" as const } }),
      events: [
        this.eventFactory.statusChanged(
          latest.run,
          latest.run.status,
          "TIMEOUT",
          this.nextEventId(),
          now,
        ),
        this.eventFactory.timedOut(latest.run, deadline.deadlineAt, this.nextEventId(), now),
      ],
    });
    this.deadlineRegistry.disarm(run.id);
    this.notify(commit.events);
    return this.resultFromSnapshot(commit.snapshot);
  }

  private async finalizeBudgetExceeded(
    before: RunExecutionSnapshot,
    block: Extract<AgentBudgetBlock, { kind: "EXCEEDED" }>,
  ): Promise<RunControllerResult> {
    const current = await this.load(before.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "CANCELLED") return this.finalizeCancellation(current);
    if (authority === "TIMEOUT") return this.finalizeTimeout(current);
    if (authority === "TERMINAL") return this.resultFromSnapshot(current);
    this.retryRegistry.disarm(current.run.id);
    this.deadlineRegistry.disarm(current.run.id);
    const cleanup = await this.cancelOwnedResources(current.run.id);
    if (!cleanup.confirmed) {
      return {
        status: "BUDGET_EXCEEDED_PENDING",
        run: current.run,
        ...(current.state === undefined ? {} : { state: current.state }),
      };
    }
    const latest = await this.load(current.run.id);
    if (latest.cancellationIntent !== undefined) return this.finalizeCancellation(latest);
    if (isTerminal(latest.run.status)) return this.resultFromSnapshot(latest);
    const now = this.dependencies.clock.now();
    let state = latest.state;
    let step = latest.activeStep;
    if (state !== undefined && state.currentStepId !== undefined) {
      if (step === undefined || step.id !== state.currentStepId) {
        throw new RunControllerInvariantError(
          "Budget finalization cannot reconcile the active Step",
        );
      }
      step = cancelAgentStep(step, now);
      state = cancelAgentStepState(state, {
        stepId: state.currentStepId,
        now,
        countAttempt: true,
      });
    }
    if (state === undefined) {
      throw new RunControllerInvariantError("non-PENDING budget finalization has no AgentState");
    }
    if (state.status !== "BUDGET_EXCEEDED") {
      state = markAgentStateBudgetExceeded(state, now);
    }
    const run = markAgentRunBudgetExceeded(
      AgentRunSchema.parse({ ...latest.run, currentStepId: undefined }),
      now,
    );
    await this.dependencies.approvals?.cancelPendingByRun?.(run.id);
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: latest.stateRevision ?? null,
      expectedContinuationRevision: latest.continuationRevision ?? null,
      stepWrites: step === undefined ? [] : [{ operation: "UPDATE", step }],
      messagesToAppend: [],
      ...(latest.continuation === undefined
        ? {}
        : { continuation: { operation: "CLEAR" as const } }),
      events: [
        this.eventFactory.budgetExceeded(latest.run, block, this.nextEventId(), now),
        this.eventFactory.statusChanged(
          latest.run,
          latest.run.status,
          "BUDGET_EXCEEDED",
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    return this.resultFromSnapshot(commit.snapshot);
  }

  private async commitFailure(
    current: RunExecutionSnapshot,
    run: AgentRun,
    state: AgentState,
    step: AgentStep | undefined,
  ): Promise<{ snapshot: RunExecutionSnapshot; events: readonly DurableAgentEvent[] }> {
    const error = state.errors.at(-1)!;
    try {
      return await this.commit({
        run,
        state,
        expectedStateRevision: current.stateRevision ?? null,
        expectedContinuationRevision: current.continuationRevision ?? null,
        stepWrites: step === undefined ? [] : [{ operation: "UPDATE", step }],
        messagesToAppend: [],
        ...(current.continuation === undefined
          ? {}
          : { continuation: { operation: "CLEAR" as const } }),
        events: this.failureEvents(current.run, run, error, step, this.dependencies.clock.now()),
      });
    } catch (commitError) {
      throw new RunControllerInfrastructureError("Unable to persist Run failure", {
        cause: commitError,
      });
    }
  }

  /**
   * The durable events of a terminal failure.
   *
   * A provider attempt that really failed is described by `llm.failed` *before* the sanitized
   * `error`, so the ledger reads in the order Phase 11D froze. Whether the provider was contacted
   * is read from the Core-private observation, never inferred from the outcome: a classifier that
   * refuses a model's answer fails the Reason while the provider turn itself completed.
   */
  private failureEvents(
    run: AgentRun,
    failedRun: AgentRun,
    error: AgentError,
    step: AgentStep | undefined,
    timestamp: AgentRun["createdAt"],
    providerTurnState: AgentProviderTurnState = "NOT_STARTED",
  ): DurableEventDraft[] {
    return [
      ...(providerTurnState === "FAILED" && step !== undefined
        ? [this.eventFactory.llmFailed(run, step, error, this.nextEventId(), timestamp)]
        : []),
      this.eventFactory.error(run, error, step?.id, this.nextEventId(), timestamp),
      this.eventFactory.statusChanged(
        run,
        run.status,
        failedRun.status,
        this.nextEventId(),
        timestamp,
      ),
      this.eventFactory.failed(run, error, this.nextEventId(), timestamp),
    ];
  }

  /**
   * The durable events of a settled successful turn.
   *
   * `llm.completed` is recorded when the provider really answered, whatever the classifier then
   * decided about the answer, and the reasoning summary is recorded only because the Step already
   * carries it. The fact that the provider answered comes from the Core-private observation.
   */
  private successEvents(
    run: AgentRun,
    state: AgentState,
    step: AgentStep,
    observation: AgentTurnObservation,
    timestamp: AgentRun["createdAt"],
  ): DurableEventDraft[] {
    const events: DurableEventDraft[] = [];
    if (observation.providerTurnState === "COMPLETED") {
      events.push(this.eventFactory.llmCompleted(run, state, step, this.nextEventId(), timestamp));
    }
    if (step.reasoningSummary !== undefined) {
      events.push(
        this.eventFactory.reasoning(
          run,
          state,
          step,
          step.reasoningSummary,
          this.nextEventId(),
          timestamp,
        ),
      );
    }
    return events;
  }

  private async recoverStaleStep(snapshot: RunExecutionSnapshot): Promise<RunControllerResult> {
    if (snapshot.state === undefined || snapshot.activeStep === undefined) {
      throw new RunControllerInputError("stale Step recovery requires Run, State, and Step");
    }
    const now = this.dependencies.clock.now();
    const failedStep = failAgentStep(snapshot.activeStep, now);
    const settled = settleAgentStepState(snapshot.state, { stepId: snapshot.activeStep.id, now });
    const state = markAgentStateFailed(settled, STALE_STEP_ERROR, now);
    const run = markAgentRunFailed(
      AgentRunSchema.parse({ ...snapshot.run, currentStepId: undefined }),
      now,
    );
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: snapshot.stateRevision ?? null,
      expectedContinuationRevision: snapshot.continuationRevision ?? null,
      stepWrites: [{ operation: "UPDATE", step: failedStep }],
      messagesToAppend: [],
      ...(snapshot.continuation === undefined
        ? {}
        : { continuation: { operation: "CLEAR" as const } }),
      events: this.failureEvents(snapshot.run, run, STALE_STEP_ERROR, failedStep, now),
    });
    this.notify(commit.events);
    return this.resultFromSnapshot(commit.snapshot);
  }

  private async load(runId: RunId): Promise<RunExecutionSnapshot> {
    let snapshot: RunExecutionSnapshot | null;
    try {
      snapshot = await this.dependencies.executionStore.load(runId);
    } catch (error) {
      if (error instanceof RunExecutionInvariantError) {
        throw new RunControllerInvariantError(error.message, { cause: error });
      }
      throw error;
    }
    if (snapshot === null) throw new RunControllerInputError(`Run ${runId} was not found`);
    try {
      assertRunExecutionInvariant(snapshot);
    } catch (error) {
      if (error instanceof RunExecutionInvariantError) {
        throw new RunControllerInvariantError(error.message, { cause: error });
      }
      throw error;
    }
    if (snapshot.state !== undefined && this.dependencies.budget?.reconcileState !== undefined) {
      snapshot = {
        ...snapshot,
        state: await this.dependencies.budget.reconcileState(snapshot.state),
      };
    }
    this.reconcileDeadline(snapshot);
    this.reconcileRetry(snapshot);
    return snapshot;
  }

  private async commit(command: RunExecutionCommit) {
    try {
      return await this.dependencies.executionStore.commit(command);
    } catch (error) {
      if (
        error instanceof RunControllerInfrastructureError ||
        error instanceof RunExecutionConflictError ||
        error instanceof RunControllerInvariantError
      ) {
        throw error;
      }
      throw new RunControllerInfrastructureError("Unable to persist Run execution", {
        cause: error,
      });
    }
  }

  /**
   * Open a candidate's completion boundary in one transaction.
   *
   * ```text
   * AgentStep COMPLETED · Run RUNNING -> VERIFYING · AgentState VERIFYING
   * candidate messages · AWAITING_VERIFICATION · VerificationPlan
   * status.changed · verification.planned
   * ```
   *
   * The plan and the Run boundary that names it commit together or not at all. A Run that pointed at a
   * plan nobody wrote, or a plan written for a boundary that failed to open, is not a state this can
   * produce — which is why the plan does not travel through the general Run store, whose vocabulary has
   * no room for a verification artefact.
   */
  private async commitCandidateBoundary(
    command: RunCandidateBoundaryCommit,
  ): Promise<RunExecutionCommitResult> {
    const persistence = this.completionPersistence();
    if (persistence === undefined) {
      throw new RunControllerInfrastructureError(
        "Completion persistence is not configured; a verification boundary cannot be opened.",
      );
    }
    try {
      const committed = await persistence.commitCandidateBoundary(command);
      this.notify(committed.events);
      return committed;
    } catch (error) {
      if (
        error instanceof RunExecutionConflictError ||
        error instanceof RunControllerInvariantError
      ) {
        throw error;
      }
      throw new RunControllerInfrastructureError("Unable to open the completion boundary", {
        cause: error,
      });
    }
  }

  /**
   * The completion persistence boundary.
   *
   * It is the coding completion port when the host composed it explicitly, and otherwise the same
   * store when that store implements it — which is what keeps the daemon's composition unchanged while
   * the general `RunExecutionStorePort` stays verification-agnostic.
   */
  private completionPersistence(): RunCompletionPersistencePort | undefined {
    if (this.dependencies.completionStore !== undefined) return this.dependencies.completionStore;
    const store = this.dependencies.executionStore;
    if ("commitCandidateBoundary" in store && "commitVerifiedCompletion" in store) {
      return store as unknown as RunCompletionPersistencePort;
    }
    return undefined;
  }

  private resultFromSnapshot(snapshot: RunExecutionSnapshot): RunControllerResult {
    if (snapshot.run.status === "PENDING") return { status: "PENDING", run: snapshot.run };
    if (
      snapshot.run.status === "RUNNING" &&
      snapshot.continuation?.type === "WAITING_TOOL_RESULTS"
    ) {
      return {
        status: "WAITING_TOOL_RESULTS",
        run: snapshot.run,
        state: snapshot.state!,
        sourceStepId: snapshot.continuation.sourceStepId,
        toolRequests: snapshot.continuation.pendingDecision.toolRequests,
      };
    }
    if (
      snapshot.run.status === "WAITING_APPROVAL" &&
      snapshot.continuation?.type === "WAITING_TOOL_RESULTS" &&
      snapshot.continuation.waitingApproval !== undefined
    ) {
      return {
        status: "WAITING_APPROVAL",
        run: snapshot.run,
        state: snapshot.state!,
        sourceStepId: snapshot.continuation.sourceStepId,
        invocationId: snapshot.continuation.waitingApproval.invocationId,
        ...(snapshot.continuation.waitingApproval.approvalId === undefined
          ? {}
          : { approvalId: snapshot.continuation.waitingApproval.approvalId }),
        externalCallId: snapshot.continuation.waitingApproval.externalCallId,
        toolName: snapshot.continuation.waitingApproval.toolName,
      };
    }
    if (
      snapshot.run.status === "WAITING_RESOURCE" &&
      snapshot.continuation?.type === "WAITING_RESOURCE"
    ) {
      return {
        status: "WAITING_RESOURCE",
        run: snapshot.run,
        state: snapshot.state!,
        sourceStepId: snapshot.continuation.sourceStepId,
        requestedToolCalls: snapshot.continuation.pendingDecision.toolRequests.length,
        reason: snapshot.continuation.reason,
        replanCount: snapshot.continuation.replanCount,
      };
    }
    if (snapshot.run.status === "RUNNING" && snapshot.continuation?.type === "WAITING_RETRY") {
      return {
        status: "WAITING_RETRY",
        run: snapshot.run,
        state: snapshot.state!,
        nextAttemptAt: snapshot.continuation.nextAttemptAt,
        attempt: snapshot.continuation.attempt,
        maxAttempts: snapshot.continuation.maxAttempts,
        errorCode: snapshot.continuation.errorCode,
      };
    }
    if (
      snapshot.run.status === "VERIFYING" &&
      snapshot.continuation?.type === "AWAITING_VERIFICATION"
    ) {
      return {
        status: "AWAITING_VERIFICATION",
        run: snapshot.run,
        state: snapshot.state!,
        sourceStepId: snapshot.continuation.sourceStepId,
        verificationPlanId: snapshot.continuation.verificationPlanId,
        candidateText: snapshot.continuation.finalDecision.candidateText,
      };
    }
    if (snapshot.run.status === "FAILED") {
      return {
        status: "FAILED",
        run: snapshot.run,
        state: snapshot.state!,
        error: snapshot.state!.errors.at(-1)!,
      };
    }
    if (snapshot.run.status === "MAX_STEPS_REACHED") {
      return { status: "MAX_STEPS_REACHED", run: snapshot.run, state: snapshot.state! };
    }
    if (snapshot.run.status === "RUNNING")
      return { status: "RUNNING", run: snapshot.run, state: snapshot.state! };
    return {
      status: "TERMINAL",
      run: snapshot.run,
      ...(snapshot.state === undefined ? {} : { state: snapshot.state }),
    };
  }

  private resumeKnownBoundary(snapshot: RunExecutionSnapshot): RunControllerResult {
    return this.resultFromSnapshot(snapshot);
  }
  /**
   * The verification execution recovery store.
   *
   * The Run Layer still needs it for one thing: compiling the repair context the *next* Agent turn
   * reasons from. That context is built from the failed plan and the evidence that described it, which
   * is durable verification state — and it is read through the same port the gate runs verification
   * with, rather than the gate handing back a copy.
   */
  private verificationRecoveryStore():
    import("@caelush/verification").VerificationExecutionRecoveryStorePort | undefined {
    if (this.dependencies.verificationExecutionRecovery !== undefined) {
      return this.dependencies.verificationExecutionRecovery;
    }
    const candidate = this.dependencies.verificationExecutionStore;
    if (candidate !== undefined && "getPlanExecutionSnapshot" in candidate) {
      return candidate as import("@caelush/verification").VerificationExecutionRecoveryStorePort;
    }
    return undefined;
  }

  /* ---------------------------------------------------------- completion */

  /**
   * The run-scoped completion gate for one `EVALUATE_COMPLETION` directive.
   *
   * It captures every host fact the frozen `CompletionGateInput` deliberately does not carry — the
   * workspace, the Git port, the verification stores, the reviewer, the repair policy — from the
   * durable Run the coordinator decided on, and binds the Run Layer's own notifier and boundary writer
   * to it. The gate owns no store, publishes through the layer that owns the ledger, and commits no
   * lifecycle transition.
   *
   * The gate is a real `CompletionGate` for the frozen driver, so `EVALUATE_COMPLETION` travels the
   * same path as `ADVANCE_AGENT` and `EXECUTE_TOOL_BATCH`.
   */
  private completionGate(input: {
    readonly snapshot: RunExecutionSnapshot;
    readonly mode: RunExecutionMode;
  }): ResolvedCompletionGate | undefined {
    const dependencies = this.completionDependencies(input.snapshot, input.mode);
    if (dependencies === undefined) return undefined;
    const completion = createRunCompletionGate(dependencies);
    return { completion, dependencies };
  }

  /**
   * The host facts a completion evaluation runs with.
   *
   * This is the one place those facts are derived, so a gate and the settlement that acts on its
   * decision can never disagree about which plan, which reviewer or which repair policy was in play.
   */
  private completionDependencies(
    snapshot: RunExecutionSnapshot,
    mode: RunExecutionMode,
  ): RunCompletionGateDependencies | undefined {
    const state = snapshot.state;
    const continuation = snapshot.continuation;
    if (state === undefined || continuation?.type !== "AWAITING_VERIFICATION") return undefined;
    const deps = this.dependencies;
    const persistence = this.completionPersistence();
    if (persistence === undefined) return undefined;
    const reviewer =
      deps.verificationReviewer ??
      (deps.verificationModelTurns !== undefined && deps.budget !== undefined
        ? new TaskAcceptanceReviewer({
            modelTurns: deps.verificationModelTurns,
            budget: deps.budget,
            clock: deps.clock,
            ...(deps.verificationTurnIdentity === undefined
              ? {}
              : { resolveTurnIdentity: deps.verificationTurnIdentity }),
            ...(deps.tokenEstimator === undefined ? {} : { tokenEstimator: deps.tokenEstimator }),
          })
        : undefined);
    return {
      run: snapshot.run,
      state,
      continuation,
      mode,
      signal: this.executionSignal(snapshot.run.id),
      clock: deps.clock,
      persistence,
      configResolver: deps.configResolver,
      notifyCommitted: (events) => this.notify(events),
      openBoundary: async () => {
        // The boundary of a candidate is committed by `openCompletionBoundary`, which is the only
        // caller that has the Step, the messages and the revision to write it with. A gate that asked
        // for one here would be asking mid-evaluation, after the boundary is already durable.
        throw new RunControllerInvariantError(
          "A completion evaluation cannot open a boundary it is already running inside.",
        );
      },
      ...(deps.verificationPlanner === undefined ? {} : { planner: deps.verificationPlanner }),
      ...(deps.verificationPlanIdFactory === undefined
        ? {}
        : { planIdFactory: () => deps.verificationPlanIdFactory!.create() }),
      ...(deps.verificationCheckIdFactory === undefined
        ? {}
        : { checkIdFactory: () => deps.verificationCheckIdFactory!.create() }),
      ...(deps.verificationEvidenceIdFactory === undefined
        ? {}
        : { evidenceIdFactory: deps.verificationEvidenceIdFactory }),
      ...(deps.verificationRunner === undefined ? {} : { runner: deps.verificationRunner }),
      ...(deps.projectProfileProvider === undefined
        ? {}
        : { profileProvider: deps.projectProfileProvider }),
      ...(deps.verificationExecution === undefined
        ? {}
        : { execution: deps.verificationExecution }),
      ...(deps.verificationExecutionStore === undefined
        ? {}
        : { executionStore: deps.verificationExecutionStore }),
      ...(deps.verificationExecutionRecovery === undefined
        ? {}
        : { executionRecovery: deps.verificationExecutionRecovery }),
      ...(deps.verificationWorkspace === undefined
        ? {}
        : { workspace: deps.verificationWorkspace }),
      ...(deps.verificationGit === undefined ? {} : { git: deps.verificationGit }),
      ...(deps.verificationSecurity === undefined ? {} : { security: deps.verificationSecurity }),
      ...(deps.verificationEvidenceSanitizer === undefined
        ? {}
        : { evidenceSanitizer: deps.verificationEvidenceSanitizer }),
      ...(deps.verificationResolverRegistry === undefined
        ? {}
        : { resolverRegistry: deps.verificationResolverRegistry }),
      ...(reviewer === undefined ? {} : { reviewer }),
      ...(deps.verificationRepairPolicy === undefined
        ? {}
        : { repairPolicy: deps.verificationRepairPolicy }),
      ...(deps.verificationPlanCount === undefined
        ? {}
        : { planCount: deps.verificationPlanCount }),
    };
  }

  /**
   * Drive one `EVALUATE_COMPLETION` directive through the frozen Run execution driver.
   *
   * ```text
   * createRunExecutionDriver({ agentLoop: misroute, toolTurns: misroute, completionGate: REAL })
   *        ↓
   * driver.execute(EVALUATE_COMPLETION, context)
   *        ↓
   * the real coding completion gate
   *        ↓
   * frozen CompletionGateDecision  +  Core-private CompletionGateObservation
   * ```
   *
   * The Agent and Tool ports are fail-closed misroute guards: a completion evaluation that drove an
   * Agent Reason or a Tool batch from here would be a second execution authority for effects this
   * directive never named.
   */
  private async executeCompletionDirective(
    snapshot: RunExecutionSnapshot,
    directive: EvaluateCompletionDirective,
    resolved: ResolvedCompletionGate,
  ): Promise<CompletionDirectiveExecution> {
    const driver = createRunExecutionDriver({
      agentLoop: MISROUTED_AGENT_LOOP,
      toolTurns: MISROUTED_TOOL_TURN_COORDINATOR,
      completionGate: resolved.completion.gate,
    });
    try {
      const effect = await driver.execute(directive, {
        identity: {
          runId: snapshot.run.id,
          sessionId: snapshot.run.sessionId,
          goal: snapshot.run.goal,
        },
        // The Step is the one that produced the candidate, which is the Step the verification plan is
        // bound to. A completion evaluation creates no Step of its own: it is a host action about an
        // existing attempt, not a new Reason.
        turn: { stepId: directive.sourceStepId, sequence: 0 },
        history: [],
        model: unresolvedCompletionModel(snapshot.run.model),
        tools: [],
        signal: this.executionSignal(snapshot.run.id),
      });
      if (effect.kind !== "COMPLETION") {
        throw new RunControllerInvariantError(
          `The completion driver produced a ${effect.kind} effect for an EVALUATE_COMPLETION directive.`,
        );
      }
      return { decision: effect.result, observation: resolved.completion.observation };
    } catch (error) {
      // An aborted evaluation belongs to the termination authority: the Run Layer resolves it before
      // and after this call, and it wins over any completion decision.
      if (this.executionSignal(snapshot.run.id).aborted) {
        return { outcome: await this.finalizeAbortedExecution(snapshot) };
      }
      // The gate's own identity refusal is a lifecycle violation, not a verification outcome.
      if (error instanceof CompletionGateIdentityError) throw error;
      throw error;
    }
  }

  /**
   * Settle one executed completion effect through exactly one typed authority.
   *
   * ```text
   * classifyCompletionEffectSettlement()
   *        ↓
   * CANONICAL_ACCEPT          PLAN -> MATERIALIZE -> COMMIT -> NOTIFY -> onVerifiedCompletion
   * CANONICAL_REJECT          the same canonical path, to FAILED
   * REPAIR_COMPATIBILITY      the durable WAITING_VERIFICATION_REPAIR boundary
   * RETRYABLE_ERROR_SUSPEND   nothing is written; the Run keeps its AWAITING_VERIFICATION
   * TERMINATION_AUTHORITY     cancellation or deadline, which own their own settlement
   * ```
   *
   * The route is chosen by typed discriminant only and there is no generic fallback: a planner error
   * propagates instead of being caught and re-settled by a second authority.
   */
  private async settleCompletionEffect(
    snapshot: RunExecutionSnapshot,
    directive: EvaluateCompletionDirective,
    execution: Extract<CompletionDirectiveExecution, { decision: CompletionGateDecision }>,
  ): Promise<ToolEffectSettlement> {
    const current = await this.load(snapshot.run.id);
    const authority = this.resolveAuthority(current, false);
    const route = classifyCompletionEffectSettlement({
      decision: execution.decision,
      observation: execution.observation,
      terminationDecided:
        authority === "CANCELLED" ||
        authority === "TIMEOUT" ||
        authority === "TERMINAL" ||
        authority === "UNEXPECTED_ABORT",
    });
    switch (route.route) {
      case "TERMINATION_AUTHORITY":
        if (authority === "CANCELLED") {
          return { kind: "RESULT", result: await this.finalizeCancellation(current) };
        }
        if (authority === "TIMEOUT") {
          return { kind: "RESULT", result: await this.finalizeTimeout(current) };
        }
        if (authority === "UNEXPECTED_ABORT") {
          return { kind: "RESULT", result: await this.finalizeAbortedExecution(current) };
        }
        return { kind: "RESULT", result: this.resultFromSnapshot(current) };
      case "RETRYABLE_ERROR_SUSPEND":
        // The Run already holds exactly the boundary this outcome means: a durable
        // `AWAITING_VERIFICATION` with its plan and its evidence intact. Nothing is committed and the
        // drive ends here, which is what keeps a retryable completion error from becoming a busy loop.
        return { kind: "RESULT", result: this.resultFromSnapshot(current) };
      case "REPAIR_COMPATIBILITY": {
        const repaired = await this.settleVerificationRepair(current, directive, route);
        return { kind: "SNAPSHOT", snapshot: repaired };
      }
      case "CANONICAL_ACCEPT":
      case "CANONICAL_REJECT": {
        const canonical = await this.settleCanonicalCompletion(
          current,
          directive,
          route.route === "CANONICAL_ACCEPT"
            ? { kind: "ACCEPT", finalResult: route.decision.finalResult }
            : { kind: "REJECT", error: route.decision.error },
          execution.observation,
        );
        return canonical;
      }
    }
  }

  /**
   * Settle a completion decision the frozen planner can express.
   *
   * ```text
   * PLAN -> MATERIALIZE -> COMMIT -> NOTIFY -> onVerifiedCompletion
   * ```
   *
   * The order is the contract. `run.completed` is materialized only because the Core-private
   * observation carries the verified result *and* the seal that binds it to the plan and the candidate;
   * a completion whose materializer input has neither produces `status.changed` alone, and the Run is
   * never reported as verified-complete on the strength of a decision by itself.
   */
  private async settleCanonicalCompletion(
    current: RunExecutionSnapshot,
    directive: EvaluateCompletionDirective,
    decision: Extract<CompletionGateDecision, { kind: "ACCEPT" | "REJECT" }>,
    observation: CompletionGateObservation,
  ): Promise<ToolEffectSettlement> {
    const now = this.dependencies.clock.now();
    const snapshot = toAgentExecutionSnapshot(current);
    const effect: RunExecutionEffectResult = { kind: "COMPLETION", result: decision };
    const planned = this.transitionPlanner.plan({ snapshot, directive, effect, now });
    const completion = this.completionEventEvidence(decision, observation);
    const materialized = this.eventMaterializer.materialize({
      snapshot: current,
      directive,
      effect,
      plannedCommit: planned,
      now,
      // A completion evaluation performs no provider turn of its own: the reviewer's model call is the
      // verification subsystem's, and reporting a provider state here would claim a call this effect
      // never made.
      providerTurnState: "NOT_STARTED",
      ...(completion === undefined ? {} : { completion }),
      ownership: { eventIds: this.dependencies.eventIdFactory },
    });
    const committed = await this.commitVerifiedCompletion(materialized, observation);
    this.notify(committed.events);
    if (committed.snapshot.run.status === "COMPLETED") {
      const finalResult = committed.snapshot.run.finalResult;
      void Promise.resolve()
        .then(() =>
          this.dependencies.onVerifiedCompletion?.({ run: committed.snapshot.run, finalResult }),
        )
        .catch(() => undefined);
    }
    return { kind: "RESULT", result: this.resultFromSnapshot(committed.snapshot) };
  }

  /**
   * Commit a planned completion.
   *
   * A verified acceptance settles through the completion persistence port, which re-validates inside
   * the transaction that the Run is still the `VERIFYING` Run bound to this exact plan. Everything else
   * — a rejection, a repair, a suspension — is an ordinary Run transition and uses the ordinary commit.
   */
  private async commitVerifiedCompletion(
    command: RunExecutionCommit,
    observation: CompletionGateObservation,
  ): Promise<RunExecutionCommitResult> {
    const finalResult = observation.verifiedFinalResult;
    const plan = observation.plan;
    if (finalResult === undefined || plan === undefined) {
      return this.commit(command);
    }
    const persistence = this.completionPersistence();
    const state = command.state;
    if (persistence === undefined || state === undefined) {
      throw new RunControllerInfrastructureError(
        "Verified completion persistence is not configured.",
      );
    }
    try {
      return await persistence.commitVerifiedCompletion({
        run: command.run,
        state,
        finalResult,
        verificationPlan: plan,
        expectedStateRevision: command.expectedStateRevision,
        expectedContinuationRevision: command.expectedContinuationRevision,
        events: command.events,
      });
    } catch (error) {
      if (
        error instanceof RunExecutionConflictError ||
        error instanceof RunControllerInvariantError
      ) {
        throw error;
      }
      throw new RunControllerInfrastructureError("Unable to persist verified completion", {
        cause: error,
      });
    }
  }

  /**
   * The verified facts a completion event may publish.
   *
   * `run.completed` needs a `VerifiedRunFinalResult` *and* a seal, and the frozen `ACCEPT` decision
   * carries only the result. They are read from the Core-private observation, and only when the two
   * agree: a decision that accepted one result while the gate recorded another would be a completion
   * nobody verified, and it must not reach the ledger as one.
   */
  private completionEventEvidence(
    decision: Extract<CompletionGateDecision, { kind: "ACCEPT" | "REJECT" }>,
    observation: CompletionGateObservation,
  ): CompletionEventEvidence | undefined {
    const plan = observation.plan;
    const verifiedFinalResult = observation.verifiedFinalResult;
    const sealHash = observation.seal?.sealHash;
    if (plan === undefined || sealHash === undefined) return undefined;
    if (decision.kind === "ACCEPT") {
      // The decision and the observation must describe the *same* accepted result, and that result
      // must be bound to this plan by its own seal. Anything else is a completion nobody verified, and
      // no terminal event may be published for it.
      if (verifiedFinalResult === undefined) return undefined;
      if (!semanticEqual(decision.finalResult, verifiedFinalResult)) return undefined;
      if (verifiedFinalResult.verification.sealHash !== sealHash) return undefined;
      if (verifiedFinalResult.verification.planId !== plan.id) return undefined;
      if (verifiedFinalResult.verification.sourceStepId !== plan.sourceStepId) return undefined;
      if (verifiedFinalResult.verification.candidateHash !== plan.candidateHash) return undefined;
    }
    // A rejection publishes the verdict and the checks it named. It has no verified result to publish,
    // and `run.completed` is never emitted for one.
    if (verifiedFinalResult === undefined) return undefined;
    return {
      plan,
      verifiedFinalResult,
      sealHash,
      ...(observation.failedCheckIds === undefined
        ? {}
        : { failedCheckIds: observation.failedCheckIds }),
      ...(observation.errorCheckIds === undefined
        ? {}
        : { errorCheckIds: observation.errorCheckIds }),
    };
  }

  /**
   * The durable `WAITING_VERIFICATION_REPAIR` boundary.
   *
   * The frozen planner refuses this transition on purpose: the checkpoint has always persisted the
   * failed plan identity, the source Step, the failed check identities, the evidence identities and the
   * repair cycle, and the frozen repair request carries a reference, a cycle and a reason. The four
   * durable identities therefore come from the Core-private observation — which read them from the
   * durable verification execution — and from nowhere else.
   */
  private async settleVerificationRepair(
    loaded: RunExecutionSnapshot,
    directive: EvaluateCompletionDirective,
    route: Extract<CompletionEffectSettlementRoute, { route: "REPAIR_COMPATIBILITY" }>,
  ): Promise<RunExecutionSnapshot> {
    if (loaded.state === undefined) {
      throw new RunControllerInvariantError("Verification repair requires an AgentState");
    }
    const now = this.dependencies.clock.now();
    const run = resumeAgentRunFromVerificationRepair(loaded.run);
    const state = resumeAgentStateFromVerificationRepair(loaded.state, now);
    const checkpoint = {
      type: "WAITING_VERIFICATION_REPAIR" as const,
      runId: run.id,
      failedPlanId: directive.sourceStepId === undefined ? "" : route.decision.repair.repairRef,
      sourceStepId: directive.sourceStepId,
      failedCheckIds: route.failedCheckIds,
      evidenceIds: route.evidenceIds,
      repairCycle: route.repairCycle,
    } as never;
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: loaded.stateRevision ?? null,
      expectedContinuationRevision: loaded.continuationRevision ?? null,
      stepWrites: [],
      messagesToAppend: [],
      continuation: { operation: "SET", checkpoint, updatedAt: now },
      events: [
        this.eventFactory.statusChanged(
          loaded.run,
          "VERIFYING",
          "RUNNING",
          this.nextEventId(),
          now,
        ),
        this.eventFactory.verificationRepairStarted(
          loaded.run,
          route.decision.repair.repairRef as never,
          route.failedCheckIds,
          route.repairCycle,
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    return commit.snapshot;
  }

  private nextEventId() {
    return this.dependencies.eventIdFactory.create();
  }

  private notify(events: readonly DurableAgentEvent[]): void {
    if (events.length > 0) this.dependencies.events.notifyCommitted(events);
  }

  private async withLock<T>(runId: RunId, operation: () => Promise<T>): Promise<T> {
    if (this.activeRuns.has(runId)) throw new RunControllerBusyError(runId);
    const scope = this.scopes.open(runId);
    this.activeRuns.add(runId);
    try {
      return await operation();
    } finally {
      this.activeRuns.delete(runId);
      this.scopes.close(runId, scope);
    }
  }

  private async withTerminationLock<T>(runId: RunId, operation: () => Promise<T>): Promise<T> {
    while (this.activeRuns.has(runId)) {
      const scope = this.scopes.get(runId);
      if (scope === undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        continue;
      }
      await scope.settled;
    }
    return this.withLock(runId, operation);
  }

  private resolveAuthority(
    snapshot: RunExecutionSnapshot,
    aborted: boolean,
  ): ReturnType<typeof resolveRunTerminationAuthority> {
    const scope = this.scopes.get(snapshot.run.id);
    return resolveRunTerminationAuthority({
      run: snapshot.run,
      ...(snapshot.cancellationIntent === undefined
        ? {}
        : { cancellationIntent: snapshot.cancellationIntent }),
      now: this.dependencies.clock.now(),
      aborted,
      ...(scope?.abortCause === undefined ? {} : { abortCause: scope.abortCause }),
    });
  }

  private isExpired(snapshot: RunExecutionSnapshot): boolean {
    const deadline = deriveRunDeadline(snapshot.run);
    return deadline !== undefined && isRunDeadlineExceeded(deadline, this.dependencies.clock.now());
  }

  private reconcileDeadline(snapshot: RunExecutionSnapshot): void {
    if (snapshot.run.status === "PENDING" || isTerminal(snapshot.run.status)) {
      this.deadlineRegistry.disarm(snapshot.run.id);
      return;
    }
    const deadline = deriveRunDeadline(snapshot.run);
    if (deadline === undefined) {
      this.deadlineRegistry.disarm(snapshot.run.id);
      return;
    }
    if (isRunDeadlineExceeded(deadline, this.dependencies.clock.now())) {
      this.deadlineRegistry.disarm(snapshot.run.id);
      return;
    }
    this.deadlineRegistry.arm(snapshot.run.id, deadline.deadlineAt, async () => {
      await this.handleDeadline(snapshot.run.id);
    });
  }

  private reconcileRetry(snapshot: RunExecutionSnapshot): void {
    if (snapshot.run.status !== "RUNNING" || snapshot.continuation?.type !== "WAITING_RETRY") {
      this.retryRegistry.disarm(snapshot.run.id);
      return;
    }
    const deadline = deriveRunDeadline(snapshot.run);
    if (deadline !== undefined && snapshot.continuation.nextAttemptAt >= deadline.deadlineAt) {
      this.retryRegistry.disarm(snapshot.run.id);
      return;
    }
    this.scheduleRetry(snapshot.run.id, snapshot.continuation.nextAttemptAt, deadline?.deadlineAt);
  }

  private scheduleRetry(
    runId: RunId,
    nextAttemptAt: AgentRun["createdAt"],
    deadlineAt?: AgentRun["createdAt"],
  ): void {
    if (deadlineAt !== undefined && nextAttemptAt >= deadlineAt) {
      this.retryRegistry.disarm(runId);
      return;
    }
    try {
      this.retryRegistry.arm(runId, nextAttemptAt, () => this.handleRetry(runId));
    } catch {
      // The durable WAITING_RETRY checkpoint remains recoverable if arming fails.
    }
  }

  private async handleRetry(runId: RunId): Promise<void> {
    if (this.activeRuns.has(runId)) {
      const loaded = await this.load(runId);
      if (loaded.continuation?.type === "WAITING_RETRY") {
        this.scheduleRetry(runId, loaded.continuation.nextAttemptAt);
      }
      return;
    }
    await this.withLock(runId, async () => {
      const loaded = await this.load(runId);
      if (loaded.run.status !== "RUNNING" || loaded.continuation?.type !== "WAITING_RETRY") {
        return;
      }
      await this.resumeRetryLocked(loaded);
    });
  }

  private async handleDeadline(runId: RunId): Promise<RunControllerResult | undefined> {
    const loaded = await this.load(runId);
    if (isTerminal(loaded.run.status) || loaded.run.status === "PENDING") {
      return this.resultFromSnapshot(loaded);
    }
    if (!this.isExpired(loaded)) return this.resultFromSnapshot(loaded);
    const scope = this.scopes.get(runId);
    if (scope !== undefined) {
      scope.abort("DEADLINE_EXCEEDED");
      await scope.settled;
    }
    return this.withTerminationLock(runId, () => this.finalizeTimeout(loaded));
  }

  /**
   * The coordinated durable boundary for a recovering Run.
   *
   * It answers only the decisions whose priority the coordinator owns, and it returns `undefined`
   * for everything else so the status-specific recovery logic stays in one place:
   *
   * ```text
   * FINALIZE         cancellation, deadline, step budget
   * SUSPEND          an approval or resource boundary only an external resolution can move
   * RETURN_TERMINAL  an already settled Run
   * ```
   *
   * Two facts are deliberately settled *before* the coordinator is consulted, because neither is a
   * durable routing input:
   *
   * ```text
   * an in-memory abort cause   process state, not durable state
   * an active Step             a boundary the caller must settle before routing at all
   * ```
   *
   * `ADVANCE_AGENT`, `EXECUTE_TOOL_BATCH` and `EVALUATE_COMPLETION` are not answered here. Recovery
   * reaches them through the status-specific paths, which own the preconditions a route alone
   * cannot express — a Tool batch must not run when Tool execution is composed out, for instance.
   */
  private coordinatedBoundary(
    snapshot: RunExecutionSnapshot,
  ): Promise<RunControllerResult> | RunControllerResult | undefined {
    const now = this.dependencies.clock.now();

    // An aborted execution scope is in-memory, so it is the RunController's to interpret rather
    // than a fact the pure coordinator could route on.
    const scope = this.scopes.get(snapshot.run.id);
    if (scope?.signal.aborted === true) {
      if (scope.abortCause === "USER_REQUESTED") return this.finalizeCancellation(snapshot);
      if (scope.abortCause === "DEADLINE_EXCEEDED") return this.finalizeTimeout(snapshot);
      // An abort with no known cause is not routable; the status-specific path reports it.
      return undefined;
    }

    // A stale RUNNING Step is a durable uncertain boundary. It is settled by the recovery path
    // below before anything is routed, and never resent to a provider.
    if (snapshot.activeStep !== undefined) return undefined;

    const directive = this.coordinator.next(toAgentExecutionSnapshot(snapshot), now);

    switch (directive.kind) {
      case "FINALIZE":
        switch (directive.reason) {
          case "CANCELLED":
            return this.finalizeCancellation(snapshot);
          case "TIMEOUT":
            return this.finalizeTimeout(snapshot);
          case "MAX_STEPS_REACHED":
            return this.finalizeMaxSteps(snapshot);
        }
        return undefined;
      case "SUSPEND":
        // The boundary is already durable: the RunController committed it when it was reached.
        // Recovery therefore has nothing to write.
        return this.resultFromSnapshot(snapshot);
      case "RETURN_TERMINAL":
        // The Run is settled. Nothing may reopen it.
        return this.resultFromSnapshot(snapshot);
      default:
        return undefined;
    }
  }

  private async finalizeMaxSteps(snapshot: RunExecutionSnapshot): Promise<RunControllerResult> {
    if (snapshot.state === undefined) {
      throw new RunControllerInvariantError("The step budget requires an AgentState");
    }
    const now = this.dependencies.clock.now();
    const state = markAgentStateMaxStepsReached(snapshot.state, now);
    const run = AgentRunSchema.parse({
      ...snapshot.run,
      status: "MAX_STEPS_REACHED",
      finishedAt: now,
    });
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: snapshot.stateRevision ?? null,
      expectedContinuationRevision: snapshot.continuationRevision ?? null,
      stepWrites: [],
      messagesToAppend: [],
      continuation: { operation: "CLEAR" },
      events: [
        this.eventFactory.maxSteps(
          snapshot.run,
          state,
          {
            type: "MAX_STEPS_REACHED",
            stepsCompleted: snapshot.state.usage.steps,
            maxSteps: snapshot.run.limits.maxSteps,
          },
          this.nextEventId(),
          now,
        ),
        this.eventFactory.statusChanged(
          snapshot.run,
          snapshot.run.status,
          "MAX_STEPS_REACHED",
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    return this.resultFromSnapshot(commit.snapshot);
  }

  private executionSignal(runId: RunId): AbortSignal {
    const scope = this.scopes.get(runId);
    if (scope === undefined) {
      throw new RunControllerInvariantError("Run execution has no active cancellation scope");
    }
    return scope.signal;
  }

  private async cancelOwnedResources(runId: RunId): Promise<{
    readonly stoppedResourceIds: readonly string[];
    readonly confirmed: boolean;
  }> {
    if (this.dependencies.resources === undefined) {
      return { stoppedResourceIds: [], confirmed: true };
    }
    return this.dependencies.resources.cancelOwnedResources(runId);
  }
}

/** The retry provenance a new checkpoint carries forward. */
type WaitingRetryResumeContext =
  | {
      readonly mode: "START";
    }
  | {
      readonly mode: "TOOL_RESULTS";
      readonly pendingDecision: import("./agent-decision.js").AgentToolCallsDecision;
      readonly receivedResults: readonly import("@caelush/ai").AIToolResultMessage[];
      readonly sourceStepId?: StepId | undefined;
    };

/**
 * The canonical append projection.
 *
 * The provenance rule is the durable one and is shared with the frozen planner rather than
 * re-decided here: an assistant message belongs to the Step that produced it, and a Tool result
 * belongs to the Step that requested the batch. A user message has no Step source.
 */
function appendMessages(
  snapshot: RunExecutionSnapshot,
  messages: readonly import("@caelush/ai").AIMessage[],
  stepId: StepId | undefined,
  now: AgentRun["createdAt"],
): readonly {
  createdAt: AgentRun["createdAt"];
  sourceStepId?: StepId;
  message: import("@caelush/ai").AIMessage;
}[] {
  const toolStepId =
    snapshot.continuation?.type === "WAITING_TOOL_RESULTS"
      ? snapshot.continuation.sourceStepId
      : undefined;
  return messages.map((message) => {
    const sourceStepId =
      message.role === "assistant" ? stepId : message.role === "tool" ? toolStepId : undefined;
    return {
      createdAt: now,
      ...(sourceStepId === undefined ? {} : { sourceStepId }),
      message,
    };
  });
}

/**
 * The usage one frozen Agent result reported, when it reported any.
 *
 * A `FAILED` result carries usage only on the post-provider path, and a `FINAL_CANDIDATE` always
 * carries the settled model turn. Nothing is inferred from the presence of a model turn: the
 * frozen contract states usage explicitly, and an absent value means the attempt reported none.
 */
function resolveResultUsage(
  result: AgentLoopAdvanceResult,
): import("@caelush/ai").ModelUsage | undefined {
  if (result.kind === "FAILED") return result.usage;
  if (result.kind === "FINAL_CANDIDATE" || result.kind === "TOOL_REQUESTS") {
    return result.modelTurn.usage;
  }
  return undefined;
}

/**
 * Project the frozen retry hint onto the durable retry vocabulary.
 *
 * The frozen kernel only emits retry metadata for a retryable error, and only the three transient
 * codes can reach here — the same three Phase 10C allows to be retried. Anything else is refused
 * rather than stored, because the durable `WAITING_RETRY` checkpoint names one of them.
 */
function toDurableRetryMetadata(retry: import("@caelush/agent").AgentRetryMetadata | undefined):
  | {
      code: import("./agent-loop-input.js").AgentRetryMetadata["code"];
      retryable: true;
      retryAfterMs?: number;
    }
  | undefined {
  if (retry === undefined || !retry.retryable) return undefined;
  const code =
    retry.code === "RATE_LIMIT"
      ? ("AI_RATE_LIMIT" as const)
      : retry.code === "NETWORK"
        ? ("AI_NETWORK" as const)
        : retry.code === "TIMEOUT"
          ? ("AI_TIMEOUT" as const)
          : undefined;
  if (code === undefined) return undefined;
  return {
    code,
    retryable: true,
    ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs }),
  };
}

/** Project a Core budget block onto the frozen admission vocabulary. */
function toFrozenBudgetBlock(block: AgentBudgetBlock): import("@caelush/agent").AgentBudgetBlock {
  if (block.kind === "UNAVAILABLE") {
    return { kind: "UNAVAILABLE", reason: block.reason };
  }
  return {
    kind: "EXCEEDED",
    dimension: block.dimension,
    accounted: block.accounted,
    limit: block.limit,
    ...(block.limitMicros === undefined ? {} : { limitMicros: block.limitMicros }),
    ...(block.accountedMicros === undefined ? {} : { accountedMicros: block.accountedMicros }),
  };
}

/** The Core-side budget block one admission refusal produced. */
function toBudgetBlock(
  admission: import("./budget-ports.js").RunLLMBudgetAdmission,
): AgentBudgetBlock {
  if (admission.kind === "UNAVAILABLE") {
    return { kind: "UNAVAILABLE", reason: admission.reason };
  }
  if (admission.kind === "EXCEEDED") {
    return {
      kind: "EXCEEDED",
      dimension: admission.dimension,
      accounted: admission.accounted,
      limit: admission.limit,
      ...(admission.limitMicros === undefined ? {} : { limitMicros: admission.limitMicros }),
      ...(admission.accountedMicros === undefined
        ? {}
        : { accountedMicros: admission.accountedMicros }),
    };
  }
  throw new RunControllerInvariantError("A budget block cannot be projected from an allowance.");
}

/**
 * The durable Step that requested the Tools an open continuation is resuming with.
 *
 * It is read from the continuation itself — the layer that wrote it is the layer that knows it —
 * rather than from the frozen turn input, so the provenance has exactly one source.
 */
function toolRequestStepOf(snapshot: RunExecutionSnapshot): StepId | undefined {
  const continuation = snapshot.continuation;
  if (continuation?.type === "WAITING_TOOL_RESULTS") return continuation.sourceStepId;
  if (continuation?.type === "WAITING_RETRY" && continuation.mode === "TOOL_RESULTS") {
    return continuation.sourceStepId;
  }
  return undefined;
}

function assertNeverAdvanceReason(reason: never): never {
  throw new RunControllerInvariantError(`Unhandled Run advance reason: ${String(reason)}`);
}

/**
 * The durable Step that requested the Tools a legacy retry checkpoint is resuming with.
 *
 * A checkpoint written before the retry continuation carried `sourceStepId` has no recorded
 * provenance, and the Run Layer refuses to invent one: `failedStepId` names the attempt that
 * failed and a model call identity is not a Step at all, so either would be a fabricated
 * recovery. What the durable ledger *does* still hold is the assistant message that announced
 * the calls — and `agent_messages.source_step_id` records the Step that produced it. Matching
 * the persisted pending decision against that message is therefore a deterministic recovery
 * from data this Run already wrote, not a guess.
 *
 * If the message is absent, or carries no Step, recovery is impossible and the caller fails
 * closed rather than opening a Tool resume against a Step it cannot name.
 */
function recoverToolRequestSourceStep(
  snapshot: RunExecutionSnapshot,
  pendingDecision: import("./agent-decision.js").AgentToolCallsDecision | undefined,
): StepId {
  if (pendingDecision !== undefined) {
    const expected = pendingDecision.modelTurn.assistantMessage;
    const matched = snapshot.conversation.find(
      (entry) =>
        entry.sourceStepId !== undefined &&
        entry.message.role === "assistant" &&
        // The durable record and the persisted decision are two projections of the same turn,
        // so they are compared structurally: key order is not part of a tool call's identity
        // and the two sides carry nominally different JSON types.
        semanticEqual(entry.message.content, expected.content),
    );
    if (matched?.sourceStepId !== undefined) return matched.sourceStepId;
  }
  throw new RunControllerInvariantError(
    "A retry Tool resume has no durable source Step and cannot be recovered without guessing.",
  );
}

/** Whether a status is settled and may never be reopened. */
function isTerminal(status: AgentRun["status"]): boolean {
  return [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ].includes(status);
}

/**
 * The one monotonic arithmetic rule of the retry schedule.
 *
 * A delay that would exceed the safe integer range is refused rather than silently wrapped: a
 * timestamp that lost precision would arm a timer for an instant that is not the instant the policy
 * asked for.
 */
function addTimestamp(now: AgentRun["createdAt"], delayMs: number): AgentRun["createdAt"] {
  if (delayMs > Number.MAX_SAFE_INTEGER - now) {
    throw new RunControllerInvariantError("Retry timestamp exceeded the safe integer range");
  }
  return createTimestampMs(now + delayMs);
}
