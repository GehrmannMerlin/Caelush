import type { AgentState, AgentStep, RunId, StepId, TimestampMs } from "@caelush/protocol";
import { AgentStepSchema } from "@caelush/protocol";
import { AgentKernelStateError } from "./agent-errors.js";

export interface CreateRunningAgentStepInput {
  readonly id: StepId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly startedAt: TimestampMs;
}

export function createRunningAgentStep(input: CreateRunningAgentStepInput): AgentStep {
  return AgentStepSchema.parse({ ...input, status: "RUNNING" });
}

export interface CompleteAgentStepInput {
  readonly finishedAt: TimestampMs;
  readonly reasoningSummary: string;
}

export function completeAgentStep(
  step: AgentStep,
  input: CompleteAgentStepInput,
): AgentStep {
  assertRunningStep(step);
  assertFinishedAt(step, input.finishedAt);
  return AgentStepSchema.parse({
    ...step,
    status: "COMPLETED",
    finishedAt: input.finishedAt,
    reasoningSummary: input.reasoningSummary,
  });
}

export function failAgentStep(step: AgentStep, finishedAt: TimestampMs): AgentStep {
  assertRunningStep(step);
  assertFinishedAt(step, finishedAt);
  return AgentStepSchema.parse({ ...step, status: "FAILED", finishedAt });
}

export function cancelAgentStep(step: AgentStep, finishedAt: TimestampMs): AgentStep {
  assertRunningStep(step);
  assertFinishedAt(step, finishedAt);
  return AgentStepSchema.parse({ ...step, status: "CANCELLED", finishedAt });
}

export function nextAgentStepSequence(state: AgentState): number {
  if (state.usage.steps >= Number.MAX_SAFE_INTEGER) {
    throw new AgentKernelStateError("agent step sequence exceeded the safe integer range");
  }
  return state.usage.steps + 1;
}

function assertRunningStep(step: AgentStep): void {
  if (step.status !== "RUNNING") {
    throw new AgentKernelStateError("only a RUNNING step can be settled");
  }
}

function assertFinishedAt(step: AgentStep, finishedAt: TimestampMs): void {
  if (finishedAt < step.startedAt) {
    throw new AgentKernelStateError("step finished timestamp precedes step start");
  }
}
