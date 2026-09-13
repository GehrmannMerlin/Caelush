import type { StepId, TimestampMs } from "@caelush/protocol";

import type {
  AgentFinalCandidateDecision,
  AgentToolCallsDecision,
} from "../loop/decision/decision.js";
import type { AgentTurnInput, ToolObservationPolicySnapshot } from "../loop/types.js";

/**
 * The frozen durable Run execution contract.
 *
 * ```text
 * RunController            = the only lifecycle authority; it commits every transition
 * RunExecutionCoordinator  = a pure decision: what durable execution does next
 * RunExecutionDriver       = execute exactly one typed effect
 * RunTransitionPlanner     = snapshot + directive + effect -> one durable commit
 * ```
 *
 * None of these is a storage type, a Runtime type or a Protocol entity. They are the vocabulary
 * the Run Layer routes with, so "what next" can be decided and tested without a database, a
 * clock, a provider or a Tool.
 */

/* ------------------------------------------------------------------ status */

/**
 * The Run statuses the coordinator routes on.
 *
 * It is the Run Layer's own closed set, restated rather than imported from Protocol, so a
 * coordinator cannot accidentally see a persistence row or a Runtime object.
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

/** Every routable status, in canonical order. */
export const RUN_EXECUTION_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_RESOURCE",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
] as const satisfies readonly RunExecutionStatus[];

/* -------------------------------------------------------------- directives */

/**
 * How durable execution is entered.
 *
 * ```text
 * EXECUTE a fresh action, decided from the Run's current durable state
 * RECOVER an action resumed from a durable continuation after a restart
 * ```
 *
 * Deliberately two values. `START`, `TOOLS` and `REPAIR` are not modes — they are *reasons* and
 * subsystem actions, modelled separately below. Folding them into the mode would merge "which
 * subsystem acts" with "is this fresh or recovered", and every consumer that wanted one would
 * have to understand the other.
 */
export type RunExecutionMode = "EXECUTE" | "RECOVER";

/** Why one model turn is being advanced. */
export type RunExecutionAdvanceReason =
  "INITIAL" | "TOOL_RESULTS" | "RETRY" | "COMPLETION_REPAIR" | "STEERING";

/** Every advance reason, in canonical order. */
export const RUN_EXECUTION_ADVANCE_REASONS = [
  "INITIAL",
  "TOOL_RESULTS",
  "RETRY",
  "COMPLETION_REPAIR",
  "STEERING",
] as const satisfies readonly RunExecutionAdvanceReason[];

/** Which durable boundary a Run is parked on. */
export type RunExecutionSuspendBoundary = "APPROVAL" | "RESOURCE" | "RETRY";

/** Every suspension boundary, in canonical order. */
export const RUN_EXECUTION_SUSPEND_BOUNDARIES = [
  "APPROVAL",
  "RESOURCE",
  "RETRY",
] as const satisfies readonly RunExecutionSuspendBoundary[];

/**
 * The terminal settlements the Run Layer may commit.
 *
 * `FAILED` and `BUDGET_EXCEEDED` are deliberately absent: they are outcomes of an executed
 * effect, not next actions. A Run fails because a turn failed or a batch could not fit — the
 * planner derives both from the effect it is given, and the coordinator was never told either.
 */
export type RunExecutionFinalizeReason = "CANCELLED" | "TIMEOUT" | "MAX_STEPS_REACHED";

/** Every finalization reason, in canonical order. */
export const RUN_EXECUTION_FINALIZE_REASONS = [
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
] as const satisfies readonly RunExecutionFinalizeReason[];

/**
 * One model turn, driven through the frozen `AgentLoop.advance()`.
 *
 * The turn input is carried, not inferred: the driver must not re-read the Run to reconstruct
 * what this Reason is about.
 */
export interface AdvanceAgentDirective {
  readonly kind: "ADVANCE_AGENT";
  readonly mode: RunExecutionMode;
  readonly reason: RunExecutionAdvanceReason;
  readonly input: AgentTurnInput;
}

/** One Tool batch boundary, with everything the batch needs to run. */
export interface ExecuteToolBatchDirective {
  readonly kind: "EXECUTE_TOOL_BATCH";
  readonly mode: RunExecutionMode;
  /** The durable Step that requested these Tools — the resume provenance. */
  readonly sourceStepId: StepId;
  readonly pendingDecision: AgentToolCallsDecision;
  /**
   * The observation policy the requesting turn was prepared under.
   *
   * Absent on a continuation written before the field existed; a projection layer decides the
   * fallback for those. This directive reports what the durable record actually holds.
   */
  readonly observationPolicy?: ToolObservationPolicySnapshot | undefined;
}

/** One completion evaluation of an existing candidate. */
export interface EvaluateCompletionDirective {
  readonly kind: "EVALUATE_COMPLETION";
  readonly mode: RunExecutionMode;
  readonly sourceStepId: StepId;
  readonly candidate: AgentFinalCandidateDecision;
}

/** A durable boundary that only an external resolution can move. */
export interface SuspendDirective {
  readonly kind: "SUSPEND";
  readonly boundary: RunExecutionSuspendBoundary;
  /** When a retry becomes due. Only a `RETRY` suspension carries one. */
  readonly resumeAt?: TimestampMs | undefined;
}

/** A terminal settlement the RunController must commit. */
export interface FinalizeDirective {
  readonly kind: "FINALIZE";
  readonly reason: RunExecutionFinalizeReason;
}

/**
 * The Run is already settled. Nothing to do, nothing to decide.
 *
 * It carries no status and no reason. The caller already holds the snapshot it passed in, so a
 * restated status would be a second copy of a fact it already has, and a reason field would
 * become somewhere to hide routing failures the coordinator should have refused to guess at.
 */
export interface ReturnTerminalDirective {
  readonly kind: "RETURN_TERMINAL";
}

/** Every directive the coordinator may produce. */
export type RunExecutionDirective =
  | AdvanceAgentDirective
  | ExecuteToolBatchDirective
  | EvaluateCompletionDirective
  | SuspendDirective
  | FinalizeDirective
  | ReturnTerminalDirective;

/** Every frozen directive discriminant, in canonical order. Exactly six. */
export const RUN_EXECUTION_DIRECTIVE_KINDS = [
  "ADVANCE_AGENT",
  "EXECUTE_TOOL_BATCH",
  "EVALUATE_COMPLETION",
  "SUSPEND",
  "FINALIZE",
  "RETURN_TERMINAL",
] as const satisfies readonly RunExecutionDirective["kind"][];

/** Whether a status is settled and may never be reopened. */
export function isTerminalExecutionStatus(status: RunExecutionStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "TIMEOUT" ||
    status === "MAX_STEPS_REACHED" ||
    status === "BUDGET_EXCEEDED"
  );
}
