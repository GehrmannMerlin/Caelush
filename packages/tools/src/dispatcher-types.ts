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
import type {
  DurableToolEvent,
  ToolExecutionCommit,
  ToolExecutionCommitResult,
  ToolExecutionStorePort,
} from "./execution-store.js";
import { ToolDispatcherInputError } from "./dispatcher-errors.js";
import { assertToolSecurityContext, type ToolSecurityContext } from "./security-context.js";

import {
  assertToolExecutionEnvironment,
  type ToolExecutionEnvironment,
} from "./execution-environment.js";
import type { ToolEffect } from "./tool-effects.js";

export const DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES = 512;
export const DEFAULT_MAX_INVOCATION_ARGS_BYTES = 256 * 1024;
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

/**
 * The legacy dispatch request.
 *
 * It keeps the field set and the exact validation semantics it always had, because it is still the
 * production entry point a batch uses until the pre-invocation rejection path is switched over. What
 * changed in Phase 4C is *who consumes it*: the legacy shell now translates it into a canonical
 * `DurableToolExecutionRequest` rather than running a lifecycle of its own.
 */
export interface ToolDispatchRequest {
  readonly signal?: AbortSignal;
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
    (Object.keys(request).length !== expectedKeys.length &&
      Object.keys(request).length !== expectedKeys.length + 1) ||
    expectedKeys.some((key) => !Object.hasOwn(request, key)) ||
    !SessionIdSchema.safeParse(request.sessionId).success ||
    !RunIdSchema.safeParse(request.runId).success ||
    !StepIdSchema.safeParse(request.stepId).success ||
    typeof request.externalCallId !== "string" ||
    !ToolNameSchema.safeParse(request.toolName).success ||
    !JsonObjectSchema.safeParse(request.args).success ||
    (Object.hasOwn(request, "signal") && !(request.signal instanceof AbortSignal))
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
  ToolResultOutcome | WaitingApprovalOutcome | UnavailableToolOutcome | BudgetExceededOutcome;

export type {
  DurableToolEvent,
  DurableToolEventDraft,
  ToolExecutionCommit,
  ToolExecutionCommitResult,
  ToolExecutionSnapshot,
  ToolExecutionStorePort,
} from "./execution-store.js";

export interface BudgetExceededOutcome {
  readonly kind: "BUDGET_EXCEEDED";
  readonly invocation?: ToolInvocation;
  readonly dimension: "TOOL_CALLS";
  readonly accounted: number;
  readonly limit: number;
}

export interface ToolResultOutcome {
  readonly kind: "RESULT";
  readonly invocation: ToolInvocation;
  readonly observation: ToolObservation;
}

export interface WaitingApprovalOutcome {
  readonly kind: "WAITING_APPROVAL";
  readonly invocation: ToolInvocation;
  readonly approvalId: import("@caelush/protocol").ApprovalRequestId;
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

export type DurableToolAgentEvent = DurableToolEvent & {
  readonly durability: Extract<
    import("@caelush/protocol").EventDurability,
    { readonly kind: "DURABLE" }
  >;
};

/**
 * One durable Tool execution commit, in the vocabulary this layer still speaks.
 *
 * The canonical declaration is `@caelush/agent`'s. This local view adds the two **legacy effects
 * facets** the pre-4C shell carried - `effects` and `effectTimestamp` - and is the shape a
 * `ToolExecutionStorePort.commit()` implementation still accepts, so the existing Storage
 * compatibility path keeps compiling unchanged.
 *
 * `	ext
 * canonical ToolExecutionCommit     extension?: ToolSettlementExtension   (opaque)
 * legacy    ToolExecutionCommit     effects?, effectTimestamp?            (Coding vocabulary)
 * `
 *
 * The canonical coordinator never builds one of these: it commits `extension` and lets the Storage
 * compatibility boundary decode it back into `ToolEffect[]` inside the same transaction.
 */
export interface LegacyToolExecutionCommit extends ToolExecutionCommit {
  readonly effects?: readonly ToolEffect[] | undefined;
  readonly effectTimestamp?: import("@caelush/protocol").TimestampMs | undefined;
}

/**
 * The legacy durable Tool store contract.
 *
 * It is the **canonical** contract - the same three methods, the same snapshot, the same result -
 * widened only in the argument type of `commit`, which still accepts the two legacy effects facets.
 * The widening is deliberate and temporary: a pre-4C implementation (and the test doubles built
 * against it) accept those facets today, and the production Storage path decodes the canonical
 * `extension` into exactly those effects inside the same SQLite transaction.
 *
 * A new implementation should implement `@caelush/agent`'s `ToolExecutionStorePort` instead.
 */
export interface LegacyToolExecutionStorePort extends Omit<ToolExecutionStorePort, "commit"> {
  commit(command: LegacyToolExecutionCommit): Promise<ToolExecutionCommitResult>;
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

export interface ToolApprovalRequestIdFactory {
  create(): import("@caelush/protocol").ApprovalRequestId;
}

export interface ToolEventIdFactory {
  create(): import("@caelush/protocol").EventId;
}

export type ToolLifecycleError = AgentError;

export type ToolDefinitionMetadata = {
  readonly name: ToolDefinition["name"];
  readonly riskLevel: ToolDefinition["riskLevel"];
  readonly requiredCapabilities: readonly ToolDefinition["requiredCapabilities"][number][];
  readonly runtimeRequirements: ToolDefinition["runtimeRequirements"];
};

export type ToolIdentity = Pick<
  ToolDispatchRequest,
  "sessionId" | "runId" | "stepId" | "externalCallId" | "toolName"
>;
