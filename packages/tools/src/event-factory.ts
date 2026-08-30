import type {
  AgentError,
  ApprovalRequest,
  ApprovalRequestId,
  ApprovalScope,
  ApprovalStatus,
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

export function createApprovalRequestedEvent(input: {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly timestamp: TimestampMs;
  readonly approval: ApprovalRequest;
  readonly stepId: import("@caelush/protocol").StepId;
}): DraftOf<"approval.requested"> {
  return {
    eventId: input.eventId,
    schemaVersion: 1,
    type: "approval.requested",
    runId: input.approval.runId,
    sessionId: input.sessionId,
    stepId: input.stepId,
    timestamp: input.timestamp,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1 },
    payload: { approval: input.approval },
  };
}

export function createApprovalResolvedEvent(input: {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly stepId: import("@caelush/protocol").StepId;
  readonly timestamp: TimestampMs;
  readonly approvalId: ApprovalRequestId;
  readonly runId: import("@caelush/protocol").RunId;
  readonly status: ApprovalStatus;
  readonly grantedScope?: ApprovalScope;
}): DraftOf<"approval.resolved"> {
  return {
    eventId: input.eventId,
    schemaVersion: 1,
    type: "approval.resolved",
    runId: input.runId,
    sessionId: input.sessionId,
    stepId: input.stepId,
    timestamp: input.timestamp,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1 },
    payload: {
      approvalId: input.approvalId,
      status: input.status,
      ...(input.grantedScope === undefined ? {} : { grantedScope: input.grantedScope }),
    },
  };
}
