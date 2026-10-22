import type {
  ApprovalRequest,
  RunId,
  SessionId,
  StepId,
  ToolInvocationId,
  ToolObservation,
} from "@caelush/protocol";
import type { AIRejectedToolArgumentsIssue } from "@caelush/ai";

import type { AgentBudgetBlock } from "../../loop/ports/model-request-admission.js";
import type { ToolCallRequest } from "../call/tool-call-preparer.js";
import type { ToolExecutionEnvironment } from "../types/execution-environment.js";
import type { ToolFailureFeedback } from "../types/tool-feedback.js";
import type { ToolSecurityContext } from "../admission/security-context.js";

/**
 * The canonical Tool batch vocabulary.
 *
 * ```text
 * ToolBatchRequest         what one batch turn is asked to do
 * ToolBatchItemOutcome     what happened to one call
 * ToolBatchOutcome         how the batch as a whole ended
 * ```
 *
 * ## Why this vocabulary is smaller than the legacy one
 *
 * The legacy `ToolBatchItemResult` mixed four different concerns into one model-facing shape: the
 * model's content, the durable invocation identity, the durable observation pointer and the raw
 * artifact locator. A caller could not tell "this is what the model will be told" from "this is what
 * the ledger recorded", and a pre-invocation rejection had no arm at all — it had to be represented
 * as a fabricated failed invocation.
 *
 * This vocabulary separates them:
 *
 * ```text
 * OBSERVATION   a call that reached the durable ledger, carrying the DURABLE ToolObservation
 * REJECTED      a call the Preparer refused, carrying only safe model feedback
 * SKIPPED       a call never started after an unknown outcome or batch cancellation, carrying only safe model feedback
 * ```
 *
 * None of the three carries a raw `AgentToolResult`, a raw artifact, an exception, a `ToolEffect[]`,
 * an `ApprovalRequest` or a Runtime. Those are implementation facts of the layers that own them.
 *
 * ## The identity of an item is the model's call
 *
 * Every arm carries the `ToolCallRequest` it is about, so a projection can derive both `toolCallId`
 * and `toolName` from the original call rather than by parsing a string. That is what makes "one
 * result per original call, same identity, original order" checkable rather than hoped for.
 *
 * A `SKIPPED` item is not a durable Tool invocation. It uses the stable `TOOL_NOT_STARTED` feedback
 * code and has no invocation identity or observation; cancellation and unknown-outcome barriers remain
 * batch-local scheduling facts.
 */

/**
 * A request the model made whose arguments were never an executable object.
 *
 * ```text
 * identity   the provider's own call id and Tool name
 * issue      the typed reason, never the received text
 * ```
 *
 * It is a batch *call* rather than an item outcome so the batch can emit its one result at the right
 * position: results preserve the assistant's source order, and a rejected request occupies exactly
 * the place the model put it.
 */
export interface ModelRejectedToolCall {
  readonly externalCallId: string;
  readonly toolName: string;
  readonly issue: AIRejectedToolArgumentsIssue;
}

/** One entry of a batch's ordered request list. */
export type ToolBatchCall = ToolCallRequest | ModelRejectedToolCall;

/** The first scheduling barrier discovered in an earlier execution segment. */
export interface ToolBatchSchedulingBarrier {
  readonly kind: "DEPENDENCY_UNPROVEN" | "OUTCOME_UNKNOWN";
  /** Zero-based position in the original assistant batch, across all segments. */
  readonly sourceOrdinal: number;
  /** Stable, bounded reason code only; never model arguments, exception text or paths. */
  readonly code: string;
}

/** Non-durable cursor facts used while one logical assistant batch is dispatched in segments. */
export interface ToolBatchSegmentInput {
  readonly version: "TOOL_BATCH_SEGMENT_V1";
  /** Number of original assistant requests in all earlier segments. */
  readonly sourceOrdinalOffset: number;
  readonly priorBarrier?: ToolBatchSchedulingBarrier | undefined;
}

