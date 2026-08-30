import type {
  AgentError,
  AgentRun,
  AgentState,
  AgentStep,
  EventId,
  TimestampMs,
} from "@caelush/protocol";
import type { AgentLoopOutcomeResult } from "./agent-loop-input.js";
import type { DurableEventDraft } from "./run-execution-store.js";
import { summarizeAgentLoopOutcome } from "./agent-summary.js";

export interface RunControllerEventFactory {
  runStarted(run: AgentRun, eventId: EventId, timestamp: TimestampMs): DurableEventDraft;
  statusChanged(
    run: AgentRun,
    from: AgentRun["status"],
    to: AgentRun["status"],
    eventId: EventId,
    timestamp: TimestampMs,
  ): DurableEventDraft;
  llmStarted(
    run: AgentRun,
    step: AgentStep,
    eventId: EventId,
    timestamp: TimestampMs,
  ): DurableEventDraft;
  llmCompleted(
    run: AgentRun,
    state: AgentState,
    step: AgentStep,
    eventId: EventId,
    timestamp: TimestampMs,
  ): DurableEventDraft;
  reasoning(
    run: AgentRun,
    state: AgentState,
    step: AgentStep,
    summary: string,
    eventId: EventId,
    timestamp: TimestampMs,
  ): DurableEventDraft;
  error(
    run: AgentRun,
    error: AgentError,
    stepId: AgentStep["id"] | undefined,
    eventId: EventId,
    timestamp: TimestampMs,
  ): DurableEventDraft;
  failed(
    run: AgentRun,
    error: AgentError,
    eventId: EventId,
    timestamp: TimestampMs,
  ): DurableEventDraft;
  cancelled(run: AgentRun, eventId: EventId, timestamp: TimestampMs): DurableEventDraft;
  maxSteps(
    run: AgentRun,
    state: AgentState,
    outcome: Extract<AgentLoopOutcomeResult["outcome"], { type: "MAX_STEPS_REACHED" }>,
    eventId: EventId,
    timestamp: TimestampMs,
  ): DurableEventDraft;
}

function base(run: AgentRun, eventId: EventId, timestamp: TimestampMs, stepId?: AgentStep["id"]) {
  return {
    eventId,
    schemaVersion: 1 as const,
    runId: run.id,
    sessionId: run.sessionId,
    ...(stepId === undefined ? {} : { stepId }),
    timestamp,
    visibility: "USER_VISIBLE" as const,
    durability: { kind: "DURABLE" as const, version: 1 as const },
  };
}

export function createRunControllerEventFactory(): RunControllerEventFactory {
  return {
    runStarted: (run, eventId, timestamp) => ({
      ...base(run, eventId, timestamp),
      type: "run.started",
      payload: { goal: run.goal },
    }),
    statusChanged: (run, from, to, eventId, timestamp) => ({
      ...base(run, eventId, timestamp),
      type: "status.changed",
      payload: { from, to },
    }),
    llmStarted: (run, step, eventId, timestamp) => ({
      ...base(run, eventId, timestamp, step.id),
      type: "llm.started",
      payload: { model: run.model },
    }),
    llmCompleted: (run, state, step, eventId, timestamp) => ({
      ...base(run, eventId, timestamp, step.id),
      type: "llm.completed",
      payload: { model: run.model, usage: state.usage },
    }),
    reasoning: (run, _state, step, summary, eventId, timestamp) => ({
      ...base(run, eventId, timestamp, step.id),
      type: "reasoning.summary",
      payload: { summary },
    }),
    error: (run, error, stepId, eventId, timestamp) => ({
      ...base(run, eventId, timestamp, stepId),
      type: "error",
      payload: { error },
    }),
    failed: (run, error, eventId, timestamp) => ({
      ...base(run, eventId, timestamp),
      type: "run.failed",
      payload: { error },
    }),
    cancelled: (run, eventId, timestamp) => ({
      ...base(run, eventId, timestamp),
      type: "run.cancelled",
      payload: { reason: "USER_REQUESTED" },
    }),
    maxSteps: (run, _state, outcome, eventId, timestamp) => ({
      ...base(run, eventId, timestamp),
      type: "reasoning.summary",
      payload: { summary: summarizeAgentLoopOutcome(outcome) },
    }),
  };
}
