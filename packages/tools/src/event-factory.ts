import type {
  AgentError,
  EventId,
  ObservationId,
  SessionId,
  TimestampMs,
  ToolInvocation,
} from "@caelush/protocol";
import type { DurableToolEventDraft } from "./dispatcher-types.js";

interface EventInput {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly timestamp: TimestampMs;
  readonly invocation: ToolInvocation;
}

type DraftOf<Type extends DurableToolEventDraft["type"]> = Extract<
  DurableToolEventDraft,
  { readonly type: Type }
>;

function baseEvent(input: EventInput) {
  return {
    eventId: input.eventId,
    schemaVersion: 1 as const,
    runId: input.invocation.runId,
    sessionId: input.sessionId,
    stepId: input.invocation.stepId,
    timestamp: input.timestamp,
    visibility: "USER_VISIBLE" as const,
    durability: { kind: "DURABLE" as const, version: 1 as const },
  };
}

export function createToolRequestedEvent(input: EventInput): DraftOf<"tool.requested"> {
  return {
    ...baseEvent(input),
    type: "tool.requested",
    payload: {
      invocationId: input.invocation.id,
      toolName: input.invocation.toolName,
      ...(input.invocation.externalCallId === undefined
        ? {}
        : { externalCallId: input.invocation.externalCallId }),
      riskLevel: input.invocation.riskLevel,
    },
  };
}

export function createToolStartedEvent(input: EventInput): DraftOf<"tool.started"> {
  return {
    ...baseEvent(input),
    type: "tool.started",
    payload: { invocationId: input.invocation.id },
  };
}

export function createToolCompletedEvent(
  input: EventInput & { readonly observationId: ObservationId },
): DraftOf<"tool.completed"> {
  return {
    ...baseEvent(input),
    type: "tool.completed",
    payload: { invocationId: input.invocation.id, observationId: input.observationId },
  };
}

export function createToolFailedEvent(
  input: EventInput & { readonly error: AgentError },
): DraftOf<"tool.failed"> {
  return {
    ...baseEvent(input),
    type: "tool.failed",
    payload: { invocationId: input.invocation.id, error: input.error },
  };
}
