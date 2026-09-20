import type { AgentError, JsonObject, ObservationId, TimestampMs } from "@caelush/protocol";

import { ToolExecutionInfrastructureError } from "../types/errors.js";
import type { ToolPresentationPort } from "../types/tool-presentation.js";
import type { ToolFailureFeedback } from "../types/tool-feedback.js";
import { failToolInvocation, isTerminalToolInvocation } from "./invocation-lifecycle.js";
import { assertToolObservationInvariant, createToolObservation } from "./observation.js";
import { createToolFailedEvent } from "./durable-events.js";
import type {
  DurableToolEventDraft,
  ToolExecutionCommitResult,
  ToolExecutionSnapshot,
  ToolExecutionStorePort,
} from "./execution-store-port.js";
import { ToolExecutionConflictError, ToolExecutionInvariantError } from "./durable-errors.js";

/**
 * The bounded durable failure settlement.
 *
 * ```text
 * FAILED invocation
 * + safe ToolObservation
 * + tool.failed durable event
 * + budget terminal transition
 *         ↓
 *   one atomic commit
 * ```
 *
 * ## Why this exists as its own seam
 *
 * A Tool call can be refused, blocked or interrupted without any Tool result existing: a policy
 * denial, an approval rejection, a budget block, an uncertain side effect, a broken result contract, a
 * recovered `RUNNING` invocation. Those are *not* `AgentToolResult { isError: true }` values — there is
 * no Tool result at all — and the canonical `ToolResultPipeline` deliberately refuses to invent one.
 *
 * They are, however, all **durable failures of a real invocation**, and they must settle exactly like
 * every other failure: atomically, with one observation and one terminal event. This helper is that
 * single path, so no caller has to grow its own.
 *
 * ## What it must never do
 *
 * ```text
 * disguise an infrastructure failure as safe model feedback
 * catch an arbitrary error and return isError: true
 * ```
 *
 * Every input to it is a *decided* outcome whose safe content is already known. An error this layer
 * cannot classify leaves the invocation RUNNING and propagates, because a model told "the tool failed"
 * would retry a call whose durable truth is unknown.
 */
export interface DurableToolFailureSettlement {
  settleFailure(input: {
    readonly snapshot: ToolExecutionSnapshot;
    readonly code: AgentError["code"];
    readonly phase: AgentError["phase"];
    readonly message: string;
    /** The model-facing content. Already bounded and safe when it arrives here. */
    readonly content: string;
    readonly details?: JsonObject | undefined;
    readonly errorDetails?: JsonObject | undefined;
    readonly now: TimestampMs;
  }): Promise<ToolExecutionCommitResult>;
}

export interface ToolFailureSettlementOptions {
  readonly store: ToolExecutionStorePort;
  readonly clock: { now(): TimestampMs };
  readonly observationIdFactory: { create(): ObservationId };
  readonly eventIdFactory: { create(): import("@caelush/protocol").EventId };
  readonly presentation?: ToolPresentationPort | undefined;
  /** Bounds the model-facing content this helper writes. */
  readonly boundContent: (content: string) => string;
  readonly notifier?: { notifyCommitted(events: readonly unknown[]): void } | undefined;
}

export function createToolFailureSettlement(
  options: ToolFailureSettlementOptions,
): DurableToolFailureSettlement {
  return {
    async settleFailure(input): Promise<ToolExecutionCommitResult> {
      const invocation = input.snapshot.invocation;
      if (isTerminalToolInvocation(invocation)) {
        throw new ToolExecutionInvariantError(
          "A failure settlement requires a non-terminal Tool invocation.",
        );
      }
      const failed = failToolInvocation(
        invocation,
        {
          code: input.code,
          message: input.message,
          retryable: false,
          phase: input.phase,
          ...(input.errorDetails === undefined || Object.keys(input.errorDetails).length === 0
            ? {}
            : { details: input.errorDetails }),
        },
        input.now,
      );
      const details = input.details ?? {};
      const content = options.boundContent(input.content);
      const observation = createToolObservation({
        id: options.observationIdFactory.create(),
        runId: failed.runId,
        stepId: failed.stepId,
        toolInvocationId: failed.id,
        content,
        details,
        isError: true,
        createdAt: input.now,
      });
      assertToolObservationInvariant(observation, failed);
      const event: DurableToolEventDraft = createToolFailedEvent({
        eventId: options.eventIdFactory.create(),
        sessionId: input.snapshot.sessionId,
        timestamp: input.now,
        invocation: failed,
        error: failed.error as AgentError,
        presentation: options.presentation,
        result: { content, details, isError: true },
      });

      let committed: ToolExecutionCommitResult;
      try {
        committed = await options.store.commit({
          sessionId: input.snapshot.sessionId,
          invocation: failed,
          expectedRevision: input.snapshot.revision,
          observation,
          events: [event],
        });
      } catch (error) {
        if (error instanceof ToolExecutionConflictError) throw error;
        if (error instanceof ToolExecutionInvariantError) throw error;
        throw new ToolExecutionInfrastructureError(
          "SETTLEMENT",
          "Tool failure settlement commit failed.",
          { cause: error },
        );
      }
      if (committed.events.length > 0) options.notifier?.notifyCommitted(committed.events);
      if (committed.snapshot.observation === undefined) {
        throw new ToolExecutionInvariantError("Tool failure committed without an observation.");
      }
      return committed;
    },
  };
}

/**
 * Turn an admission denial into the durable failure it settles as.
 *
 * A denial carries `ToolFailureFeedback`, which already states a stable code, bounded safe content and
 * a disposition. The error *code* on the invocation is the feedback's own code when it is one the
 * durable vocabulary knows, which keeps `PERMISSION_DENIED` and `APPROVAL_REJECTED` distinguishable in
 * durable storage exactly as they were before the migration.
 */
export function feedbackToDurableFailure(feedback: ToolFailureFeedback): {
  readonly code: AgentError["code"];
  readonly phase: AgentError["phase"];
  readonly message: string;
} {
  const code = (DURABLE_FAILURE_CODES as readonly string[]).includes(feedback.code)
    ? (feedback.code as AgentError["code"])
    : ("TOOL_EXECUTION_ERROR" as AgentError["code"]);
  return {
    code,
    phase: code === "PERMISSION_DENIED" || code === "APPROVAL_REJECTED" ? "SECURITY" : "TOOL",
    message:
      code === "PERMISSION_DENIED" || code === "APPROVAL_REJECTED"
        ? feedback.content
        : "Tool execution returned an error result.",
  };
}

/**
 * The `AgentError` codes a Tool failure settlement may store verbatim.
 *
 * A feedback code outside this list is a host-specific *category*, not a durable error code: it keeps
 * its meaning inside the safe content the model reads, and the invocation records the generic
 * `TOOL_EXECUTION_ERROR`. Storing an unknown string in the Protocol's `code` field would put a value
 * into durable storage that no schema and no consumer understands.
 */
export const DURABLE_FAILURE_CODES = [
  "PERMISSION_DENIED",
  "APPROVAL_REJECTED",
  "TOOL_EXECUTION_ERROR",
  "TOOL_OUTPUT_ERROR",
  "TOOL_ARGUMENT_ERROR",
  "BUDGET_EXCEEDED",
  "RUNTIME_ERROR",
] as const satisfies readonly AgentError["code"][];
