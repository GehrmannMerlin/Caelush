import type { LLMToolResultMessage } from "@caelush/llm/messages";
import {
  ToolBatchInputError,
  type ToolBatchItem,
  type ToolBatchOutcome,
  type ToolSecurityContext,
} from "@caelush/tools";
import {
  AgentRunSchema,
  ApprovalResolutionSchema,
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
  type VerificationPlan,
} from "@caelush/protocol";
import type { AgentLoopExecutionResult, AgentLoopOutcomeResult } from "./agent-loop-input.js";
import {
  cancelAgentStepState,
  createInitialAgentState,
  markAgentStateCancelled,
  markAgentStateWaitingApproval,
  markAgentStateMaxStepsReached,
  markAgentStateBudgetExceeded,
  resumeAgentStateFromApproval,
  settleAgentStepState,
  startAgentState,
} from "./agent-state.js";
import { failAgentStep } from "./agent-step.js";
import { cancelAgentStep } from "./agent-step.js";
import { normalizeToolResultBatch } from "./agent-tool-results.js";
import { toLLMToolResultMessages } from "./agent-tool-batch.js";
import {
  markAgentRunFailed,
  markAgentRunCancelled,
  markAgentRunTimedOut,
  markAgentRunBudgetExceeded,
  markAgentRunWaitingApproval,
  resumeAgentRunFromApproval,
  markAgentStateFailed,
  assertRunExecutionInvariant,
} from "./run-execution-state.js";
import { markAgentStateTimedOut } from "./agent-state.js";
import { RunExecutionScopeRegistry } from "./run-execution-scope.js";
import { RunDeadlineRegistry } from "./run-deadline-registry.js";
import { deriveRunDeadline, isRunDeadlineExceeded } from "./run-deadline.js";
import { resolveRunTerminationAuthority } from "./run-termination-authority.js";
import {
  RunExecutionConflictError,
  RunExecutionInvariantError,
  type RunExecutionCommit,
  type RunExecutionSnapshot,
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
import { AgentBudgetAdmissionError } from "./agent-errors.js";
import type { AgentBudgetBlock } from "./agent-errors.js";
import { ProjectCheckResolverRegistry, type VerificationRunnerInput } from "@caelush/verification";

export class RunControllerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunControllerInputError";
  }
}

export class RunControllerBusyError extends Error {
  constructor(runId: RunId) {
    super(`Run ${runId} is already being executed`);
    this.name = "RunControllerBusyError";
  }
}

export class RunControllerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunControllerConflictError";
  }
}

export class RunControllerInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunControllerInfrastructureError";
  }
}

export class RunControllerInvariantError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunControllerInvariantError";
  }
}

const STALE_STEP_ERROR = {
  code: "INTERNAL_ERROR" as const,
  message: "An in-flight agent step was interrupted before durable settlement.",
  retryable: false,
  phase: "RUNTIME" as const,
};

export class RunController {
  private readonly activeRuns = new Set<RunId>();
  private readonly scopes: RunExecutionScopeRegistry;
  private readonly deadlineRegistry: RunDeadlineRegistry;
  private readonly retryRegistry: RunRetryRegistry;
  private readonly retryController: RetryController;
  private readonly eventFactory: RunControllerEventFactory;