/** The scheduler facts Core must carry into the next segment of this same logical batch. */
export interface ToolBatchSegmentOutput {
  readonly version: "TOOL_BATCH_SEGMENT_V1";
  /** The next zero-based position in the original assistant batch. */
  readonly nextSourceOrdinal: number;
  readonly barrier: ToolBatchSchedulingBarrier | null;
}

/** True when this entry describes a request that cannot be dispatched. */
export function isModelRejectedCall(call: ToolBatchCall): call is ModelRejectedToolCall {
  return "issue" in call;
}

/**
 * What happened to one Tool call in a batch.
 *
 * ```ts
 * export type ToolBatchItemOutcome =
 *   | { readonly kind: "OBSERVATION";    call: ToolCallRequest; ... }
 *   | { readonly kind: "MODEL_REJECTED"; call: ModelRejectedToolCall; feedback: ToolFailureFeedback }
 *   | { readonly kind: "REJECTED";       call: ToolCallRequest; feedback: ToolFailureFeedback }
 *   | { readonly kind: "SKIPPED";        call: ToolCallRequest; feedback: ToolFailureFeedback };
 * ```
 *
 * Four arms, and the list is closed. `MODEL_REJECTED` exists because the existing `REJECTED` arm
 * carries a well-formed `ToolCallRequest` — a request whose arguments passed shape validation — and
 * a malformed request cannot be expressed as one without fabricating the arguments it lacked.
 *
 * There is deliberately no arm for an infrastructure failure: "the settlement transaction did not
 * commit" is not a fact about a Tool call, so it is **thrown** rather than returned beside real
 * outcomes.
 */
export type ToolBatchItemOutcome =
  | {
      readonly kind: "OBSERVATION";
      readonly call: ToolCallRequest;
      readonly invocationId: ToolInvocationId;
      readonly finalStatus: "COMPLETED" | "FAILED" | "CANCELLED";
      readonly observation: ToolObservation;
    }
  | {
      readonly kind: "MODEL_REJECTED";
      readonly call: ModelRejectedToolCall;
      readonly feedback: ToolFailureFeedback;
    }
  | {
      readonly kind: "REJECTED";
      readonly call: ToolCallRequest;
      readonly feedback: ToolFailureFeedback;
    }
  | {
      readonly kind: "SKIPPED";
      readonly call: ToolCallRequest;
      readonly feedback: ToolFailureFeedback;
    };

/**
 * What one Tool batch turn is asked to do.
 *
 * ```ts
 * export interface ToolBatchRequest {
 *   readonly runId: RunId;
 *   readonly sessionId: SessionId;
 *   readonly sourceStepId: StepId;
 *   readonly calls: readonly ToolCallRequest[];
 *   readonly environment: ToolExecutionEnvironment;
 *   readonly securityContext: ToolSecurityContext;
 *   readonly signal: AbortSignal;
 * }
 * ```
 *
 * Seven fields, and the list is closed. There is deliberately no `mode`, no registry, no store, no
 * Runtime object, no workspace, no budget manager, no `Run` and no `AgentState`: every one of those is
 * an implementation dependency supplied at construction, and naming one here would make every caller
 * of a general Agent host describe it.
 *
 * In particular there is no `mode`. Recovery is not a batch-level decision: the durable coordinator
 * performs a lookup by `(runId, sourceStepId, externalCallId)` on every call, so a fresh batch and a
 * recovered batch are entered through the same `execute()` and each individual call's fresh-or-recover
 * decision is made against durable truth.
 */
export interface ToolBatchRequest {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly sourceStepId: StepId;
  /**
   * The turn's requests in source order, executable and rejected alike.
   *
   * A rejected entry is not dispatched and never creates an invocation; it exists so its one result
   * appears exactly where the model put the request.
   */
  readonly calls: readonly ToolBatchCall[];
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
  readonly signal: AbortSignal;
  /**
   * Present only when Core dispatches one logical assistant batch in multiple execution segments.
   * The ledger remains the recovery cursor; after a restart Core replays earlier segments through
   * the durable coordinator and reconstructs this scheduling fact without repeating side effects.
   */
  readonly segment?: ToolBatchSegmentInput | undefined;
}

