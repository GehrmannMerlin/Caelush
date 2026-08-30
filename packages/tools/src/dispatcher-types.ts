import {
  JsonObjectSchema,
  RunIdSchema,
  SessionIdSchema,
  StepIdSchema,
  ToolNameSchema,
  type AgentError,
  type JsonObject,
  type RunId,
  type SessionId,
  type StepId,
  type ToolDefinition,
  type ToolInvocation,
  type ToolInvocationId,
  type ToolName,
  type ToolObservation,
} from "@caelush/protocol";
import { ToolDispatcherInputError } from "./dispatcher-errors.js";
import { assertToolSecurityContext, type ToolSecurityContext } from "./security-context.js";
import type { AgentEvent, EventDurability } from "@caelush/protocol";
import {
  assertToolExecutionEnvironment,
  type ToolExecutionEnvironment,
} from "./execution-environment.js";
import type { ToolEffect } from "./tool-effects.js";

export const DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES = 512;
export const DEFAULT_MAX_INVOCATION_ARGS_BYTES = 256 * 1024;

export interface ToolDispatchRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly externalCallId: string;
  readonly toolName: ToolName;
  readonly args: JsonObject;
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
}

export function assertToolDispatchRequest(
  value: unknown,
  options: { readonly maxExternalCallIdBytes?: number } = {},
): asserts value is ToolDispatchRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolDispatcherInputError("Tool dispatch request is invalid.");
  }
  const request = value as Record<string, unknown>;
  const expectedKeys = [
    "sessionId",
    "runId",
    "stepId",
    "externalCallId",
    "toolName",
    "args",
    "environment",
    "securityContext",
  ];
  if (
    Object.keys(request).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(request, key)) ||
    !SessionIdSchema.safeParse(request.sessionId).success ||
    !RunIdSchema.safeParse(request.runId).success ||
    !StepIdSchema.safeParse(request.stepId).success ||
    typeof request.externalCallId !== "string" ||
    !ToolNameSchema.safeParse(request.toolName).success ||
    !JsonObjectSchema.safeParse(request.args).success
  ) {
    throw new ToolDispatcherInputError("Tool dispatch request is invalid.");
  }
  assertToolExecutionEnvironment(request.environment);
  assertToolSecurityContext(request.securityContext);
  if (request.externalCallId.length === 0) {
    throw new ToolDispatcherInputError("Tool externalCallId must be non-empty.");
  }
  const maxBytes = options.maxExternalCallIdBytes ?? DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES;
  if (Buffer.byteLength(request.externalCallId, "utf8") > maxBytes) {
    throw new ToolDispatcherInputError("Tool externalCallId exceeds its byte limit.");
  }
}

export type ToolDispatcherOutcome =
  ToolResultOutcome | WaitingApprovalOutcome | UnavailableToolOutcome;

export interface ToolResultOutcome {
  readonly kind: "RESULT";
  readonly invocation: ToolInvocation;
  readonly observation: ToolObservation;
}

export interface WaitingApprovalOutcome {
  readonly kind: "WAITING_APPROVAL";
  readonly invocation: ToolInvocation;
}

export interface UnavailableToolOutcome {
  readonly kind: "UNAVAILABLE_TOOL";
  readonly toolName: string;
  readonly content: string;
  readonly isError: true;
}

export interface ToolErrorResultOutcome extends ToolResultOutcome {
  readonly observation: ToolObservation & { readonly isError: true };
}

export type DurableToolEvent = AgentEvent;

type DurableEvent = Extract<EventDurability, { readonly kind: "DURABLE" }>;

type WithDurableDraft<TEvent> = TEvent extends { readonly type: string }
  ? Omit<TEvent, "durability"> & { readonly durability: Omit<DurableEvent, "sequence"> }
  : never;

export type DurableToolEventDraft = WithDurableDraft<DurableToolEvent>;
export type DurableToolAgentEvent = WithDurableDraft<DurableToolEvent> & {
  readonly durability: DurableEvent;
};

export interface ToolExecutionSnapshot {
  readonly sessionId: SessionId;
  readonly invocation: ToolInvocation;
  readonly revision: number;
  readonly observation?: ToolObservation;
}

export interface ToolExecutionCommit {
  readonly sessionId: SessionId;
  readonly invocation: ToolInvocation;
  readonly expectedRevision: number | null;
  readonly observation?: ToolObservation;
  readonly events: readonly DurableToolEventDraft[];
  readonly effects?: readonly ToolEffect[];
  readonly effectTimestamp?: import("@caelush/protocol").TimestampMs;
}

export interface ToolExecutionCommitResult {
  readonly snapshot: ToolExecutionSnapshot;
  readonly events: readonly DurableToolAgentEvent[];
}

export interface ToolClock {
  now(): import("@caelush/protocol").TimestampMs;
}

export interface ToolInvocationIdFactory {
  create(): ToolInvocationId;
}

export interface ToolObservationIdFactory {
  create(): import("@caelush/protocol").ObservationId;
}

export interface ToolEventIdFactory {
  create(): import("@caelush/protocol").EventId;
}

export type ToolLifecycleError = AgentError;

export type ToolDefinitionMetadata = Pick<
  ToolDefinition,
  "name" | "riskLevel" | "requiredCapabilities" | "runtimeRequirements"
>;

export type ToolIdentity = Pick<
  ToolDispatchRequest,
  "sessionId" | "runId" | "stepId" | "externalCallId" | "toolName"
>;
