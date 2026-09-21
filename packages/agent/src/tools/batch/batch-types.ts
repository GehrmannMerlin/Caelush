import type { ApprovalRequest, RunId, SessionId, StepId, ToolInvocationId, ToolObservation } from "@caelush/protocol";

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
 * SKIPPED       a call the batch barrier refused, carrying only safe model feedback
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
 */

/**
 * What happened to one Tool call in a batch.
 *
 * ```ts
 * export type ToolBatchItemOutcome =
 *   | { readonly kind: "OBSERVATION";
 *       readonly call: ToolCallRequest;
 *       readonly invocationId: ToolInvocationId;
 *       readonly finalStatus: "COMPLETED" | "FAILED" | "CANCELLED";
 *       readonly observation: ToolObservation; }
 *   | { readonly kind: "REJECTED"; readonly call: ToolCallRequest; readonly feedback: ToolFailureFeedback; }
 *   | { readonly kind: "SKIPPED"; readonly call: ToolCallRequest; readonly feedback: ToolFailureFeedback; };
 * ```
 *
 * Three arms, and the list is closed. There is deliberately no arm for an infrastructure failure:
 * "the settlement transaction did not commit" is not a fact about a Tool call, so it is **thrown**
 * rather than returned beside real outcomes.
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
  readonly calls: readonly ToolCallRequest[];
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext: ToolSecurityContext;
  readonly signal: AbortSignal;
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
  "REJECTED",
  "SKIPPED",
] as const satisfies readonly ToolBatchItemOutcome["kind"][];

/** Every Tool batch outcome discriminant, in canonical order. */
export const TOOL_BATCH_OUTCOME_KINDS = [
  "COMPLETED",
  "WAITING_APPROVAL",
  "BUDGET_EXCEEDED",
  "CANCELLED",
] as const satisfies readonly ToolBatchOutcome["kind"][];