  constructor(private readonly dependencies: RunControllerDependencies) {
    this.eventFactory = createRunControllerEventFactory();
    this.scopes = dependencies.scopes ?? new RunExecutionScopeRegistry();
    this.deadlineRegistry =
      dependencies.deadlineRegistry ?? new RunDeadlineRegistry({ clock: dependencies.clock });
    this.retryRegistry =
      dependencies.retryRegistry ?? new RunRetryRegistry({ clock: dependencies.clock });
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

  async cancel(runId: RunId): Promise<RunControllerResult> {
    const loaded = await this.load(runId);
    if (loaded.run.status === "CANCELLED" || isTerminal(loaded.run.status)) {
      return this.resultFromSnapshot(loaded);
    }
    const requestedAt = this.dependencies.clock.now();
    await this.dependencies.execution.requestCancellation(runId, {
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
    if (this.isExpired(commit.snapshot)) return this.finalizeTimeout(commit.snapshot);
    return this.driveToolBoundariesLocked(commit.snapshot, "EXECUTE");
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
    if (loaded.cancellationIntent !== undefined) return this.finalizeCancellation(loaded);
    if (this.isExpired(loaded)) return this.finalizeTimeout(loaded);
    if (loaded.run.status === "RUNNING" && loaded.continuation?.type === "WAITING_RETRY") {
      return this.resumeRetryLocked(loaded);
    }
    if (loaded.run.status === "RUNNING" && loaded.activeStep !== undefined) {
      return this.recoverStaleStep(loaded);
    }
    if (loaded.run.status === "WAITING_APPROVAL") {
      const approvalId =
        loaded.continuation?.type === "WAITING_TOOL_RESULTS"
          ? loaded.continuation.waitingApproval?.approvalId
          : undefined;
      const approvals = this.dependencies.approvals;
      if (approvalId !== undefined && approvals !== undefined) {
        const approval = await approvals.getById(approvalId);
        if (approval !== null && approval.status !== "PENDING") {
          return this.resumeResolvedApprovalLocked(loaded, approval);
        }
      }
      return this.resumeKnownBoundary(loaded);
    }
    if (
      loaded.run.status === "RUNNING" &&
      loaded.state !== undefined &&
      (loaded.continuation?.type === "WAITING_TOOL_RESULTS" ||
        (loaded.continuation === undefined && loaded.conversation.length === 0))
    ) {
      return this.driveToolBoundariesLocked(loaded, "RECOVER");
    }
    if (loaded.run.status === "VERIFYING") {
      return this.driveProjectVerificationLocked(loaded);
    }
    return this.resumeKnownBoundary(loaded);
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
    return this.executeLoop(loaded, loaded.continuation.mode === "TOOL_RESULTS");
  }

  private async driveToolBoundariesLocked(
    initial: RunExecutionSnapshot,
    initialMode: "EXECUTE" | "RECOVER",
  ): Promise<RunControllerResult> {
    let snapshot = initial;
    let mode = initialMode;
    while (true) {
      if (snapshot.cancellationIntent !== undefined) return this.finalizeCancellation(snapshot);
      if (this.isExpired(snapshot)) return this.finalizeTimeout(snapshot);
      if (snapshot.run.status === "WAITING_APPROVAL") return this.resultFromSnapshot(snapshot);
      const continuation = snapshot.continuation;
      if (continuation?.type === "WAITING_TOOL_RESULTS") {
        if (continuation.receivedResults !== undefined) {
          const execution = await this.executeLoop(snapshot, true);
          if (execution.status !== "WAITING_TOOL_RESULTS") return execution;
          snapshot = await this.load(snapshot.run.id);
          mode = "EXECUTE";
          continue;
        }
        const coordinator = this.dependencies.toolCoordinator;
        if (coordinator === undefined) return this.resultFromSnapshot(snapshot);
        if (snapshot.state === undefined) {
          throw new RunControllerInvariantError("Tool execution requires an AgentState.");
        }
        const request = {
          signal: this.executionSignal(snapshot.run.id),
          sessionId: snapshot.run.sessionId,
          runId: snapshot.run.id,
          stepId: continuation.sourceStepId,
          securityContext: createToolSecurityContext(snapshot.run, snapshot.state),
          environment: {
            workspace: snapshot.run.workspace,
            runtime: snapshot.run.runtime,
          },
          items: continuation.pendingDecision.toolRequests.map((request): ToolBatchItem => request),
        };
        let outcome: ToolBatchOutcome;
        try {
          outcome =
            mode === "RECOVER"
              ? await coordinator.recover(request)
              : await coordinator.execute(request);
        } catch (error) {
          if (this.executionSignal(snapshot.run.id).aborted) {
            return this.finalizeAbortedExecution(snapshot);
          }
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
          return this.failBoundaryLocked(snapshot, agentError);
        }
        // Tool settlement may have advanced AgentState in its own atomic transaction.
        // Always continue from the durable revision before writing continuation, approval,
        // or failure state.
        snapshot = await this.load(snapshot.run.id);
        if (this.executionSignal(snapshot.run.id).aborted) {
          return this.finalizeAbortedExecution(snapshot);
        }
        if (outcome.kind === "WAITING_APPROVAL") {
          snapshot = await this.persistWaitingApprovalLocked(snapshot, outcome);
          if (this.executionSignal(snapshot.run.id).aborted) {
            return this.finalizeAbortedExecution(snapshot);
          }
          return this.resultFromSnapshot(snapshot);
        }
        if (outcome.kind === "BUDGET_EXCEEDED") {
          return this.finalizeBudgetExceeded(snapshot, {
            kind: "EXCEEDED",
            dimension: outcome.blocked.dimension,
            accounted: outcome.blocked.accounted,
            limit: outcome.blocked.limit,
          });
        }
        let messages: readonly LLMToolResultMessage[];
        try {
          messages = toLLMToolResultMessages(
            continuation.pendingDecision.toolRequests,
            outcome.results,
          );
        } catch (error) {
          return this.failBoundaryLocked(
            snapshot,
            {
              code: "RUNTIME_ERROR",
              message:
                "Tool execution infrastructure failed before a complete Tool Result batch was available.",
              retryable: false,
              phase: "TOOL",
            },
            error,
          );
        }
        snapshot = await this.persistCompleteToolResultsLocked(snapshot, messages);
        mode = "EXECUTE";
        continue;
      }
      const execution = await this.executeLoop(snapshot, false);
      if (execution.status !== "WAITING_TOOL_RESULTS") return execution;
      snapshot = await this.load(snapshot.run.id);
      mode = "EXECUTE";
    }
  }

  private async persistCompleteToolResultsLocked(
    loaded: RunExecutionSnapshot,
    results: readonly LLMToolResultMessage[],
  ): Promise<RunExecutionSnapshot> {
    if (loaded.continuation?.type !== "WAITING_TOOL_RESULTS") {
      throw new RunControllerInvariantError("Run is not waiting for a complete Tool Result batch");
    }
    if (loaded.state === undefined) {
      throw new RunControllerInvariantError("Run is not waiting for a complete Tool Result batch");
    }
    const normalized = normalizeToolResultBatch(
      loaded.continuation.pendingDecision.toolRequests,
      results,
    );
    if (
      loaded.continuation.receivedResults !== undefined &&
      !semanticEqual(loaded.continuation.receivedResults, normalized)
    ) {
      throw new RunControllerConflictError("A different Tool Result batch was already accepted");
    }
    if (loaded.continuation.receivedResults !== undefined) return loaded;
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
    return commit.snapshot;
  }

  private async persistWaitingApprovalLocked(
    loaded: RunExecutionSnapshot,
    outcome: Extract<ToolBatchOutcome, { kind: "WAITING_APPROVAL" }>,
  ): Promise<RunExecutionSnapshot> {
    if (loaded.state === undefined || loaded.continuation?.type !== "WAITING_TOOL_RESULTS") {
      throw new RunControllerInvariantError("Approval boundary requires a pending Tool batch");
    }
    const now = this.dependencies.clock.now();
    const run = markAgentRunWaitingApproval(loaded.run);
    const state = markAgentStateWaitingApproval(loaded.state, now);
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: loaded.stateRevision ?? null,
      expectedContinuationRevision: loaded.continuationRevision ?? null,
      stepWrites: [],
      messagesToAppend: [],
      continuation: {
        operation: "SET",
        checkpoint: {
          ...loaded.continuation,
          waitingApproval: {
            invocationId: outcome.waiting.invocationId,
            ...(outcome.waiting.approvalId === undefined
              ? {}
              : { approvalId: outcome.waiting.approvalId }),
            externalCallId: outcome.waiting.externalCallId,
            toolName: outcome.waiting.toolName,
          },
        },
        updatedAt: now,
      },
      events: [
        this.eventFactory.statusChanged(
          loaded.run,
          "RUNNING",
          "WAITING_APPROVAL",
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

  private async executeLoop(
    snapshot: RunExecutionSnapshot,
    resume: boolean,
  ): Promise<RunControllerResult> {
    if (snapshot.state === undefined)
      throw new RunControllerInputError("Run execution has no AgentState");
    const config = await this.dependencies.configResolver.resolve(snapshot.run);
    let preProviderError: unknown;
    const loop = this.dependencies.agentLoop.withLifecycleHooks({
      beforeProviderAdmission: async ({ run, step, request }) => {
        if (this.dependencies.budget === undefined) return request;
        const admission = await this.dependencies.budget.admitLLM({
          run,
          step,
          request,
        });
        if (admission.kind === "ALLOWED") return admission.request;
        throw new AgentBudgetAdmissionError(admission);
      },
      beforeProviderTurn: async ({ run, state, step }) => {
        const current = await this.load(run.id);
        if (current.state === undefined)
          throw new RunControllerInfrastructureError("Run state disappeared before provider turn");
        const activeRun = AgentRunSchema.parse({ ...run, currentStepId: step.id });
        const activeState = { ...state, currentStepId: step.id };
        try {
          const retry =
            current.continuation?.type === "WAITING_RETRY" ? current.continuation : undefined;
          const commit = await this.commit({
            run: activeRun,
            state: activeState,
            expectedStateRevision: current.stateRevision ?? null,
            expectedContinuationRevision: current.continuationRevision ?? null,
            stepWrites: [{ operation: "INSERT", step }],
            messagesToAppend: [],
            ...(retry === undefined ? {} : { continuation: { operation: "CLEAR" as const } }),
            events: [
              ...(retry === undefined
                ? []
                : [
                    this.eventFactory.retryStarted(
                      run,
                      step,
                      retry.attempt,
                      retry.maxAttempts,
                      this.nextEventId(),
                      this.dependencies.clock.now(),
                    ),
                  ]),
              this.eventFactory.llmStarted(
                run,
                step,
                this.nextEventId(),
                this.dependencies.clock.now(),
              ),
            ],
          });
          this.notify(commit.events);
        } catch (error) {
          preProviderError = error;
          throw error;
        }
      },
    });
    const input = {
      run: snapshot.run,
      state: snapshot.state,
      history: snapshot.conversation.map((entry) => entry.message),
      baseSystemPrompt: config.baseSystemPrompt,
      contextLimits: config.contextLimits,
      ...(this.dependencies.toolCoordinator === undefined ||
      this.dependencies.toolCoordinator.modelDefinitions().length === 0
        ? {}
        : { tools: this.dependencies.toolCoordinator.modelDefinitions() }),
      ...(config.modelSettings === undefined ? {} : { modelSettings: config.modelSettings }),
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      ...(config.explicitPaths === undefined ? {} : { explicitPaths: config.explicitPaths }),
    };
    let execution: AgentLoopExecutionResult;
    const signal = this.executionSignal(snapshot.run.id);
    if (resume) {
      const retryContinuation =
        snapshot.continuation?.type === "WAITING_RETRY" &&
        snapshot.continuation.mode === "TOOL_RESULTS"
          ? snapshot.continuation
          : undefined;
      const toolContinuation =
        snapshot.continuation?.type === "WAITING_TOOL_RESULTS" &&
        snapshot.continuation.receivedResults !== undefined
          ? snapshot.continuation
          : undefined;
      if (retryContinuation === undefined && toolContinuation === undefined) {
        throw new RunControllerInputError(
          "accepted Tool Results are missing from the continuation",
        );
      }
      const retryInput =
        retryContinuation === undefined
          ? {
              pendingDecision: toolContinuation!.pendingDecision,
              toolResults: toolContinuation!.receivedResults!,
            }
          : {
              pendingDecision: retryContinuation.pendingDecision,
              toolResults: retryContinuation.receivedResults,
            };
      execution = await loop.resumeWithToolResults({
        ...input,
        signal,
        ...retryInput,
      });
    } else {
      execution = await loop.run({ ...input, signal });
    }
    if (preProviderError !== undefined) {
      throw new RunControllerInfrastructureError("Unable to durably checkpoint provider turn", {
        cause: preProviderError,
      });
    }
    return this.settle(snapshot, execution, config.projectFacts);
  }

  private async settle(
    before: RunExecutionSnapshot,
    execution: AgentLoopExecutionResult,
    projectFacts?: import("@caelush/protocol").VerificationProjectFacts,
  ): Promise<RunControllerResult> {
    if (execution.status === "CANCELLED") return this.finalizeAbortedExecution(before, execution);
    const current = await this.load(before.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "CANCELLED") return this.finalizeCancellation(current);
    if (authority === "TIMEOUT") return this.finalizeTimeout(current);
    if (authority === "TERMINAL") return this.resultFromSnapshot(current);
    if (authority === "UNEXPECTED_ABORT") {
      throw new RunControllerInvariantError("Run execution aborted without a known authority");
    }
    if (execution.status === "FAILED" && execution.budget?.kind === "EXCEEDED") {
      return this.finalizeBudgetExceeded(current, execution.budget);
    }
    const budgetSettlement = await this.settleBudgetAttempt(current, execution);
    if (budgetSettlement !== undefined) {
      return this.finalizeBudgetExceeded(current, budgetSettlement);
    }
    if (current.state === undefined)
      throw new RunControllerInfrastructureError("Run state disappeared during settlement");
    const now = this.dependencies.clock.now();
    let run: AgentRun;
    let state: AgentState = execution.state;
    if (this.dependencies.budget?.reconcileState !== undefined) {
      state = await this.dependencies.budget.reconcileState(state);
    }
    let continuation: RunExecutionCommit["continuation"];
    let events: DurableEventDraft[];
    let verificationPlan: VerificationPlan | undefined;
    if (execution.status === "FAILED") {
      const retrySettlement = await this.settleProviderFailure(current, before, execution, now);
      if (retrySettlement !== undefined) return retrySettlement;
      state = markAgentStateFailed(state, execution.error, now);
      const settledRun = AgentRunSchema.parse({ ...current.run, currentStepId: undefined });
      run = markAgentRunFailed(settledRun, now);
      continuation = current.continuation === undefined ? undefined : { operation: "CLEAR" };
      events = this.failureEvents(current.run, run, execution.error, execution.step, now);
      if (execution.providerTurnState === "FAILED" && execution.step !== undefined) {
        events.unshift(
          this.eventFactory.llmFailed(
            current.run,
            execution.step,
            execution.error,
            this.nextEventId(),
            now,
          ),
        );
      }
      if (execution.providerTurnState === "COMPLETED" && execution.step !== undefined) {
        events.unshift(
          this.eventFactory.llmCompleted(
            current.run,
            execution.state,
            execution.step,
            this.nextEventId(),
            now,
          ),
        );
      }
    } else if (execution.outcome.type === "MAX_STEPS_REACHED") {
      run = AgentRunSchema.parse({ ...current.run, status: "MAX_STEPS_REACHED", finishedAt: now });
      continuation = current.continuation === undefined ? undefined : { operation: "CLEAR" };
      events = [
        this.eventFactory.maxSteps(current.run, state, execution.outcome, this.nextEventId(), now),
        this.eventFactory.statusChanged(
          current.run,
          "RUNNING",
          "MAX_STEPS_REACHED",
          this.nextEventId(),
          now,
        ),
      ];
    } else if (execution.outcome.type === "TOOL_CALLS_REQUESTED") {
      run = AgentRunSchema.parse({ ...current.run, currentStepId: undefined });
      continuation = {
        operation: "SET",
        checkpoint: {
          type: "WAITING_TOOL_RESULTS",
          runId: run.id,
          sourceStepId: execution.step!.id,
          pendingDecision: execution.outcome,
        },
        updatedAt: now,
      };
      events = this.successEvents(current.run, state, execution.step!, execution, now);
    } else {
      verificationPlan = this.createVerificationPlan(
        current.run,
        execution.step!,
        state.changedFiles,
        projectFacts,
      );
      run = AgentRunSchema.parse({ ...current.run, status: "VERIFYING", currentStepId: undefined });
      continuation = {
        operation: "SET",
        checkpoint: {
          type: "AWAITING_VERIFICATION",
          runId: run.id,
          sourceStepId: execution.step!.id,
          verificationPlanId: verificationPlan.id,
          finalDecision: execution.outcome,
        },
        updatedAt: now,
      };
      events = [
        ...this.successEvents(current.run, state, execution.step!, execution, now),
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
      ];
    }
    const messagesToAppend = execution.messagesToAppend.map((message) => ({
      createdAt: now,
      ...(message.role === "assistant" && execution.step === undefined
        ? {}
        : message.role === "assistant"
          ? { sourceStepId: execution.step!.id }
          : {}),
      ...(message.role === "tool" && current.continuation?.type === "WAITING_TOOL_RESULTS"
        ? { sourceStepId: current.continuation.sourceStepId }
        : {}),
      message,
    }));
    const commit = await this.commit({
      run,
      state,
      expectedStateRevision: current.stateRevision ?? null,
      expectedContinuationRevision: current.continuationRevision ?? null,
      stepWrites:
        execution.step === undefined ? [] : [{ operation: "UPDATE", step: execution.step }],
      messagesToAppend,
      ...(continuation === undefined ? {} : { continuation }),
      ...(verificationPlan === undefined ? {} : { verificationPlan }),
      events,
    });
    this.notify(commit.events);
    if (verificationPlan !== undefined) {
      return this.driveProjectVerificationLocked(commit.snapshot);
    }
    return this.resultFromSnapshot(commit.snapshot);
  }

  private async settleProviderFailure(
    current: RunExecutionSnapshot,
    before: RunExecutionSnapshot,
    execution: Extract<AgentLoopExecutionResult, { status: "FAILED" }>,
    now: AgentRun["createdAt"],
  ): Promise<RunControllerResult | undefined> {
    if (execution.providerTurnState !== "FAILED" || execution.retry === undefined) return undefined;
    if (execution.step === undefined) {
      throw new RunControllerInvariantError("Provider failure has no failed Step");
    }
    const deadline = deriveRunDeadline(current.run);
    const attempt = before.continuation?.type === "WAITING_RETRY" ? before.continuation.attempt : 1;
    const decision = this.retryController.decide({
      retryable: execution.retry.retryable,
      attempt,
      steps: execution.state.usage.steps,
      maxSteps: current.run.limits.maxSteps,
      now,
      ...(deadline === undefined ? {} : { deadlineAt: deadline.deadlineAt }),
      ...(execution.retry.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: execution.retry.retryAfterMs }),
    });
    const previous = before.continuation;
    const retryContext =
      previous?.type === "WAITING_TOOL_RESULTS" && previous.receivedResults !== undefined
        ? {
            mode: "TOOL_RESULTS" as const,
            pendingDecision: previous.pendingDecision,
            receivedResults: previous.receivedResults,
          }
        : previous?.type === "WAITING_RETRY" && previous.mode === "TOOL_RESULTS"
          ? {
              mode: "TOOL_RESULTS" as const,
              pendingDecision: previous.pendingDecision,
              receivedResults: previous.receivedResults,
            }
          : { mode: "START" as const };
    if (decision.kind === "STOP" && decision.reason === "ATTEMPTS_EXHAUSTED") return undefined;
    if (decision.kind === "STOP" && decision.reason === "NOT_RETRYABLE") return undefined;

    if (decision.kind === "STOP" && decision.reason === "MAX_STEPS_REACHED") {
      const state = markAgentStateMaxStepsReached(execution.state, now);
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
        stepWrites: [{ operation: "UPDATE", step: execution.step }],
        messagesToAppend: [],
        ...(current.continuation === undefined ? {} : { continuation: { operation: "CLEAR" } }),
        events: [
          this.eventFactory.llmFailed(
            current.run,
            execution.step,
            execution.error,
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

    if (decision.kind === "STOP" && decision.reason === "DEADLINE_EXCEEDED") {
      if (deadline === undefined) {
        throw new RunControllerInvariantError(
          "A deadline-exceeded retry decision has no Run deadline",
        );
      }
      const run = AgentRunSchema.parse({ ...current.run, currentStepId: undefined });
      const checkpoint = {
        type: "WAITING_RETRY" as const,
        runId: run.id,
        failedStepId: execution.step.id,
        attempt: attempt + 1,
        maxAttempts: this.retryController.maxAttempts,
        nextAttemptAt: deadline.deadlineAt,
        errorCode: execution.retry.code,
        ...retryContext,
      };
      const commit = await this.commit({
        run,
        state: execution.state,
        expectedStateRevision: current.stateRevision ?? null,
        expectedContinuationRevision: current.continuationRevision ?? null,
        stepWrites: [{ operation: "UPDATE", step: execution.step }],
        messagesToAppend: [],
        continuation: { operation: "SET", checkpoint, updatedAt: now },
        events: [
          this.eventFactory.llmFailed(
            current.run,
            execution.step,
            execution.error,
            this.nextEventId(),
            now,
          ),
        ],
      });
      this.notify(commit.events);
      return this.resultFromSnapshot(commit.snapshot);
    }

    if (decision.kind !== "RETRY") return undefined;
    const nextAttemptAt = addTimestamp(now, decision.delayMs);
    const run = AgentRunSchema.parse({ ...current.run, currentStepId: undefined });
    const checkpoint = {
      type: "WAITING_RETRY" as const,
      runId: run.id,
      failedStepId: execution.step.id,
      attempt: decision.attempt,
      maxAttempts: this.retryController.maxAttempts,
      nextAttemptAt,
      errorCode: execution.retry.code,
      ...retryContext,
    };
    const commit = await this.commit({
      run,
      state: execution.state,
      expectedStateRevision: current.stateRevision ?? null,
      expectedContinuationRevision: current.continuationRevision ?? null,
      stepWrites: [{ operation: "UPDATE", step: execution.step }],
      messagesToAppend: [],
      continuation: { operation: "SET", checkpoint, updatedAt: now },
      events: [
        this.eventFactory.llmFailed(
          current.run,
          execution.step,
          execution.error,
          this.nextEventId(),
          now,
        ),
        this.eventFactory.retryScheduled(
          current.run,
          execution.step,
          decision.attempt,
          this.retryController.maxAttempts,
          decision.delayMs,
          nextAttemptAt,
          execution.retry.code,
          this.nextEventId(),
          now,
        ),
      ],
    });
    this.notify(commit.events);
    this.scheduleRetry(run.id, nextAttemptAt, deadline?.deadlineAt);
    return this.resultFromSnapshot(commit.snapshot);
  }

  private async finalizeCancellation(
    before: RunExecutionSnapshot,
    execution?: Extract<AgentLoopExecutionResult, { status: "CANCELLED" }>,
  ): Promise<RunControllerResult> {
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
    let state = execution?.state ?? current.state;
    let step = execution?.step;
    if (state !== undefined && state.currentStepId !== undefined) {
      const activeStep = current.activeStep ?? step;
      if (activeStep === undefined || activeStep.id !== state.currentStepId) {
        throw new RunControllerInvariantError("Cancellation cannot reconcile the active Step");
      }
      step = step ?? cancelAgentStep(activeStep, now);
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
    execution?: Extract<AgentLoopExecutionResult, { status: "CANCELLED" }>,
  ): Promise<RunControllerResult> {
    const current = await this.load(before.run.id);
    const authority = this.resolveAuthority(current, true);
    if (authority === "CANCELLED") return this.finalizeCancellation(current, execution);
    if (authority === "TIMEOUT") return this.finalizeTimeout(current, execution);
    if (authority === "TERMINAL") return this.resultFromSnapshot(current);
    throw new RunControllerInvariantError("Run execution aborted without a known authority");
  }

  private async finalizeTimeout(
    before: RunExecutionSnapshot,
    execution?: Extract<AgentLoopExecutionResult, { status: "CANCELLED" }>,
  ): Promise<RunControllerResult> {
    const current = await this.load(before.run.id);
    this.retryRegistry.disarm(current.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "TERMINAL") return this.resultFromSnapshot(current);
    if (authority === "CANCELLED") return this.finalizeCancellation(current, execution);
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
    if (latest.cancellationIntent !== undefined)
      return this.finalizeCancellation(latest, execution);
    if (!this.isExpired(latest)) return this.resultFromSnapshot(latest);

    const now = this.dependencies.clock.now();
    let state = latest.state ?? execution?.state;
    let step = execution?.step;
    if (state !== undefined && state.currentStepId !== undefined) {
      const activeStep = latest.activeStep ?? step;
      if (activeStep === undefined || activeStep.id !== state.currentStepId) {
        throw new RunControllerInvariantError("Timeout cannot reconcile the active Step");
      }
      step = step ?? cancelAgentStep(activeStep, now);
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

  private async settleBudgetAttempt(
    current: RunExecutionSnapshot,
    execution: AgentLoopExecutionResult,
  ): Promise<Extract<AgentBudgetBlock, { kind: "EXCEEDED" }> | undefined> {
    const budget = this.dependencies.budget;
    const step = execution.step;
    if (budget === undefined || step === undefined) return undefined;
    if (execution.status === "CANCELLED") {
      await budget.markLLMConservative?.({
        runId: current.run.id,
        stepId: step.id,
        settledAt: this.dependencies.clock.now(),
      });
      return undefined;
    }
    const usage =
      execution.status === "FAILED"
        ? execution.usage
        : execution.outcome.type === "MAX_STEPS_REACHED"
          ? undefined
          : execution.outcome.modelTurn.usage;
    const result = await budget.settleLLM({
      runId: current.run.id,
      stepId: step.id,
      ...(usage === undefined ? {} : { usage }),
      settledAt: this.dependencies.clock.now(),
    });
    return result?.kind === "EXCEEDED" ? result : undefined;
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

  private failureEvents(
    run: AgentRun,
    failedRun: AgentRun,
    error: AgentError,
    step: AgentStep | undefined,
    timestamp: AgentRun["createdAt"],
  ): DurableEventDraft[] {
    return [
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

  private successEvents(
    run: AgentRun,
    state: AgentState,
    step: AgentStep,
    execution: AgentLoopOutcomeResult,
    timestamp: AgentRun["createdAt"],
  ): DurableEventDraft[] {
    const events: DurableEventDraft[] = [];
    if (execution.providerTurnState === "COMPLETED") {
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
      snapshot = await this.dependencies.execution.load(runId);
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
      return await this.dependencies.execution.commit(command);
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
    if (
      runner === undefined ||
      profileProvider === undefined ||
      execution === undefined ||
      executionStore === undefined ||
      security === undefined ||
      sanitizer === undefined ||
      plan === undefined
    ) {
      return this.resultFromSnapshot(snapshot);
    }
    if (plan.checks.some((check) => check.status === "RUNNING")) {
      return this.resultFromSnapshot(snapshot);
    }
    const config = await this.dependencies.configResolver.resolve(snapshot.run);
    const profile = await profileProvider.getFreshProfile(snapshot.run, config);
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
      security,
      execution,
      store: executionStore,
      evidenceIdFactory:
        this.dependencies.verificationEvidenceIdFactory ?? createVerificationEvidenceId,
      evidenceSanitizer: sanitizer,
      onCommittedEvents: (events) => this.notify(events as readonly DurableAgentEvent[]),
    };
    await runner.run(runnerInput);
    const current = await this.load(snapshot.run.id);
    const authority = this.resolveAuthority(current, false);
    if (authority === "CANCELLED") return this.finalizeCancellation(current);
    if (authority === "TIMEOUT") return this.finalizeTimeout(current);
    return this.resultFromSnapshot(current);
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
      throw new RunControllerInvariantError("started non-terminal Run has no deadline");
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

export function createToolSecurityContext(
  run: AgentRun,
  state: Pick<AgentState, "permissionProfile" | "approvalPolicy">,
): ToolSecurityContext {
  if (
    run.permissionProfile !== state.permissionProfile ||
    run.approvalPolicy !== state.approvalPolicy
  ) {
    throw new RunControllerInvariantError("Run security policy does not match AgentState policy.");
  }
  return Object.freeze({
    permissionProfile: run.permissionProfile,
    approvalPolicy: run.approvalPolicy,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
