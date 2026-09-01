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
import type {
  ToolInvocationPresentation,
  ToolPresentationPort,
  ToolResultPresentation,
} from "./presentation.js";
import type { ToolExecutionResult } from "./execution-result.js";

interface EventInput {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly timestamp: TimestampMs;
  readonly invocation: ToolInvocation;
  readonly presentation?: ToolPresentationPort | undefined;
  readonly result?: ToolExecutionResult | undefined;
}

const MAX_PRESENTATION_TEXT_BYTES = 8 * 1024;

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

function safeInvocationPresentation(input: EventInput): ToolInvocationPresentation | undefined {
  if (input.presentation === undefined) return undefined;
  try {
    return input.presentation.presentInvocation({ invocation: input.invocation });
  } catch {
    return undefined;
  }
}

function safeResultPresentation(input: EventInput): ToolResultPresentation | undefined {
  if (input.presentation === undefined) return undefined;
  try {
    return input.presentation.presentResult({
      invocation: input.invocation,
      ...(input.result === undefined ? {} : { result: input.result }),
    });
  } catch {
    return undefined;
  }
}

function presentationFields(
  presentation: ToolInvocationPresentation | ToolResultPresentation | undefined,
) {
  if (presentation === undefined) return {};
  return {
    ...(isSafePresentationText(presentation.title) ? { title: presentation.title } : {}),
    ...(isSafePresentationText(presentation.summary) ? { summary: presentation.summary } : {}),
  };
}

function isSafePresentationText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PRESENTATION_TEXT_BYTES
  );
}

export function createToolRequestedEvent(input: EventInput): DraftOf<"tool.requested"> {
  const presentation = safeInvocationPresentation(input);
  return {
    ...baseEvent(input),
    ...presentationFields(presentation),
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
  const presentation = safeInvocationPresentation(input);
  return {
    ...baseEvent(input),
    ...presentationFields(presentation),
    type: "tool.started",
    payload: { invocationId: input.invocation.id },
  };
}

export function createToolCompletedEvent(
  input: EventInput & { readonly observationId: ObservationId },
): DraftOf<"tool.completed"> {
  const presentation = safeResultPresentation(input);
  return {
    ...baseEvent(input),
    ...presentationFields(presentation),
    type: "tool.completed",
    payload: { invocationId: input.invocation.id, observationId: input.observationId },
  };
}

export function createToolFailedEvent(
  input: EventInput & { readonly error: AgentError },
): DraftOf<"tool.failed"> {
  const presentation = safeResultPresentation(input);
  return {
    ...baseEvent(input),
    ...presentationFields(presentation),
    type: "tool.failed",
    payload: { invocationId: input.invocation.id, error: input.error },
  };
}

export function createToolOutputEvent(input: EventInput): DraftOf<"tool.output"> | undefined {
  const presentation = safeResultPresentation(input);
  if (
    presentation?.output === undefined ||
    (presentation.output.stream !== "stdout" && presentation.output.stream !== "stderr") ||
    !isSafePresentationText(presentation.output.chunk)
  ) {
    return undefined;
  }
  return {
    ...baseEvent(input),
    ...presentationFields(presentation),
    type: "tool.output",
    payload: {
      invocationId: input.invocation.id,
      stream: presentation.output.stream,
      chunk: presentation.output.chunk,
    },
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
