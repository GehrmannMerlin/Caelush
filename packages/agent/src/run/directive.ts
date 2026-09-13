/**
 * The frozen durable Run execution contract.
 *
 * ```text
 * RunController      = only lifecycle authority (commits every transition)
 * RunExecutionCoordinator = pure decision: what durable execution does next
 * RunExecutionDriver      = executes exactly one typed effect
 * RunTransitionPlanner    = effect -> commit draft, pure
 * ```
 *
 * None of these types is a storage type, a Runtime type or a protocol entity. They are the
 * vocabulary the Run Layer routes with, so the decision "what next" can be made and tested
 * without a database, a clock, a provider or a Tool.
 */

/* ------------------------------------------------------------------ status */

/**
 * The Run statuses the coordinator routes on.
 *
 * This is the Run Layer's own status vocabulary, restated here as a closed set rather than
 * imported from the Protocol package: `@caelush/agent` may depend on `@caelush/ai` and
 * `@caelush/protocol`, but a coordinator must not be able to see a protocol entity, a
 * persistence row or a Runtime object.
 */
export type RunExecutionStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "WAITING_RESOURCE"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMEOUT"
  | "MAX_STEPS_REACHED"
  | "BUDGET_EXCEEDED";

/**
 * The durable continuation discriminants the coordinator routes on.
 *
 * `WAITING_TOOL_RESULTS`, `WAITING_RETRY` and `WAITING_VERIFICATION_REPAIR` are continuations
 * of a `RUNNING` Run, never statuses of their own. That distinction is what keeps a restart
 * able to tell "the Run is waiting" from "the Run is over".
 */
export type RunExecutionContinuationKind =
  | "WAITING_TOOL_RESULTS"
  | "WAITING_RETRY"
  | "WAITING_VERIFICATION_REPAIR"
  | "WAITING_RESOURCE"
  | "AWAITING_VERIFICATION";

/** Why the execution loop is allowed to do nothing but wait. */
export type RunExecutionWaitReason = "APPROVAL" | "RESOURCE" | "RETRY_NOT_DUE" | "UNKNOWN";

/* -------------------------------------------------------------- directives */

/** Which model of execution the next agent turn is. */
export type RunExecutionMode = "START" | "TOOLS" | "REPAIR" | "RECOVER";

/** One durable model turn, driven through the frozen `AgentLoop.advance()`. */
export interface AdvanceAgentDirective {
  readonly kind: "ADVANCE_AGENT";
  readonly mode: RunExecutionMode;
}

/** One Tool batch boundary. */
export interface ExecuteToolBatchDirective {
  readonly kind: "EXECUTE_TOOL_BATCH";
  /** `EXECUTE` runs a fresh batch; `RECOVER` settles one that was already durable. */
  readonly mode: "EXECUTE" | "RECOVER";
}

/**
 * A final candidate that may be verified.
 *
 * `FINALIZE` never completes a Run on its own: the Completion Gate decides, and only the
 * RunController commits `COMPLETED`.
 */
export interface EvaluateCompletionDirective {
  readonly kind: "EVALUATE_COMPLETION";
  /** A Run that restarted inside `VERIFYING` recovers; it never regenerates a candidate. */
  readonly mode: "EVALUATE" | "RECOVER";
}

/** A durable boundary reached. The Run stays as it is until something external resolves it. */
export interface SuspendDirective {
  readonly kind: "SUSPEND";
  readonly reason: RunExecutionWaitReason;
}

/** A terminal outcome the RunController must commit. */
export type RunExecutionFinalization =
  | { readonly reason: "CANCELLED" }
  | { readonly reason: "TIMEOUT" }
  | { readonly reason: "FAILED"; readonly error: RunExecutionError }
  | { readonly reason: "BUDGET_EXCEEDED"; readonly block: RunExecutionBudgetBlock }
  | {
      readonly reason: "MAX_STEPS_REACHED";
      readonly stepsCompleted: number;
      readonly maxSteps: number;
    };

/** Commit a terminal settlement. */
export interface FinalizeDirective {
  readonly kind: "FINALIZE";
  readonly finalization: RunExecutionFinalization;
}

/**
 * The Run is already settled, or it cannot be routed.
 *
 * `RETURN_TERMINAL` is the honest answer for every state the coordinator will not guess at: an
 * already-terminal Run, an unexpected abort, a boundary the Run Layer cannot satisfy. It
 * reports the current status plus an optional reason, and the RunController decides whether
 * that is a normal result or an invariant violation — the coordinator never invents a
 * transition to cover a state it does not understand.
 */
export interface ReturnTerminalDirective {
  readonly kind: "RETURN_TERMINAL";
  readonly status: RunExecutionStatus;
  readonly reason?: RunExecutionTerminalReason;
}

export type RunExecutionTerminalReason =
  | "ALREADY_TERMINAL"
  | "UNEXPECTED_ABORT"
  | "MISSING_AGENT_STATE"
  | "MISSING_CONTINUATION"
  | "TOOL_COORDINATOR_UNAVAILABLE"
  | "UNAVAILABLE_VERIFICATION"
  | "UNAVAILABLE_BOUNDARY";

/** Every directive the coordinator may produce, in canonical order. */
export type RunExecutionDirective =
  | AdvanceAgentDirective
  | ExecuteToolBatchDirective
  | EvaluateCompletionDirective
  | SuspendDirective
  | FinalizeDirective
  | ReturnTerminalDirective;

/** Every frozen directive discriminant. */
export const RUN_EXECUTION_DIRECTIVE_KINDS = [
  "ADVANCE_AGENT",
  "EXECUTE_TOOL_BATCH",
  "EVALUATE_COMPLETION",
  "SUSPEND",
  "FINALIZE",
  "RETURN_TERMINAL",
] as const satisfies readonly RunExecutionDirective["kind"][];

/* ------------------------------------------------------------------ errors */

/** The failure codes a finalization may carry. */
export type RunExecutionErrorCode =
  | "MODEL_ERROR"
  | "TOOL_OUTPUT_ERROR"
  | "RUNTIME_ERROR"
  | "PERMISSION_DENIED"
  | "APPROVAL_REJECTED"
  | "VERIFICATION_FAILED"
  | "CONTEXT_EXHAUSTED"
  | "BUDGET_ENFORCEMENT_UNAVAILABLE"
  | "INTERNAL_ERROR";

/** A sanitized Run failure. It never carries a cause, a stack or a provider payload. */
export interface RunExecutionError {
  readonly code: RunExecutionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * A durable budget refusal.
 *
 * `EXCEEDED` names the dimension that ran out so the Run Layer settles the same accounting it
 * already keeps. `UNAVAILABLE` is the fail-closed case: enforcement could not be established at
 * all, which is not the same outcome as spending a budget.
 */
export interface RunExecutionBudgetBlock {
  readonly kind: "EXCEEDED" | "UNAVAILABLE";
  readonly dimension?: "TOOL_CALLS" | "TOKENS" | "COST";
  readonly accounted?: number;
  readonly limit?: number;
  readonly limitMicros?: number;
  readonly accountedMicros?: number;
  readonly reason?: "PRICING" | "TOKEN_ESTIMATE";
}
