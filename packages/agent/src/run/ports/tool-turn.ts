import type { ApprovalRequestId, StepId, ToolInvocationId, ToolName } from "@caelush/protocol";

import type { AgentBudgetBlock } from "../../loop/ports/model-request-admission.js";
import type { AgentToolCallsDecision } from "../../loop/decision/decision.js";
import type { ToolObservationPolicySnapshot } from "../../loop/types.js";
import type { RunExecutionMode } from "../directive.js";

/**
 * The Tool turn contract.
 *
 * ```text
 * ToolTurnCoordinator = execute exactly one Tool batch turn
 * ```
 *
 * Phase 3C froze this contract and Phase 3D built its production implementation: a run-scoped
 * adapter in Core that captures the host facts this general contract deliberately does not carry
 * — workspace, Runtime, security context, resource policy — and drives the existing durable Tool
 * System behind them.
 *
 * What the contract owns is the vocabulary a *general* Run Layer needs:
 *
 * ```text
 * COMPLETED        the batch settled with a complete, ordered result set
 * WAITING_APPROVAL the batch stopped at a Tool that needs approval
 * BUDGET_EXCEEDED  the batch could not fit; the results already produced are reported
 * RESOURCE_WAIT    execution paused on a resource decision
 * REPLAN           the batch produced synthetic results that ask the model to replan
 * ```
 *
 * Every completed result is model-facing data only. Invocation identifiers, observation records,
 * structured details, raw arguments and internal causes belong to the Tool Layer: the Run Layer
 * persists the model's view, not the execution's internals.
 */

/** One model-facing Tool result. */
export interface AgentToolResult {
  readonly externalCallId: string;
  readonly toolName: ToolName;
  /** The model-facing text. */
  readonly content: string;
  readonly isError: boolean;
}

/** The Tool invocation an approval boundary is waiting on. */
export interface WaitingApprovalBoundary {
  readonly invocationId: ToolInvocationId;
  readonly approvalId?: ApprovalRequestId | undefined;
  readonly externalCallId: string;
  readonly toolName: ToolName;
}

/** What one Tool batch turn produced. */
export type ToolTurnResult =
  | {
      readonly kind: "COMPLETED";
      readonly results: readonly AgentToolResult[];
    }
  | {
      readonly kind: "WAITING_APPROVAL";
      readonly completedResults: readonly AgentToolResult[];
      readonly waiting: WaitingApprovalBoundary;
    }
  | {
      readonly kind: "BUDGET_EXCEEDED";
      readonly completedResults: readonly AgentToolResult[];
      readonly block: AgentBudgetBlock;
    }
  | {
      readonly kind: "RESOURCE_WAIT";
      readonly reason: "NO_PROGRESS";
    }
  | {
      readonly kind: "REPLAN";
      readonly syntheticResults: readonly AgentToolResult[];
    };

/** Every Tool turn discriminant, in canonical order. */
export const TOOL_TURN_RESULT_KINDS = [
  "COMPLETED",
  "WAITING_APPROVAL",
  "BUDGET_EXCEEDED",
  "RESOURCE_WAIT",
  "REPLAN",
] as const satisfies readonly ToolTurnResult["kind"][];

/**
 * What one Tool batch turn is asked to do.
 *
 * Self-contained on purpose: the coordinator already decided *which* batch, so the coordinator is
 * handed the Step that requested it, the decision that named it and the observation policy that
 * was in force. A coordinator that had to re-read the Run to discover its own arguments would be
 * a second routing authority.
 */
export interface ToolTurnRequest {
  /** `EXECUTE` runs a fresh batch; `RECOVER` settles one that was already durable. */
  readonly mode: RunExecutionMode;
  readonly sourceStepId: StepId;
  readonly pendingDecision: AgentToolCallsDecision;
  readonly observationPolicy?: ToolObservationPolicySnapshot | undefined;
  /** The caller's cancellation signal, forwarded unchanged. */
  readonly signal: AbortSignal;
}

/**
 * Execute exactly one Tool batch turn.
 *
 * Its production implementation is the run-scoped Core adapter, which reinforces
 * `ToolTurnRequest.mode` with the caller's own entry mode: whether a batch may already have run is
 * a host fact, and a durable `RUNNING` invocation must be recovered rather than re-dispatched. That
 * reinforcement stays Core-private — it does not widen this contract.
 */
export interface ToolTurnCoordinator {
  execute(request: ToolTurnRequest): Promise<ToolTurnResult>;
}
