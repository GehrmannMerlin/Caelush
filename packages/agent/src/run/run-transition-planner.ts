import type { TimestampMs } from "@caelush/protocol";

import type { RunExecutionDirective } from "./directive.js";
import type { RunExecutionEffectResult } from "./effect-result.js";
import type { RunExecutionCommit, RunExecutionSnapshot } from "./ports/run-execution-store.js";

/**
 * The Run transition planner.
 *
 * ```text
 * RunTransitionPlanner = snapshot + directive + effect -> one durable commit
 * ```
 *
 * It is **pure**: it derives what the durable state *should become* from what was just executed,
 * and it writes nothing. The RunController takes the commit and hands it to the store, which is
 * what keeps "who decides the transition" and "who makes it durable" as two different questions.
 *
 * ```text
 * no database, no repository, no SQL, no network
 * no Date.now, no UUID generation, no EventBus notification
 * no Tool execution, no verification execution
 * ```
 *
 * The commit is a description, not a write. It names the next Run, the next AgentState, the Step
 * settlement, the continuation change, the conversation append and the durable events — and it
 * carries no storage row, no client and no handle.
 *
 * `RUN TRANSITION RULES` — the frozen rule table this contract exists for:
 *
 * ```text
 * AGENT TOOL_REQUESTS      → settle Step, append, WAITING_TOOL_RESULTS with the request Step,
 *                            the pending decision and the observation policy the turn used
 * AGENT FINAL_CANDIDATE    → settle Step, append, VERIFYING + AWAITING_VERIFICATION. Never COMPLETED
 * AGENT FAILED after commit→ settle the Step as failed and report retry metadata
 * AGENT FAILED before it   → no Step settlement at all: no attempt was durably attempted
 * AGENT CANCELLED          → cancel the Step; the termination authority settles the Run
 * TOOLS COMPLETED          → WAITING_TOOL_RESULTS holding the accepted results
 * TOOLS WAITING_APPROVAL   → WAITING_APPROVAL holding the waiting boundary
 * TOOLS BUDGET_EXCEEDED    → budget settlement, never a directive
 * TOOLS RESOURCE_WAIT      → WAITING_RESOURCE
 * TOOLS REPLAN             → WAITING_TOOL_RESULTS holding synthetic results
 * COMPLETION ACCEPT        → the Run's result, committed by the RunController
 * COMPLETION REPAIR        → WAITING_VERIFICATION_REPAIR on the same Run
 * COMPLETION REJECT        → FAILED with a verification error
 * COMPLETION ERROR         → no write: the boundary stays recoverable
 * NONE                     → no write at all
 * ```
 *
 * The implementation is completed with the Run state machine and the event materializer; the
 * contract is frozen here so the coordinator, the driver and the RunController can be written
 * against it first.
 */
export interface RunTransitionPlanner {
  plan(input: RunTransitionPlanInput): RunExecutionCommit;
}

/** What one transition is planned from. */
export interface RunTransitionPlanInput {
  /** The durable state the effect was executed against. */
  readonly snapshot: RunExecutionSnapshot;
  /** The directive the coordinator produced, verbatim. */
  readonly directive: RunExecutionDirective;
  /** What executing that directive produced. */
  readonly effect: RunExecutionEffectResult;
  /** The caller's `now`, passed in rather than read, so a plan is reproducible. */
  readonly now: TimestampMs;
}

export type { RunExecutionCommit };
