import type { AIToolResultMessage } from "@caelush/ai";
import type { RunEventFactory } from "@caelush/agent";
import {
  AgentRunSchema,
  AgentStateSchema,
  type AgentError,
  type AgentState,
  type AgentStep,
  type EventId,
  type StepId,
  type TimestampMs,
} from "@caelush/protocol";
import type { AgentToolCallsDecision } from "./agent-decision.js";
import { markAgentStateMaxStepsReached } from "./agent-state.js";
import type { RunExecutionCommit, RunExecutionSnapshot } from "./run-execution-store.js";

export type OutputRecoveryRetryResumeContext =
  | {
      readonly mode: "START";
    }
  | {
      readonly mode: "STEERING";
      readonly messageIds: readonly string[];
      readonly sourceStepId: StepId;
    }
  | {
      readonly mode: "TOOL_RESULTS";
      readonly pendingDecision: AgentToolCallsDecision;
      readonly receivedResults: readonly AIToolResultMessage[];
      readonly sourceStepId?: StepId | undefined;
    };

interface OutputRecoveryCommitInput {
  readonly current: RunExecutionSnapshot;
  readonly failedStep: AgentStep;
  readonly resultError: AgentError;
  readonly settledState: AgentState;
  readonly now: TimestampMs;
  readonly eventFactory: RunEventFactory;
  readonly nextEventId: () => EventId;
}

export function createOutputRecoveryMaxStepsCommit(
  input: OutputRecoveryCommitInput,
): RunExecutionCommit {
  const { current, failedStep, resultError, settledState, now, eventFactory, nextEventId } = input;
  const state = markAgentStateMaxStepsReached(settledState, now);
  const run = AgentRunSchema.parse({
    ...current.run,
    status: "MAX_STEPS_REACHED",
    currentStepId: undefined,
    finishedAt: now,
  });

  return {
    run,
    state,
    expectedStateRevision: current.stateRevision ?? null,
    expectedContinuationRevision: current.continuationRevision ?? null,
    failIfCancellationRequested: true,
    stepWrites: [{ operation: "UPDATE", step: failedStep }],
    messagesToAppend: [],
    ...(current.continuation === undefined ? {} : { continuation: { operation: "CLEAR" } }),
    events: [
      eventFactory.llmFailed(current.run, failedStep, resultError, nextEventId(), now),
      eventFactory.maxSteps(
        current.run,
        state,
        {
          type: "MAX_STEPS_REACHED",
          stepsCompleted: state.usage.steps,
          maxSteps: current.run.limits.maxSteps,
        },
        nextEventId(),
        now,
      ),
      eventFactory.statusChanged(current.run, "RUNNING", "MAX_STEPS_REACHED", nextEventId(), now),
    ],
  };
}

export function createOutputRecoveryScheduleCommit(
  input: OutputRecoveryCommitInput & {
    readonly admittedOutputTokens: number;
    readonly targetOutputTokens: number;
    readonly retryContext: OutputRecoveryRetryResumeContext;
  },
): RunExecutionCommit {
  const {
    current,
    failedStep,
    resultError,
    settledState,
    now,
    eventFactory,
    nextEventId,
    admittedOutputTokens,
    targetOutputTokens,
    retryContext,
  } = input;
  const state = AgentStateSchema.parse({
    ...settledState,
    modelOutputRecovery: {
      version: 1,
      sourceStepId: failedStep.id,
      previousOutputTokens: admittedOutputTokens,
      targetOutputTokens,
      phase: "RESERVED",
    },
  });
  const run = AgentRunSchema.parse({ ...current.run, currentStepId: undefined });
  const nextAttemptAt = now;

  return {
    run,
    state,
    expectedStateRevision: current.stateRevision ?? null,
    expectedContinuationRevision: current.continuationRevision ?? null,
    failIfCancellationRequested: true,
    stepWrites: [{ operation: "UPDATE", step: failedStep }],
    messagesToAppend: [],
    continuation: {
      operation: "SET",
      checkpoint: {
        type: "WAITING_RETRY",
        runId: run.id,
        failedStepId: failedStep.id,
        attempt: 2,
        maxAttempts: 2,
        nextAttemptAt,
        errorCode: "LLM_OUTPUT_TRUNCATED",
        ...retryContext,
      },
      updatedAt: now,
    },
    events: [
      eventFactory.llmFailed(current.run, failedStep, resultError, nextEventId(), now),
      eventFactory.retryScheduledV2(
        run,
        failedStep,
        {
          attempt: 2,
          maxAttempts: 2,
          delayMs: 0,
          nextAttemptAt,
          errorCode: "LLM_OUTPUT_TRUNCATED",
        },
        nextEventId(),
        now,
      ),
    ],
  };
}
