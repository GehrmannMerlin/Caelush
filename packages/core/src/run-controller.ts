import type { LLMToolResultMessage } from "@caelush/llm/messages";
import {
  createAgentDecisionClassifier,
  createRunExecutionCoordinator,
  createRunExecutionDriver,
  createRunTransitionPlanner,
  type AdvanceAgentDirective,
  type AgentLoopAdvanceResult,
  type AgentLoopFailedResult,
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
  VerificationEvidenceSchema,
  VerificationPlanSchema,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  createTimestampMs,
  type ApprovalRequestId,
  type AgentRun,
  type AgentError,
  type AgentState,
  type AgentStep,
  type RunId,
  type StepId,
  type VerificationPlan,
} from "@caelush/protocol";
import {
  beginAgentStepState,
  cancelAgentStepState,
  createInitialAgentState,
  markAgentStateCancelled,
  markAgentStateWaitingApproval,
  markAgentStateWaitingResource,
  markAgentStateMaxStepsReached,
  markAgentStateBudgetExceeded,
  markAgentStateVerifying,
  resumeAgentStateFromApproval,
  resumeAgentStateFromResource,
  settleAgentStepState,
  resumeAgentStateFromVerificationRepair,
  markAgentStateCompleted,
  startAgentState,
} from "./agent-state.js";
import { cancelAgentStep, completeAgentStep, failAgentStep } from "./agent-step.js";
import { normalizeToolResultBatch } from "./agent-tool-results.js";
import { defaultObservationPolicy } from "./agent-tool-batch.js";
import {
  markAgentRunFailed,
  markAgentRunCancelled,
  markAgentRunTimedOut,
  markAgentRunBudgetExceeded,
  markAgentRunWaitingApproval,
  markAgentRunWaitingResource,
  resumeAgentRunFromVerificationRepair,
  resumeAgentRunFromApproval,
  resumeAgentRunFromResource,
  markAgentStateFailed,
  markAgentRunCompleted,
  assertRunExecutionInvariant,
} from "./run-execution-state.js";
import { markAgentStateTimedOut } from "./agent-state.js";
import { RunExecutionScopeRegistry } from "./run-execution-scope.js";
import { RunDeadlineRegistry } from "./run-deadline-registry.js";
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
  MISROUTED_TOOL_TURN_COORDINATOR,
  DEFERRED_COMPLETION_GATE,
} from "./run-agent-deferred-ports.js";
import {
  createRunToolTurnDriverFactory,
  recordRunToolTurnProgress,
  recordRunToolTurnReplan,
  type ResolvedRunToolTurn,
  type RunToolTurnContext,
  type RunToolTurnDriverDependencies,
} from "./run-tool-turn-coordinator.js";
import { classifyToolEffectSettlement } from "./run-tool-effect-settlement.js";
import type { RunToolTurnObservation } from "./run-tool-turn-observation.js";
import { createToolSecurityContext } from "./tool-security-context.js";
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
import type { DurableAgentEvent, DurableEventDraft } from "./run-execution-store.js";
import type { RunControllerResult } from "./run-controller-input.js";
import {
  createRunControllerEventFactory,
  type RunControllerEventFactory,
} from "./run-controller-events.js";
import type { RunControllerDependencies } from "./run-controller-ports.js";
import { TaskAcceptanceReviewer } from "./task-acceptance-reviewer.js";
import { toDurableRetryCode } from "./ai-invocation-projection.js";
import type { AgentBudgetBlock } from "./agent-errors.js";
import {
  ProjectCheckResolverRegistry,
  VerificationStageRunner,
  buildTaskReviewBundle,
  compileVerificationRepairContext,
  createDiscoveryEvidence,
  createGitEvidence,
  createTaskAcceptanceEvidence,
  createVerificationRepairPolicy,
  createWorkspaceEvidence,
  evaluateVerification,
  repairCycleForPlanCount,
  reviewGitChangeset,
  verifyWorkspaceInspection,
  computeVerificationCandidateTextHash,
  computeVerificationEvidenceDigest,
  createVerificationCompletionSeal,
  computeWorkspaceFreshnessHash,
  type VerificationRunnerInput,
} from "@caelush/verification";
import {
  createVerifiedRunFinalResult,
  evaluateCompletionAuthority,
  type CompletionFreshness,
  type CompletionGitFreshness,
} from "./completion-authority.js";
import type { VerificationEvidence, VerificationCheck } from "@caelush/protocol";

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
    return this.driveToolBoundariesLocked(commit.snapshot, "RECOVER");
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
    return this.driveToolBoundariesLocked(commit.snapshot, "RECOVER");
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
    return this.driveToolBoundariesLocked(commit.snapshot, "RECOVER");
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
    return this.driveToolBoundariesLocked(accepted, "EXECUTE");
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
      return this.driveToolBoundariesLocked(normalized, "RECOVER");
    }
    if (normalized.run.status === "VERIFYING") {
      return this.driveProjectVerificationLocked(normalized);
    }
    if (
      normalized.run.status === "RUNNING" &&
      normalized.continuation?.type === "WAITING_VERIFICATION_REPAIR"
    ) {
      return this.driveToolBoundariesLocked(normalized, "RECOVER");
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
    return this.driveToolBoundariesLocked(loaded, "RECOVER");
  }

  /**
   * The production Run execution loop.
   *
   * ```text
   * Coordinator.next()          the only routing authority
   *        ↓
   * ADVANCE_AGENT               → Run Layer Step allocation → RunExecutionDriver
   * EXECUTE_TOOL_BATCH          → the existing Phase 3D Tool compatibility boundary
   * anything else               → the boundary is already durable
   * ```
   *
   * The coordinator is asked *before* each action, from the durable snapshot, and its directive is
   * what executes. Nothing here re-derives which action to take from a continuation type, a Run
   * status or an execution epoch, so the action that runs is the action that was decided.
   *
   * A state the coordinator refuses to route is not guessed at. An active Step and a legacy retry
   * checkpoint without recorded provenance are resolved by the recovery paths before this loop is
   * entered, so reaching one here is a lifecycle violation rather than something to route around —
   * the coordinator's refusal is propagated rather than swallowed.
   */
  private async driveToolBoundariesLocked(
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
      completionGate: DEFERRED_COMPLETION_GATE,
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
        const canonical = await this.settleCanonicalToolEffect(
          current,
          directive,
          route.result,
          execution.observation,
        );
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
  private async settleCanonicalToolEffect(
    current: RunExecutionSnapshot,
    directive: ExecuteToolBatchDirective,
    result: Exclude<ToolTurnResult, { kind: "RESOURCE_WAIT" | "BUDGET_EXCEEDED" }>,
    observation: RunToolTurnObservation,
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
    await this.recordToolTurnProgress(committed.snapshot, result, observation);
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
    observation: RunToolTurnObservation,
  ): Promise<void> {
    const batches = this.dependencies.toolCoordinator;
    const continuation = settled.continuation;
    const state = settled.state;
    if (
      batches === undefined ||
      continuation?.type !== "WAITING_TOOL_RESULTS" ||
      state === undefined
    ) {
      return;
    }
    const dependencies = this.toolTurnDependencies(batches, settled.run.id);
    const contextRuntime = this.dependencies.contextRuntime;
    const context: RunToolTurnContext = {
      run: settled.run,
      state,
      continuation,
      pendingDecision: continuation.pendingDecision,
      observationPolicy:
        continuation.observationPolicy ??
        contextRuntime?.getContextPolicy?.(settled.run.id) ??
        defaultObservationPolicy(),
      effectiveMode: observation.effectiveMode,
      environment: { workspace: settled.run.workspace, runtime: settled.run.runtime },
      securityContext: createToolSecurityContext(settled.run, state),
    };
    const results =
      result.kind === "COMPLETED"
        ? result.results
        : result.kind === "REPLAN"
          ? result.syntheticResults
          : [];
    // A REPLAN writes no Tool invocation at all, so the ledger entry is the only durable trace of
    // the decision — and it is what a later `WAITING_RESOURCE` reports as `replanCount`.
    if (result.kind === "REPLAN") await recordRunToolTurnReplan({ dependencies, context });
    if (results.length === 0) return;
    await recordRunToolTurnProgress({ dependencies, context, state, results });
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
    const config = await this.dependencies.configResolver.resolve(snapshot.run);
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
      completionGate: DEFERRED_COMPLETION_GATE,
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

    return this.settle(snapshot, directive, effect.result, observation, config.projectFacts);
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
    projectFacts: import("@caelush/protocol").VerificationProjectFacts | undefined,
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
        return this.settleFinalCandidateCompatibility(
          before,
          result as Extract<AgentLoopAdvanceResult, { kind: "FINAL_CANDIDATE" }>,
          observation,
          projectFacts,
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
  private async settleFinalCandidateCompatibility(
    before: RunExecutionSnapshot,
    result: Extract<AgentLoopAdvanceResult, { kind: "FINAL_CANDIDATE" }>,
    observation: AgentTurnObservation,
    projectFacts: import("@caelush/protocol").VerificationProjectFacts | undefined,
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
    const step = this.requireExecutedStep(current, result.turn.stepId, "A final candidate");
    const settledState = this.settleExecutedStepState(current.state, step, result, now);
    const completedStep = completeAgentStep(step, {
      finishedAt: now,
      reasoningSummary: summarizeAgentDecision(result.decision),
    });
    // The Run holds a candidate and is about to verify it, so its AgentState is VERIFYING. The step
    // count settles exactly once, on this same transition.
    const decisionState = markAgentStateVerifying(settledState, now);
    const verificationPlan = this.createVerificationPlan(
      current.run,
      step,
      decisionState.changedFiles,
      projectFacts,
      result.decision.candidateText,
    );
    const run = AgentRunSchema.parse({
      ...current.run,
      status: "VERIFYING",
      currentStepId: undefined,
    });

    const commit = await this.commit({
      run,
      state: decisionState,
      expectedStateRevision: current.stateRevision ?? null,
      expectedContinuationRevision: current.continuationRevision ?? null,
      stepWrites: [{ operation: "UPDATE", step: completedStep }],
      messagesToAppend: appendMessages(current, result.messagesToAppend, step.id, now),
      continuation: {
        operation: "SET",
        checkpoint: {
          type: "AWAITING_VERIFICATION",
          runId: run.id,
          sourceStepId: step.id,
          verificationPlanId: verificationPlan.id,
          finalDecision: result.decision,
        },
        updatedAt: now,
      },
      verificationPlan,
      events: [
        ...this.successEvents(current.run, decisionState, completedStep, observation, now),
        this.eventFactory.statusChanged(
          current.run,
          "RUNNING",
          "VERIFYING",
          this.nextEventId(),
          now,
        ),
        this.eventFactory.verificationPlanned(
          current.run,
          verificationPlan,
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    return this.driveProjectVerificationLocked(commit.snapshot);
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

  private createVerificationPlan(
    run: AgentRun,
    sourceStep: AgentStep,
    changedFiles: AgentState["changedFiles"],
    projectFacts?: import("@caelush/protocol").VerificationProjectFacts,
    candidateText?: string,
  ): VerificationPlan {
    const planner = this.dependencies.verificationPlanner;
    if (planner === undefined) {
      throw new RunControllerInfrastructureError("Verification planner is not configured.");
    }
    const draft = planner.plan({
      runId: run.id,
      sourceStepId: sourceStep.id,
      goal: run.goal,
      workspace: run.workspace,
      changedFiles,
      ...(projectFacts === undefined ? {} : { projectFacts }),
    });
    const planId =
      this.dependencies.verificationPlanIdFactory?.create() ?? createVerificationPlanId();
    const checkIdFactory = this.dependencies.verificationCheckIdFactory ?? {
      create: () => createVerificationCheckId(),
    };
    return VerificationPlanSchema.parse({
      id: planId,
      runId: run.id,
      sourceStepId: sourceStep.id,
      plannerVersion: draft.plannerVersion,
      planHash: draft.planHash,
      ...(candidateText === undefined
        ? {}
        : { candidateHash: computeVerificationCandidateTextHash(candidateText) }),
      checks: draft.checks.map((check) => ({
        ...check,
        id: checkIdFactory.create(),
        planId,
        status: "PENDING",
        createdAt: this.dependencies.clock.now(),
      })),
      createdAt: this.dependencies.clock.now(),
    });
  }

  private resumeKnownBoundary(snapshot: RunExecutionSnapshot): RunControllerResult {
    return this.resultFromSnapshot(snapshot);
  }

  private async driveProjectVerificationLocked(
    snapshot: RunExecutionSnapshot,
  ): Promise<RunControllerResult> {
    const runner = this.dependencies.verificationRunner;
    const profileProvider = this.dependencies.projectProfileProvider;
    const execution = this.dependencies.verificationExecution;
    const executionStore = this.dependencies.verificationExecutionStore;
    const security = this.dependencies.verificationSecurity;
    const sanitizer = this.dependencies.verificationEvidenceSanitizer;
    const plan = snapshot.verificationPlan;
    if (plan === undefined) return this.resultFromSnapshot(snapshot);
    const pendingProjectChecks = plan.checks.some(
      (check) => check.spec.kind === "PROJECT" && check.status === "PENDING",
    );
    if (
      pendingProjectChecks &&
      (runner === undefined ||
        profileProvider === undefined ||
        execution === undefined ||
        executionStore === undefined ||
        security === undefined ||
        sanitizer === undefined)
    ) {
      return this.resultFromSnapshot(snapshot);
    }
    if (plan.checks.some((check) => check.status === "RUNNING")) {
      await this.settleStaleVerificationChecksLocked(snapshot, plan);
      const recovered = await this.load(snapshot.run.id);
      const authority = this.resolveAuthority(recovered, false);
      if (authority === "CANCELLED") return this.finalizeCancellation(recovered);
      if (authority === "TIMEOUT") return this.finalizeTimeout(recovered);
      return this.driveChangeVerificationLocked(recovered);
    }
    if (pendingProjectChecks) {
      const config = await this.dependencies.configResolver.resolve(snapshot.run);
      const profile = await profileProvider!.getFreshProfile(snapshot.run, config);
      const runnerInput: VerificationRunnerInput = {
        runId: snapshot.run.id,
        sessionId: snapshot.run.sessionId,
        plan,
        profile,
        permissionProfile: snapshot.run.permissionProfile,
        approvalPolicy: snapshot.run.approvalPolicy,
        signal: this.executionSignal(snapshot.run.id),
        now: () => this.dependencies.clock.now(),
        resolverRegistry:
          this.dependencies.verificationResolverRegistry ?? new ProjectCheckResolverRegistry(),
        security: security!,
        execution: execution!,
        store: executionStore!,
        evidenceIdFactory:
          this.dependencies.verificationEvidenceIdFactory ?? createVerificationEvidenceId,
        evidenceSanitizer: sanitizer!,
        onCommittedEvents: (events) => this.notify(events as readonly DurableAgentEvent[]),
      };
      await runner!.run(runnerInput);
    }
    const current = await this.load(snapshot.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "CANCELLED") return this.finalizeCancellation(current);
    if (authority === "TIMEOUT") return this.finalizeTimeout(current);
    return this.driveChangeVerificationLocked(current);
  }

  private async driveChangeVerificationLocked(
    snapshot: RunExecutionSnapshot,
  ): Promise<RunControllerResult> {
    const plan = snapshot.verificationPlan;
    const recovery = this.verificationRecoveryStore();
    if (plan === undefined || snapshot.state === undefined || recovery === undefined) {
      return this.resultFromSnapshot(snapshot);
    }
    const existing = await recovery.getPlanExecutionSnapshot(plan.id);
    if (existing === null)
      throw new RunControllerInfrastructureError("Verification plan disappeared.");
    const currentEvaluation = evaluateVerification(existing.plan, existing.evidence);
    if (currentEvaluation.status === "FAILED") {
      return this.maybeStartVerificationRepairLocked(snapshot, currentEvaluation);
    }
    if (currentEvaluation.status === "ERROR") {
      return this.failVerificationLocked(snapshot, currentEvaluation);
    }
    const blockingBeforeChange = plan.checks.some(
      (check) =>
        check.status === "FAILED" || check.status === "ERROR" || check.status === "RUNNING",
    );
    if (blockingBeforeChange) return this.resultFromSnapshot(snapshot);

    const pendingChangeChecks = plan.checks.some(
      (check) => check.spec.kind !== "PROJECT" && check.status === "PENDING",
    );
    if (!pendingChangeChecks) {
      if (currentEvaluation.status === "PASSED") {
        return this.finalizePassedVerificationLocked(snapshot, currentEvaluation);
      }
      return this.resultFromSnapshot(snapshot);
    }

    const store = this.dependencies.verificationExecutionStore ?? recovery;
    const workspace = this.dependencies.verificationWorkspace;
    const git = this.dependencies.verificationGit;
    const reviewer =
      this.dependencies.verificationReviewer ??
      (this.dependencies.verificationModelTurns !== undefined &&
      this.dependencies.budget !== undefined
        ? new TaskAcceptanceReviewer({
            modelTurns: this.dependencies.verificationModelTurns,
            budget: this.dependencies.budget,
            clock: this.dependencies.clock,
            ...(this.dependencies.verificationTurnIdentity === undefined
              ? {}
              : { resolveTurnIdentity: this.dependencies.verificationTurnIdentity }),
            ...(this.dependencies.tokenEstimator === undefined
              ? {}
              : { tokenEstimator: this.dependencies.tokenEstimator }),
          })
        : undefined);
    if (
      store === undefined ||
      workspace === undefined ||
      git === undefined ||
      reviewer === undefined
    )
      return this.resultFromSnapshot(snapshot);

    const signal = this.executionSignal(snapshot.run.id);
    const changedFiles = snapshot.state.changedFiles;
    let cachedGitStatus: Awaited<ReturnType<NonNullable<typeof git>["status"]>> | undefined;
    const stageRunner = new VerificationStageRunner();
    const stage = await stageRunner.run({
      runId: snapshot.run.id,
      sessionId: snapshot.run.sessionId,
      plan,
      store,
      signal,
      now: () => this.dependencies.clock.now(),
      discoveryEvidence: (check, capturedAt) =>
        VerificationEvidenceSchema.parse({
          id: (this.dependencies.verificationEvidenceIdFactory ?? createVerificationEvidenceId)(),
          planId: plan.id,
          checkId: check.id,
          kind: "DISCOVERY",
          summary: `${check.spec.kind} verification inspection prepared`,
          details: { kind: check.spec.kind, purpose: check.spec.purpose },
          capturedAt,
        }),
      onCommittedEvents: (events) => this.notify(events as readonly DurableAgentEvent[]),
      executors: {
        WORKSPACE: {
          execute: async (check) => {
            const facts = await workspace.inspect({
              workspace: snapshot.run.workspace,
              changedFiles,
              signal,
            });
            const result = verifyWorkspaceInspection({ changedFiles, facts });
            const evidence = createWorkspaceEvidence({
              id: (
                this.dependencies.verificationEvidenceIdFactory ?? createVerificationEvidenceId
              )(),
              planId: plan.id,
              checkId: check.id,
              capturedAt: this.dependencies.clock.now(),
              result,
            });
            return { status: result.status, evidence: [evidence] };
          },
        },
        GIT: {
          preflight: async (check) => {
            cachedGitStatus = await git.status({
              workspace: snapshot.run.workspace,
              signal,
            });
            if (cachedGitStatus.available || check.requirement === "REQUIRED") return undefined;
            const evidence = createDiscoveryEvidence({
              id: (
                this.dependencies.verificationEvidenceIdFactory ?? createVerificationEvidenceId
              )(),
              planId: plan.id,
              checkId: check.id,
              capturedAt: this.dependencies.clock.now(),
              resolver: "runtime-git",
              ecosystem: "git",
              available: false,
              reason: "TOOLING_UNAVAILABLE",
            });
            return {
              status: "SKIPPED" as const,
              skipReason: "NOT_AVAILABLE" as const,
              evidence: [evidence],
            };
          },
          execute: async (check) => {
            const status =
              cachedGitStatus ??
              (cachedGitStatus = await git.status({
                workspace: snapshot.run.workspace,
                signal,
              }));
            const diffs = [];
            for (const changedFile of changedFiles.slice(0, 128)) {
              if (
                status.entries?.some(
                  (entry) => entry.path === changedFile.path && entry.kind === "UNTRACKED",
                )
              )
                continue;
              diffs.push(
                await git.diff({
                  workspace: snapshot.run.workspace,
                  path: changedFile.path,
                  scope: "ALL",
                  signal,
                }),
              );
            }
            const result = reviewGitChangeset({
              changedFiles,
              requirement: check.requirement,
              status,
              diffs,
            });
            const evidence = createGitEvidence({
              id: (
                this.dependencies.verificationEvidenceIdFactory ?? createVerificationEvidenceId
              )(),
              planId: plan.id,
              checkId: check.id,
              capturedAt: this.dependencies.clock.now(),
              result,
            });
            return { status: result.status, evidence: [evidence] };
          },
        },
        TASK: {
          execute: async (check) => {
            if (snapshot.continuation?.type !== "AWAITING_VERIFICATION") {
              return {
                status: "ERROR" as const,
                evidence: [
                  this.genericTaskEvidence(plan.id, check.id, "FINAL_CANDIDATE_UNAVAILABLE"),
                ],
              };
            }
            const bundle = buildTaskReviewBundle({
              originalGoal: snapshot.run.goal,
              candidateText: snapshot.continuation.finalDecision.candidateText,
              plan,
              evidence: (await recovery.getPlanExecutionSnapshot(plan.id))?.evidence ?? [],
              changedFiles,
            });
            const review = await reviewer.review({
              run: snapshot.run,
              candidateText: snapshot.continuation.finalDecision.candidateText,
              bundle,
              signal,
            });
            const evidence =
              review.review === undefined
                ? this.genericTaskEvidence(
                    plan.id,
                    check.id,
                    review.errorCode ?? "REVIEWER_ERROR",
                    review.reviewInputHash,
                  )
                : createTaskAcceptanceEvidence({
                    id: (
                      this.dependencies.verificationEvidenceIdFactory ??
                      createVerificationEvidenceId
                    )(),
                    planId: plan.id,
                    checkId: check.id,
                    capturedAt: this.dependencies.clock.now(),
                    reviewInputHash: review.reviewInputHash,
                    verdict: review.review.verdict,
                    summary: review.review.summary,
                    ...(review.review.repairInstructions === undefined
                      ? {}
                      : { repairInstructions: review.review.repairInstructions }),
                    reviewedEvidenceIds: bundle.evidence.map((item) => item.id),
                  });
            return { status: review.status, evidence: [evidence] };
          },
        },
      },
    });
    if (stage.outcome === "CANCELLED")
      return this.resultFromSnapshot(await this.load(snapshot.run.id));
    const current = await this.load(snapshot.run.id);
    const execution = await recovery.getPlanExecutionSnapshot(plan.id);
    if (execution === null)
      throw new RunControllerInfrastructureError("Verification evidence disappeared.");
    const evaluation = evaluateVerification(execution.plan, execution.evidence);
    if (evaluation.status === "PASSED") {
      return this.finalizePassedVerificationLocked(current, evaluation);
    }
    if (evaluation.status === "ERROR") {
      return this.failVerificationLocked(current, evaluation);
    }
    if (evaluation.status !== "FAILED") return this.resultFromSnapshot(current);
    return this.maybeStartVerificationRepairLocked(current, evaluation);
  }

  private async settleStaleVerificationChecksLocked(
    snapshot: RunExecutionSnapshot,
    plan: VerificationPlan,
  ): Promise<void> {
    const recovery = this.verificationRecoveryStore();
    if (recovery === undefined) return;
    for (const check of plan.checks.filter((item) => item.status === "RUNNING")) {
      const settled = {
        ...check,
        status: "ERROR" as const,
        finishedAt: this.dependencies.clock.now(),
      };
      const evidence = VerificationEvidenceSchema.parse({
        id: (this.dependencies.verificationEvidenceIdFactory ?? createVerificationEvidenceId)(),
        planId: plan.id,
        checkId: check.id,
        kind: check.spec.kind === "PROJECT" ? "COMMAND" : check.spec.kind,
        summary: "Verification was interrupted before recovery and was not replayed.",
        details: { errorCode: "VERIFICATION_INTERRUPTED" },
        capturedAt: this.dependencies.clock.now(),
      });
      const committed = await recovery.settleCheck({
        runId: snapshot.run.id,
        sessionId: snapshot.run.sessionId,
        check: settled,
        evidence: [evidence],
      });
      this.notify(committed.events as readonly DurableAgentEvent[]);
    }
  }

  private async finalizePassedVerificationLocked(
    snapshot: RunExecutionSnapshot,
    evaluation: ReturnType<typeof evaluateVerification>,
  ): Promise<RunControllerResult> {
    const plan = snapshot.verificationPlan;
    const continuation = snapshot.continuation;
    const recovery = this.verificationRecoveryStore();
    if (
      plan === undefined ||
      snapshot.state === undefined ||
      continuation?.type !== "AWAITING_VERIFICATION" ||
      recovery === undefined
    )
      return this.resultFromSnapshot(snapshot);
    const execution = await recovery.getPlanExecutionSnapshot(plan.id);
    if (execution === null)
      throw new RunControllerInfrastructureError("Verification evidence disappeared.");

    let workspaceFreshness: CompletionFreshness = "UNPROVABLE";
    const workspaceCheck = plan.checks.find((check) => check.spec.kind === "WORKSPACE");
    if (workspaceCheck === undefined) {
      workspaceFreshness = "FRESH";
    } else if (this.dependencies.verificationWorkspace !== undefined) {
      const prior = execution.evidence.find(
        (item) => item.checkId === workspaceCheck.id && item.kind === "WORKSPACE",
      );
      const details = objectDetails(prior?.details);
      const expectedHash = stringValue(details?.workspaceFreshnessHash);
      const currentFacts = await this.dependencies.verificationWorkspace.inspect({
        workspace: snapshot.run.workspace,
        changedFiles: snapshot.state.changedFiles,
        signal: this.executionSignal(snapshot.run.id),
      });
      const current = verifyWorkspaceInspection({
        changedFiles: snapshot.state.changedFiles,
        facts: currentFacts,
      });
      workspaceFreshness =
        current.status === "PASSED" &&
        expectedHash !== undefined &&
        current.workspaceFreshnessHash === expectedHash
          ? "FRESH"
          : expectedHash === undefined || current.workspaceFreshnessHash === undefined
            ? "UNPROVABLE"
            : "STALE";
    }

    let gitFreshness: CompletionGitFreshness = "SKIPPED";
    const gitCheck = plan.checks.find((check) => check.spec.kind === "GIT");
    if (gitCheck !== undefined && gitCheck.status !== "SKIPPED") {
      gitFreshness = "UNPROVABLE";
      if (this.dependencies.verificationGit !== undefined) {
        const prior = execution.evidence.find(
          (item) => item.checkId === gitCheck.id && item.kind === "GIT",
        );
        const status = await this.dependencies.verificationGit.status({
          workspace: snapshot.run.workspace,
          signal: this.executionSignal(snapshot.run.id),
        });
        const diffs = [];
        for (const changedFile of snapshot.state.changedFiles.slice(0, 128)) {
          if (
            status.entries?.some(
              (entry) => entry.path === changedFile.path && entry.kind === "UNTRACKED",
            )
          )
            continue;
          diffs.push(
            await this.dependencies.verificationGit.diff({
              workspace: snapshot.run.workspace,
              path: changedFile.path,
              scope: "ALL",
              signal: this.executionSignal(snapshot.run.id),
            }),
          );
        }
        const current = reviewGitChangeset({
          changedFiles: snapshot.state.changedFiles,
          requirement: gitCheck.requirement,
          status,
          diffs,
        });
        const priorDetails = objectDetails(prior?.details);
        const currentComparable = {
          attributedPaths: current.attributedPaths,
          unattributedDirtyPaths: current.unattributedDirtyPaths,
          unmergedPaths: current.unmergedPaths,
          diffHashes: current.diffHashes,
          noNetDiffPaths: current.noNetDiffPaths,
          truncated: current.truncated,
          reviewComplete: current.reviewComplete,
        };
        const priorComparable = {
          attributedPaths: arrayValue(priorDetails?.attributedPaths),
          unattributedDirtyPaths: arrayValue(priorDetails?.unattributedDirtyPaths),
          unmergedPaths: arrayValue(priorDetails?.unmergedPaths),
          diffHashes: objectValue(priorDetails?.diffHashes),
          noNetDiffPaths: arrayValue(priorDetails?.noNetDiffPaths),
          truncated: priorDetails?.truncated,
          reviewComplete: priorDetails?.reviewComplete,
        };
        gitFreshness =
          current.status === "PASSED" &&
          JSON.stringify(currentComparable) === JSON.stringify(priorComparable)
            ? "FRESH"
            : "STALE";
      }
    }

    const candidateHash = computeVerificationCandidateTextHash(
      continuation.finalDecision.candidateText,
    );
    const authority = evaluateCompletionAuthority({
      run: snapshot.run,
      plan,
      continuation,
      verificationStatus: evaluation.status,
      candidateHash,
      workspaceFreshness,
      gitFreshness,
      cancellationRequested: snapshot.cancellationIntent !== undefined,
    });
    if (authority.kind !== "COMPLETE") return this.resultFromSnapshot(snapshot);
    if (plan.candidateHash === undefined || workspaceFreshness !== "FRESH")
      return this.resultFromSnapshot(snapshot);
    const workspaceEvidence = execution.evidence.find(
      (item) => item.kind === "WORKSPACE" && item.checkId === workspaceCheck?.id,
    );
    const workspaceDetails = objectDetails(workspaceEvidence?.details);
    const workspaceHash =
      stringValue(workspaceDetails?.workspaceFreshnessHash) ??
      (workspaceCheck === undefined ? computeWorkspaceFreshnessHash([]) : undefined);
    if (workspaceHash === undefined) return this.resultFromSnapshot(snapshot);
    const evidenceDigest = computeVerificationEvidenceDigest(plan, execution.evidence);
    const seal = createVerificationCompletionSeal({
      runId: snapshot.run.id,
      planId: plan.id,
      sourceStepId: plan.sourceStepId,
      planHash: plan.planHash,
      candidateHash,
      evidenceDigest,
      workspaceFreshnessHash: workspaceHash,
    });
    const finalResult = createVerifiedRunFinalResult({
      run: snapshot.run,
      plan,
      continuation,
      candidateHash,
      seal,
      counts: {
        total: plan.checks.length,
        passed: plan.checks.filter((check) => check.status === "PASSED").length,
        skipped: plan.checks.filter((check) => check.status === "SKIPPED").length,
        advisoryWarnings: evaluation.warnings.length,
      },
    });
    const verificationStore = this.dependencies.verificationStore;
    if (verificationStore === undefined) return this.resultFromSnapshot(snapshot);
    const now = this.dependencies.clock.now();
    const completedRun = markAgentRunCompleted(snapshot.run, finalResult, now);
    const completedState = markAgentStateCompleted(snapshot.state, now);
    const events = [
      this.eventFactory.verificationFinalized(
        snapshot.run,
        plan,
        "PASSED",
        [],
        [],
        seal.sealHash,
        this.nextEventId(),
        now,
      ),
      this.eventFactory.statusChanged(
        snapshot.run,
        "VERIFYING",
        "COMPLETED",
        this.nextEventId(),
        now,
      ),
      this.eventFactory.completed(snapshot.run, finalResult, this.nextEventId(), now),
    ];
    const commit = await verificationStore.commitVerifiedCompletion({
      run: completedRun,
      state: completedState,
      finalResult,
      verificationPlan: plan,
      expectedStateRevision: snapshot.stateRevision ?? null,
      expectedContinuationRevision: snapshot.continuationRevision ?? null,
      events,
    });
    this.notify(commit.events);
    void Promise.resolve()
      .then(() =>
        this.dependencies.onVerifiedCompletion?.({ run: commit.snapshot.run, finalResult }),
      )
      .catch(() => undefined);
    return this.resultFromSnapshot(commit.snapshot);
  }

  private async failVerificationLocked(
    snapshot: RunExecutionSnapshot,
    evaluation: ReturnType<typeof evaluateVerification>,
  ): Promise<RunControllerResult> {
    if (snapshot.state === undefined || snapshot.verificationPlan === undefined) {
      return this.resultFromSnapshot(snapshot);
    }
    const now = this.dependencies.clock.now();
    const error: AgentError = {
      code: "VERIFICATION_FAILED",
      message: "Verification did not establish a trustworthy completion boundary.",
      retryable: false,
      phase: "VERIFICATION",
    };
    const failedRun = markAgentRunFailed(
      AgentRunSchema.parse({ ...snapshot.run, currentStepId: undefined }),
      now,
    );
    const failedState = markAgentStateFailed(snapshot.state, error, now);
    const events = [
      this.eventFactory.verificationFinalized(
        snapshot.run,
        snapshot.verificationPlan,
        evaluation.status === "ERROR" ? "ERROR" : "FAILED",
        evaluation.failedCheckIds,
        evaluation.errorCheckIds,
        undefined,
        this.nextEventId(),
        now,
      ),
      this.eventFactory.error(snapshot.run, error, undefined, this.nextEventId(), now),
      this.eventFactory.statusChanged(snapshot.run, "VERIFYING", "FAILED", this.nextEventId(), now),
      this.eventFactory.failed(snapshot.run, error, this.nextEventId(), now),
    ];
    const commit = await this.commit({
      run: failedRun,
      state: failedState,
      expectedStateRevision: snapshot.stateRevision ?? null,
      expectedContinuationRevision: snapshot.continuationRevision ?? null,
      stepWrites: [],
      messagesToAppend: [],
      continuation: { operation: "CLEAR" },
      events,
    });
    this.notify(commit.events);
    return this.resultFromSnapshot(commit.snapshot);
  }

  private genericTaskEvidence(
    planId: VerificationPlan["id"],
    checkId: VerificationCheck["id"],
    errorCode: string,
    reviewInputHash?: string,
  ): VerificationEvidence {
    return VerificationEvidenceSchema.parse({
      id: (this.dependencies.verificationEvidenceIdFactory ?? createVerificationEvidenceId)(),
      planId,
      checkId,
      kind: "TASK",
      summary: "Task acceptance review errored",
      details: { errorCode, ...(reviewInputHash === undefined ? {} : { reviewInputHash }) },
      capturedAt: this.dependencies.clock.now(),
    });
  }

  private async maybeStartVerificationRepairLocked(
    snapshot: RunExecutionSnapshot,
    evaluation: ReturnType<typeof evaluateVerification>,
  ): Promise<RunControllerResult> {
    const plan = snapshot.verificationPlan;
    if (plan === undefined || snapshot.state === undefined)
      return this.resultFromSnapshot(snapshot);
    const recovery = this.verificationRecoveryStore();
    const count = this.dependencies.verificationPlanCount
      ? await this.dependencies.verificationPlanCount(snapshot.run.id)
      : recovery?.countPlans
        ? await recovery.countPlans(snapshot.run.id)
        : 1;
    const repairCycle = repairCycleForPlanCount(count);
    const policy = this.dependencies.verificationRepairPolicy ?? createVerificationRepairPolicy();
    if (!policy.canRepair({ ...evaluation, repairCycle })) {
      return this.failVerificationLocked(snapshot, evaluation);
    }
    const evidence = (await recovery?.getPlanExecutionSnapshot(plan.id))?.evidence ?? [];
    const now = this.dependencies.clock.now();
    const run = resumeAgentRunFromVerificationRepair(snapshot.run);
    const state = resumeAgentStateFromVerificationRepair(snapshot.state, now);
    const checkpoint = {
      type: "WAITING_VERIFICATION_REPAIR" as const,
      runId: run.id,
      failedPlanId: plan.id,
      sourceStepId: plan.sourceStepId,
      failedCheckIds: evaluation.failedCheckIds,
      evidenceIds: evidence
        .filter((item) => evaluation.failedCheckIds.includes(item.checkId))
        .map((item) => item.id),
      repairCycle,
    };
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: snapshot.stateRevision ?? null,
      expectedContinuationRevision: snapshot.continuationRevision ?? null,
      stepWrites: [],
      messagesToAppend: [],
      continuation: { operation: "SET", checkpoint, updatedAt: now },
      events: [
        this.eventFactory.statusChanged(
          snapshot.run,
          "VERIFYING",
          "RUNNING",
          this.nextEventId(),
          now,
        ),
        this.eventFactory.verificationRepairStarted(
          snapshot.run,
          plan.id,
          evaluation.failedCheckIds,
          repairCycle,
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    return this.resultFromSnapshot(commit.snapshot);
  }

  private verificationRecoveryStore() {
    if (this.dependencies.verificationExecutionRecovery !== undefined) {
      return this.dependencies.verificationExecutionRecovery;
    }
    const candidate = this.dependencies.verificationExecutionStore;
    if (candidate !== undefined && "getPlanExecutionSnapshot" in candidate) {
      return candidate as import("@caelush/verification").VerificationExecutionRecoveryStorePort;
    }
    return undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function semanticEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => semanticEqual(value, right[index]))
    );
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && semanticEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function objectDetails(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayValue(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

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

function addTimestamp(now: AgentRun["createdAt"], delayMs: number): AgentRun["createdAt"] {
  if (delayMs > Number.MAX_SAFE_INTEGER - now) {
    throw new RunControllerInvariantError("Retry timestamp exceeded the safe integer range");
  }
  return createTimestampMs(now + delayMs);
}