/**
 * How one Tool batch turn ended.
 *
 * ```ts
 * export type ToolBatchOutcome =
 *   | { kind: "COMPLETED";         items: readonly ToolBatchItemOutcome[] }
 *   | { kind: "WAITING_APPROVAL";  items; pendingCall: ToolCallRequest; approval: ApprovalRequest }
 *   | { kind: "BUDGET_EXCEEDED";   items; block: AgentBudgetBlock }
 *   | { kind: "CANCELLED";         items: readonly ToolBatchItemOutcome[] };
 * ```
 *
 * Four arms, and the list is closed. There is deliberately no `INFRASTRUCTURE_FAILURE`, no
 * `RESOURCE_WAIT` and no `REPLAN`:
 *
 * ```text
 * infrastructure failure   thrown, never returned
 * RESOURCE_WAIT / REPLAN   Run resource governance, which is not a Tool System concern at all
 * ```
 *
 * `items` always contains only calls that reached a *final* item outcome. A pending approval call is
 * expressed by `pendingCall` and `approval`, never as a fabricated `OBSERVATION`, `REJECTED` or
 * `SKIPPED` item.
 */
export type ToolBatchOutcome =
  | {
      readonly kind: "COMPLETED";
      readonly items: readonly ToolBatchItemOutcome[];
      /** Always emitted by the canonical coordinator; optional for older host implementations. */
      readonly segment?: ToolBatchSegmentOutput | undefined;
    }
  | {
      readonly kind: "WAITING_APPROVAL";
      readonly items: readonly ToolBatchItemOutcome[];
      readonly pendingCall: ToolCallRequest;
      readonly approval: ApprovalRequest;
    }
  | {
      readonly kind: "BUDGET_EXCEEDED";
      readonly items: readonly ToolBatchItemOutcome[];
      readonly block: AgentBudgetBlock;
    }
  | {
      /** A recovered RUNNING invocation could not be proven safe to settle or re-dispatch. */
      readonly kind: "EFFECT_UNCONFIRMED";
      readonly items: readonly ToolBatchItemOutcome[];
      readonly pendingCall: ToolCallRequest;
      readonly invocationId: ToolInvocationId;
      readonly reasonCode: "DOES_NOT_MATCH" | "INCONCLUSIVE" | "UNSUPPORTED" | "UNAVAILABLE";
    }
  | {
      readonly kind: "CANCELLED";
      readonly items: readonly ToolBatchItemOutcome[];
    };

/**
 * The Batch scheduling authority.
 *
 * ```ts
 * export interface ToolBatchCoordinator {
 *   execute(request: ToolBatchRequest): Promise<ToolBatchOutcome>;
 * }
 * ```
 *
 * One method. There is deliberately no `recover()`, no `modelDefinitions()` and no `dispatch()`:
 * those are legacy surface. Recovery is per call and belongs to the durable coordinator, and the
 * model-visible Tool catalog belongs to the registry, not to the object that schedules a batch.
 */
export interface ToolBatchCoordinator {
  execute(request: ToolBatchRequest): Promise<ToolBatchOutcome>;
}

/** Every Tool batch item discriminant, in canonical order. */
export const TOOL_BATCH_ITEM_OUTCOME_KINDS = [
  "OBSERVATION",
  "MODEL_REJECTED",
  "REJECTED",
  "SKIPPED",
] as const satisfies readonly ToolBatchItemOutcome["kind"][];

/** Every Tool batch outcome discriminant, in canonical order. */
export const TOOL_BATCH_OUTCOME_KINDS = [
  "COMPLETED",
  "WAITING_APPROVAL",
  "BUDGET_EXCEEDED",
  "EFFECT_UNCONFIRMED",
  "CANCELLED",
] as const satisfies readonly ToolBatchOutcome["kind"][];
