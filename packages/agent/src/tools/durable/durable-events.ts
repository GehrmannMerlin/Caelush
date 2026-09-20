import type {
  AgentError,
  ApprovalRequest,
  EventId,
  ObservationId,
  SessionId,
  StepId,
  TimestampMs,
  ToolInvocation,
} from "@caelush/protocol";

import type { DurableToolEventDraft } from "./execution-store-port.js";
import type {
  ToolInvocationPresentation,
  ToolPresentationPort,
} from "../types/tool-presentation.js";
import type { ToolResultPresentation } from "../types/tool-presentation.js";
import type { AgentToolResult } from "../types/tool-result.js";

/**
 * The durable Tool event factory.
 *
 * ```text
 * tool.requested        a call became durable, before anything was decided about it
 * tool.started          the invocation reached RUNNING, after admission and before execution
 * tool.completed        the invocation reached COMPLETED, naming its observation
 * tool.failed           the invocation reached FAILED, carrying its safe error
 * tool.output           an optional bounded output chunk for a live viewer
 * approval.requested    a durable ApprovalRequest was created with its waiting invocation
 * ```
 *
 * Phase 4C moved these factories here from `packages/tools/src/event-factory.ts`, because the layer
 * that performs a durable commit is the layer that must state what it is committing. The legacy module
 * is now a re-export facade.
 *
 * ## Events are built from committed values only
 *
 * Every factory takes the invocation **as it will be persisted**, never a candidate under
 * construction. That is what makes the durable event stream a record of what happened rather than of
 * what was attempted: an event is only ever materialized from a value that a store has accepted.
 *
 * ## Presentation is optional, safe and never authoritative
 *
 * A host may inject a `ToolPresentationPort` so an event carries a human title and summary. The
 * projection is guarded: if it throws, the event is still emitted, without presentation. A presenter
 * that cannot describe a Tool must not be able to stop one from being recorded, and a presentation
 * string never participates in identity, approval keys or lifecycle decisions.
 */
interface EventInput {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly timestamp: TimestampMs;
  readonly invocation: ToolInvocation;
  readonly presentation?: ToolPresentationPort | undefined;
  readonly result?: AgentToolResult | undefined;
}

/** The largest presentation string an event may carry. */
export const MAX_TOOL_EVENT_PRESENTATION_BYTES = 8 * 1024;

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
    Buffer.byteLength(value, "utf8") <= MAX_TOOL_EVENT_PRESENTATION_BYTES
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
  readonly stepId: StepId;
  readonly timestamp: TimestampMs;
  readonly approval: ApprovalRequest;
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
  readonly stepId: StepId;
  readonly timestamp: TimestampMs;
  readonly approvalId: import("@caelush/protocol").ApprovalRequestId;
  readonly runId: import("@caelush/protocol").RunId;
  readonly status: import("@caelush/protocol").ApprovalStatus;
  readonly grantedScope?: import("@caelush/protocol").ApprovalScope | undefined;
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
