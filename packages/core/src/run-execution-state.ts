import {
  AgentRunSchema,
  VerifiedRunFinalResultSchema,
  type AgentRun,
  type JsonValue,
  type RunStatus,
} from "@caelush/protocol";
import {
  assertRunExecutionInvariant as assertGeneralRunExecutionInvariant,
  completeAgentRunWithFinalResult,
  isTerminalRunStatus,
} from "@caelush/agent";
import type { RunExecutionSnapshotView } from "./run-execution-store.js";
import { RunExecutionInvariantError } from "./run-execution-store.js";

/**
 * The Run Layer's durable execution state transitions.
 *
 * ```text
 * general       @caelush/agent   a Run and its AgentState move together, for any Run
 * verification  this file        a VERIFYING Run is bound to the plan it is verifying
 * ```
 *
 * Phase 3C moved every general transition into the kernel, because a Run status change is a
 * statement about the *Run* rather than about this host. The re-exports below are a compatibility
 * surface, not a second implementation: there is exactly one `failAgentRun`, one
 * `markAgentRunWaitingApproval` and one AgentState failure projection, and Core names them the way
 * its existing call sites already do.
 *
 * What stays here is the one thing that genuinely needs a coding-verification artefact: a
 * completion whose result must validate as a `VerifiedRunFinalResult`.
 */

/* ----------------------------------------------------- general transitions */

export {
  cancelAgentRun as markAgentRunCancelled,
  failAgentRun as markAgentRunFailed,
  markAgentRunBudgetExceeded,
  markAgentRunMaxStepsReached,
  markAgentRunWaitingApproval,
  markAgentRunWaitingResource,
  markAgentStateFailed,
  resumeAgentRunFromApproval,
  resumeAgentRunFromCompletionRepair as resumeAgentRunFromVerificationRepair,
  resumeAgentRunFromResource,
  timeOutAgentRun as markAgentRunTimedOut,
} from "@caelush/agent";

/* ------------------------------------------------------ verified completion */

/**
 * The Run that accepted a *verified* final result.
 *
 * The general transition is the kernel's `completeAgentRunWithFinalResult`; this adds the one thing
 * only the coding path can assert — that the value being persisted really is a
 * `VerifiedRunFinalResult` and not merely some JSON. A host that accepted an unverified candidate
 * fails here rather than durably claiming a seal it never produced.
 */
export function markAgentRunCompleted(
  run: AgentRun,
  finalResult: AgentRun["finalResult"],
  now: AgentRun["createdAt"],
): AgentRun {
  // Validated as a verified result first, then handed to the general transition. The two casts are
  // the same fact stated twice: the Protocol schema is what proves the value is JSON-safe, and the
  // kernel primitive accepts exactly that.
  const verified = VerifiedRunFinalResultSchema.parse(finalResult) as unknown as JsonValue;
  return completeAgentRunWithFinalResult(AgentRunSchema.parse(run), verified, now);
}

/* --------------------------------------------------------------- invariants */

/**
 * The Run execution invariant, in two halves.
 *
 * ```text
 * general       @caelush/agent   one snapshot describes one coherent Run
 * verification  this file        a VERIFYING Run is bound to the plan it is actually verifying
 * ```
 *
 * The split is what keeps a coding artefact out of the general Run domain: the kernel asserts
 * everything that is true of any Run, and this layer adds only the clause that needs a
 * `VerificationPlan` to state.
 */
export function assertRunExecutionInvariant(snapshot: RunExecutionSnapshotView): void {
  assertGeneralRunExecutionInvariant(snapshot);
  assertVerificationExecutionInvariant(snapshot);
}

/**
 * The coding-completion clause: a `VERIFYING` Run must hold its verification boundary.
 *
 * ```text
 * Phase 3E moved the plan out of the general snapshot
 * ```
 *
 * A general Run snapshot used to carry the `VerificationPlan` the Run was bound to, which is how this
 * clause used to prove that a `VERIFYING` Run had a plan. Phase 3E closed that: the plan lives behind
 * the Core-private completion persistence port, written in the same transaction as the boundary that
 * names it, so a general snapshot has no plan to compare against — and a *general* invariant must not
 * require a coding artefact to state itself.
 *
 * What remains here is the part that is about the Run Layer's own contract: a `VERIFYING` Run holds an
 * `AWAITING_VERIFICATION` continuation whose plan pointer belongs to its own Run and its own source
 * Step. The plan's own identity is re-validated inside the completion transaction, where the plan row
 * is actually read, so a Run that pointed at a plan nobody wrote still cannot complete.
 */
function assertVerificationExecutionInvariant(snapshot: RunExecutionSnapshotView): void {
  const { run, continuation } = snapshot;
  if (run.status !== "VERIFYING") return;
  if (
    continuation?.type !== "AWAITING_VERIFICATION" ||
    continuation.runId !== run.id ||
    continuation.verificationPlanId === undefined ||
    continuation.verificationPlanId === null
  ) {
    throw new RunExecutionInvariantError("VERIFYING Run must retain a verification candidate");
  }
}

/**
 * Whether a status is one the Run Layer may commit a boundary for.
 *
 * Delegates the settled half to the kernel's single terminal predicate, so a host cannot disagree
 * with the state machine about which statuses end a Run.
 */
export function isExecutionBoundaryStatus(status: RunStatus): boolean {
  return (
    status === "PENDING" ||
    status === "RUNNING" ||
    status === "WAITING_APPROVAL" ||
    status === "WAITING_RESOURCE" ||
    status === "VERIFYING" ||
    isTerminalRunStatus(status)
  );
}
