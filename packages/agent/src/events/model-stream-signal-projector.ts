import type { AIStreamEvent } from "@caelush/ai";
import {
  ModelReasoningSummaryDeltaEventSchema,
  ModelTextDeltaEventSchema,
  ModelToolCallDeltaEventSchema,
  type EventId,
  type RunId,
  type SessionId,
  type StepId,
  type TimestampMs,
  type TransientRunEvent,
} from "@caelush/protocol";
import type { AgentExecutionIdentity } from "../loop/types.js";

export interface EventIdFactory {
  create(): EventId;
}

export interface EventClock {
  now(): TimestampMs;
}

export interface ModelStreamSignalProjectInput {
  readonly identity: AgentExecutionIdentity;
  readonly stepId: StepId;
  readonly event: AIStreamEvent;
}

export interface ModelStreamSignalProjector {
  project(input: ModelStreamSignalProjectInput): TransientRunEvent | null;
  /** Production callers use this for oversized deltas; `project` remains the frozen one-event seam. */
  projectMany?(input: ModelStreamSignalProjectInput): readonly TransientRunEvent[];
}

export interface ModelStreamSignalProjectorDependencies {
  readonly eventIdFactory: EventIdFactory;
  readonly clock: EventClock;
}

/**
 * Projects the three public AI delta events onto the canonical Protocol transient domain.
 *
 * The projector is deliberately turn-scoped: its sequence map is bounded by one model turn,
 * and it never consults provider identifiers or durable Storage for ordering. Lifecycle and
 * usage events remain owned by their durable/AI boundaries and are not duplicated as transient
 * activity signals.
 */
export function createModelStreamSignalProjector(
  dependencies: ModelStreamSignalProjectorDependencies,
): ModelStreamSignalProjector {
  const streamSequences = new Map<string, number>();

  const projectMany = (input: ModelStreamSignalProjectInput): readonly TransientRunEvent[] => {
    const { identity, stepId, event } = input;
    switch (event.type) {
      case "text.delta": {
        const streamKey = modelTextStreamKey(identity.runId, stepId);
        return splitTransientText(event.payload.text).map(
          (text) =>
            ModelTextDeltaEventSchema.parse({
              ...base(identity.runId, identity.sessionId, stepId, dependencies),
              type: "model.text.delta",
              durability: ordered(streamKey, nextSequence(streamSequences, streamKey)),
              payload: { text },
            }) as TransientRunEvent,
        );
      }
      case "reasoning.summary.delta": {
        const streamKey = modelReasoningStreamKey(identity.runId, stepId);
        return splitTransientText(event.payload.text).map(
          (text) =>
            ModelReasoningSummaryDeltaEventSchema.parse({
              ...base(identity.runId, identity.sessionId, stepId, dependencies),
              type: "model.reasoning_summary.delta",
              durability: ordered(streamKey, nextSequence(streamSequences, streamKey)),
              payload: { text },
            }) as TransientRunEvent,
        );
      }
      case "tool_call.delta": {
        const streamKey = modelToolCallStreamKey(identity.runId, stepId, event.payload.toolCallId);
        return splitTransientText(event.payload.delta).map(
          (delta) =>
            ModelToolCallDeltaEventSchema.parse({
              ...base(identity.runId, identity.sessionId, stepId, dependencies),
              type: "model.tool_call.delta",
              durability: ordered(streamKey, nextSequence(streamSequences, streamKey)),
              payload: { toolCallId: event.payload.toolCallId, delta },
            }) as TransientRunEvent,
        );
      }
      default:
        return [];
    }
  };

  return {
    project(input): TransientRunEvent | null {
      return projectMany(input)[0] ?? null;
    },
    projectMany,
  };
}

const MAX_MODEL_TRANSIENT_BYTES = 8 * 1024;

function splitTransientText(value: string): readonly string[] {
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    if (current.length > 0 && byteLength(`${current}${character}`) > MAX_MODEL_TRANSIENT_BYTES) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function base(
  runId: RunId,
  sessionId: SessionId,
  stepId: StepId,
  dependencies: ModelStreamSignalProjectorDependencies,
) {
  return {
    eventId: dependencies.eventIdFactory.create(),
    schemaVersion: 1,
    runId,
    sessionId,
    stepId,
    timestamp: dependencies.clock.now(),
    visibility: "USER_VISIBLE" as const,
  };
}

function ordered(streamKey: string, streamSequence: number) {
  return {
    kind: "EPHEMERAL" as const,
    version: 1 as const,
    deliveryClass: "ORDERED" as const,
    streamKey,
    streamSequence,
  };
}

function nextSequence(sequences: Map<string, number>, streamKey: string): number {
  const next = (sequences.get(streamKey) ?? 0) + 1;
  sequences.set(streamKey, next);
  return next;
}

function modelTextStreamKey(runId: RunId, stepId: StepId): string {
  return `model:text:${runId}:${stepId}`;
}

function modelReasoningStreamKey(runId: RunId, stepId: StepId): string {
  return `model:reasoning-summary:${runId}:${stepId}`;
}

function modelToolCallStreamKey(runId: RunId, stepId: StepId, toolCallId: string): string {
  return `model:tool-call:${runId}:${stepId}:${toolCallId}`;
}
