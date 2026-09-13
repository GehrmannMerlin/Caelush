import type { AgentState, AgentStep, RunId, StepId, TimestampMs } from "@caelush/protocol";
import { AgentStepSchema } from "@caelush/protocol";

/**
 * The canonical durable Step lifecycle.
 *
 * ```text
 * one settled model turn = one AgentStep
 * ```
 *
 * The Step is the durable record of a model turn *attempt*, which is why the Run Layer allocates
 * it and the Agent Loop never does: `AgentTurnRef.stepId` is handed to the loop, and the loop has
 * no clock, no identifier factory and no way to create one of these.
 *
 * The transitions are total and closed. A Step that is not RUNNING cannot be settled, a finished
 * timestamp cannot precede a start, and a sequence cannot exceed the safe integer range — each of
 * those is durable-record corruption that must fail at the write rather than be persisted.
 */

/** A Step cannot be created, settled or sequenced as asked. */
export class AgentStepStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStepStateError";
  }
}

export interface CreateRunningAgentStepInput {
  readonly id: StepId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly startedAt: TimestampMs;
}

/** Open the durable Step for one model turn. */
export function createRunningAgentStep(input: CreateRunningAgentStepInput): AgentStep {
  return AgentStepSchema.parse({ ...input, status: "RUNNING" });
}

export interface CompleteAgentStepInput {
  readonly finishedAt: TimestampMs;
  readonly reasoningSummary: string;
}

/** Settle the Step as completed, with the durable summary its attempt produced. */
export function completeAgentStep(step: AgentStep, input: CompleteAgentStepInput): AgentStep {
  assertRunningStep(step);
  assertFinishedAt(step, input.finishedAt);
  return AgentStepSchema.parse({
    ...step,
    status: "COMPLETED",
    finishedAt: input.finishedAt,
    reasoningSummary: input.reasoningSummary,
  });
}

/** Settle the Step as failed. A provider attempt really was made. */
export function failAgentStep(step: AgentStep, finishedAt: TimestampMs): AgentStep {
  assertRunningStep(step);
  assertFinishedAt(step, finishedAt);
  return AgentStepSchema.parse({ ...step, status: "FAILED", finishedAt });
}

/** Settle the Step as cancelled. Cancellation is not a failure. */
export function cancelAgentStep(step: AgentStep, finishedAt: TimestampMs): AgentStep {
  assertRunningStep(step);
  assertFinishedAt(step, finishedAt);
  return AgentStepSchema.parse({ ...step, status: "CANCELLED", finishedAt });
}

/**
 * The sequence of the next Step.
 *
 * `UsageState.steps` counts settled attempts including failed ones, so the next attempt is always
 * one past it. The overflow check is not decoration: a sequence that silently lost precision
 * would order a durable ledger wrongly.
 */
export function nextAgentStepSequence(state: AgentState): number {
  if (state.usage.steps >= Number.MAX_SAFE_INTEGER) {
    throw new AgentStepStateError("agent step sequence exceeded the safe integer range");
  }
  return state.usage.steps + 1;
}

function assertRunningStep(step: AgentStep): void {
  if (step.status !== "RUNNING") {
    throw new AgentStepStateError("only a RUNNING step can be settled");
  }
}

function assertFinishedAt(step: AgentStep, finishedAt: TimestampMs): void {
  if (finishedAt < step.startedAt) {
    throw new AgentStepStateError("step finished timestamp precedes step start");
  }
}
