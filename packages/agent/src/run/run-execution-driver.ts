import type { AgentDecision } from "../loop/decision/decision.js";
import type { AgentLoopFailureStage, AIUserInputMessage } from "../loop/types.js";
import type {
  RunExecutionBudgetBlock,
  RunExecutionDirective,
  RunExecutionError,
  RunExecutionMode,
} from "./directive.js";
import type { RunExecutionFacts } from "./snapshot.js";
import type { RunExecutionEffectResult, RunExecutionToolTurnResult } from "./effect-result.js";

/**
 * The durable Run execution driver.
 *
 * ```text
 * RunExecutionDriver = execute exactly one typed effect
 * ```
 *
 * The driver performs the work a directive names and reports a typed result. It is deliberately
 * narrow in three directions:
 *
 * ```text
 * it writes no Run status        only the RunController commits a lifecycle transition
 * it owns no retry policy        it reports retryable metadata; the Run Layer decides
 * it never loops a Run           it executes one effect per call and returns
 * ```
 *
 * What each directive means for the driver:
 *
 * ```text
 * ADVANCE_AGENT       one model turn through the frozen AgentLoop.advance()
 * EXECUTE_TOOL_BATCH  one Tool boundary; the Tool Layer owns execution, not this port
 * EVALUATE_COMPLETION one Completion Gate evaluation of an existing candidate
 * SUSPEND / FINALIZE / RETURN_TERMINAL
 *                     nothing to execute: the RunController owns what happens next
 * ```
 */
export interface RunExecutionDriver {
  execute(input: RunExecutionDriverInput): Promise<RunExecutionEffectResult>;
}

/** The context one effect is executed in. */
export interface RunExecutionDriverInput {
  /** The directive the coordinator produced, verbatim. */
  readonly directive: RunExecutionDirective;
  readonly facts: RunExecutionFacts;
  /**
   * The caller's cancellation signal.
   *
   * The driver never creates an abort scope, never owns a timeout and never reads a deadline: it
   * forwards this signal, and Run cancellation stays a Run Layer authority.
   */
  readonly signal: AbortSignal;
}

/* --------------------------------------------------------- step lifecycle */

/**
 * The durable Step lifecycle seam.
 *
 * Phase 3C extracts Step creation and settlement out of the AgentLoop and behind this port, so
 * the port's owner can be the Run Layer. One model turn is one durable AgentStep.
 *
 * Every method is idempotent for the same turn: a Run that restarts must be able to settle the
 * same Step again without creating a second one.
 */
export interface AgentStepLifecyclePort {
  /** Begin the durable Step for this turn. It must commit before any provider I/O. */
  begin(input: AgentStepBeginInput): Promise<AgentStepHandle>;
  /** Settle the Step as completed. */
  complete(input: AgentStepHandle): Promise<void>;
  /** Settle the Step as failed. A provider attempt really was made. */
  fail(input: AgentStepHandle): Promise<void>;
  /** Settle the Step as cancelled. Cancellation is not a failure. */
  cancel(input: AgentStepHandle): Promise<void>;
}

/** The identity a durable Step needs. */
export interface AgentStepBeginInput {
  readonly runId: string;
  readonly mode: RunExecutionMode;
  /** The caller's cancellation signal, so the commit itself is abortable. */
  readonly signal: AbortSignal;
}

/** One durable Step attempt, named by the port rather than by the loop. */
export interface AgentStepHandle {
  readonly stepId: string;
  readonly sequence: number;
}

/* ---------------------------------------------------------------- inputs */

/** One agent turn's frozen input, as the driver hands it to the loop. */
export interface RunExecutionAgentTurnInput {
  readonly decision?: AgentDecision;
  readonly messages?: readonly AIUserInputMessage[];
}

/** What a Tool batch boundary is asked to do. */
export interface RunExecutionToolBatchInput {
  readonly mode: "EXECUTE" | "RECOVER";
  readonly signal: AbortSignal;
  readonly toolRequests: readonly {
    readonly externalCallId: string;
    readonly toolName: string;
  }[];
}

/** The Tool boundary port. Phase 3D owns its real wiring. */
export interface RunExecutionToolBoundaryPort {
  execute(input: RunExecutionToolBatchInput): Promise<RunExecutionToolTurnResult>;
}

/* ------------------------------------------------------------- re-exports */

export type {
  RunExecutionBudgetBlock,
  RunExecutionEffectResult,
  RunExecutionError,
  RunExecutionMode,
  RunExecutionToolTurnResult,
};
export type { AgentLoopFailureStage };
