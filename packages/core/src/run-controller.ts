import type { LLMToolResultMessage } from "@caelush/llm/messages";
import {
  AgentRunSchema,
  type AgentRun,
  type AgentError,
  type AgentState,
  type AgentStep,
  type RunId,
} from "@caelush/protocol";
import type { AgentLoopExecutionResult, AgentLoopOutcomeResult } from "./agent-loop-input.js";
import { createInitialAgentState, settleAgentStepState, startAgentState } from "./agent-state.js";
import { failAgentStep } from "./agent-step.js";
import { normalizeToolResultBatch } from "./agent-tool-results.js";
import {
  markAgentRunFailed,
  markAgentStateFailed,
  assertRunExecutionInvariant,
} from "./run-execution-state.js";
import {
  RunExecutionConflictError,
  RunExecutionInvariantError,
  type RunExecutionCommit,
  type RunExecutionSnapshot,
} from "./run-execution-store.js";
import type { DurableAgentEvent, DurableEventDraft } from "./run-execution-store.js";
import type { RunControllerResult } from "./run-controller-input.js";
import {
  createRunControllerEventFactory,
  type RunControllerEventFactory,
} from "./run-controller-events.js";
import type { RunControllerDependencies } from "./run-controller-ports.js";

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
  private readonly eventFactory: RunControllerEventFactory;

  constructor(private readonly dependencies: RunControllerDependencies) {
    this.eventFactory = createRunControllerEventFactory();
  }

  async start(runId: RunId): Promise<RunControllerResult> {
    return this.withLock(runId, async () => {
      const loaded = await this.load(runId);
      if (loaded.run.status !== "PENDING") return this.resumeKnownBoundary(loaded);
      if (loaded.state !== undefined) {
        throw new RunControllerInputError("PENDING Run cannot already have AgentState");
      }
      const now = this.dependencies.clock.now();
      const initialState = createInitialAgentState(loaded.run, now);
      const state = startAgentState(initialState, now);
      const run = AgentRunSchema.parse({
        ...loaded.run,
        status: "RUNNING",
        startedAt: now,
      });
      const commit = await this.commit({
        run,
        state,
        expectedStateRevision: null,
        expectedContinuationRevision: null,
        stepWrites: [],
        messagesToAppend: [],
        events: [
          this.eventFactory.runStarted(loaded.run, this.nextEventId(), now),
          this.eventFactory.statusChanged(
            loaded.run,
            "PENDING",
            "RUNNING",
            this.nextEventId(),
            now,
          ),
        ],
      });
      this.notify(commit.events);
      return this.executeLoop(commit.snapshot, false);
    });
  }

  async submitToolResults(
    runId: RunId,
    results: readonly LLMToolResultMessage[],
  ): Promise<RunControllerResult> {
    return this.withLock(runId, async () => {
      const loaded = await this.load(runId);
      if (loaded.run.status !== "RUNNING" || loaded.state === undefined) {
        throw new RunControllerInputError("Tool Results require a RUNNING Run");
      }
      const continuation = loaded.continuation;
      if (continuation?.type !== "WAITING_TOOL_RESULTS") {
        throw new RunControllerInputError("Run is not waiting for Tool Results");
      }
      let normalized: readonly LLMToolResultMessage[];
      try {
        normalized = normalizeToolResultBatch(continuation.pendingDecision.toolRequests, results);
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
        continuation.receivedResults !== undefined &&
        !semanticEqual(continuation.receivedResults, normalized)
      ) {
        throw new RunControllerConflictError("A different Tool Result batch was already accepted");
      }
      let accepted = loaded;
      if (continuation.receivedResults === undefined) {
        const commit = await this.commit({
          run: loaded.run,
          state: loaded.state,
          expectedStateRevision: loaded.stateRevision ?? null,
          expectedContinuationRevision: loaded.continuationRevision ?? null,
          stepWrites: [],
          messagesToAppend: [],
          continuation: {
            operation: "SET",
            checkpoint: { ...continuation, receivedResults: normalized },
            updatedAt: this.dependencies.clock.now(),
          },
          events: [],
        });
        accepted = commit.snapshot;
      }
      return this.executeLoop(accepted, true);
    });
  }

  async recover(runId: RunId): Promise<RunControllerResult> {
    return this.withLock(runId, async () => {
      const loaded = await this.load(runId);
      if (loaded.run.status === "RUNNING" && loaded.activeStep !== undefined) {
        return this.recoverStaleStep(loaded);
      }
      if (
        loaded.run.status === "RUNNING" &&
        loaded.state !== undefined &&
        loaded.continuation === undefined &&
        loaded.conversation.length === 0
      ) {
        return this.executeLoop(loaded, false);
      }
      return this.resumeKnownBoundary(loaded);
    });
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
      beforeProviderTurn: async ({ run, state, step }) => {
        const current = await this.load(run.id);
        if (current.state === undefined)
          throw new RunControllerInfrastructureError("Run state disappeared before provider turn");
        const activeRun = AgentRunSchema.parse({ ...run, currentStepId: step.id });
        const activeState = { ...state, currentStepId: step.id };
        try {
          const commit = await this.commit({
            run: activeRun,
            state: activeState,
            expectedStateRevision: current.stateRevision ?? null,
            expectedContinuationRevision: current.continuationRevision ?? null,
            stepWrites: [{ operation: "INSERT", step }],
            messagesToAppend: [],
            events: [
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
      ...(config.tools === undefined ? {} : { tools: config.tools }),
      ...(config.modelSettings === undefined ? {} : { modelSettings: config.modelSettings }),
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      ...(config.explicitPaths === undefined ? {} : { explicitPaths: config.explicitPaths }),
    };
    let execution: AgentLoopExecutionResult;
    if (resume) {
      if (
        snapshot.continuation?.type !== "WAITING_TOOL_RESULTS" ||
        snapshot.continuation.receivedResults === undefined
      ) {
        throw new RunControllerInputError(
          "accepted Tool Results are missing from the continuation",
        );
      }
      execution = await loop.resumeWithToolResults({
        ...input,
        pendingDecision: snapshot.continuation.pendingDecision,
        toolResults: snapshot.continuation.receivedResults,
      });
    } else {
      execution = await loop.run(input);
    }
    if (preProviderError !== undefined) {
      throw new RunControllerInfrastructureError("Unable to durably checkpoint provider turn", {
        cause: preProviderError,
      });
    }
    return this.settle(snapshot, execution);
  }

  private async settle(
    before: RunExecutionSnapshot,
    execution: AgentLoopExecutionResult,
  ): Promise<RunControllerResult> {
    const current = await this.load(before.run.id);
    if (current.state === undefined)
      throw new RunControllerInfrastructureError("Run state disappeared during settlement");
    const now = this.dependencies.clock.now();
    let run: AgentRun;
    let state: AgentState = execution.state;
    let continuation: RunExecutionCommit["continuation"];
    let events: DurableEventDraft[];
    if (execution.status === "FAILED") {
      state = markAgentStateFailed(state, execution.error, now);
      const settledRun = AgentRunSchema.parse({ ...current.run, currentStepId: undefined });
      run = markAgentRunFailed(settledRun, now);
      continuation = current.continuation === undefined ? undefined : { operation: "CLEAR" };
      events = this.failureEvents(current.run, run, execution.error, execution.step, now);
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
      run = AgentRunSchema.parse({ ...current.run, status: "VERIFYING", currentStepId: undefined });
      continuation = {
        operation: "SET",
        checkpoint: {
          type: "AWAITING_VERIFICATION",
          runId: run.id,
          sourceStepId: execution.step!.id,
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
      events,
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
      snapshot.run.status === "VERIFYING" &&
      snapshot.continuation?.type === "AWAITING_VERIFICATION"
    ) {
      return {
        status: "AWAITING_VERIFICATION",
        run: snapshot.run,
        state: snapshot.state!,
        sourceStepId: snapshot.continuation.sourceStepId,
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

  private nextEventId() {
    return this.dependencies.eventIdFactory.create();
  }

  private notify(events: readonly DurableAgentEvent[]): void {
    if (events.length > 0) this.dependencies.events.notifyCommitted(events);
  }

  private async withLock<T>(runId: RunId, operation: () => Promise<T>): Promise<T> {
    if (this.activeRuns.has(runId)) throw new RunControllerBusyError(runId);
    this.activeRuns.add(runId);
    try {
      return await operation();
    } finally {
      this.activeRuns.delete(runId);
    }
  }
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
