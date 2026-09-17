import type {
  AgentRun,
  AgentState,
  RunId,
  VerifiedRunFinalResult,
  VerificationPlan,
  VerificationPlanId,
} from "@caelush/protocol";
import type { DurableEventDraft, RunExecutionCommitResult } from "./run-execution-store.js";
import type { RunContinuationCheckpoint } from "./agent-continuation.js";

/**
 * The Core-private completion persistence boundary.
 *
 * ```text
 * general Run execution store      @caelush/agent   — a Run and its AgentState, and nothing else
 * coding completion persistence    @caelush/core    — this file
 * storage implementation           @caelush/storage — implements both, in one transaction each
 * ```
 *
 * Phase 3E closed the compatibility view that let this layer read a `VerificationPlan` straight off a
 * general Run snapshot. What replaces it is this port: a *general* Run store never has to answer a
 * verification question, and the coding completion path still gets the two things it genuinely needs
 * that a general store has no vocabulary for:
 *
 * ```text
 * a plan identity that must be persisted atomically with the Run boundary that names it
 * a completion that must be persisted atomically with the final result it carries
 * ```
 *
 * Both are *transactions*, not state models. Nothing here exposes a row, a client or a Drizzle type,
 * and nothing here can mutate a Run outside the canonical invariant the store already enforces.
 *
 * Deliberately absent: a way to read arbitrary verification state. The completion gate runs
 * verification through the verification subsystem's own execution ports, exactly as it always has;
 * this port is only the boundary where a *Run* transition and a *verification artefact* have to
 * become durable together.
 */
export interface RunCompletionPersistencePort {
  /** The plan a `VERIFYING` Run is bound to, or `null` when this Run has none. */
  loadVerificationPlan(runId: RunId, planId: VerificationPlanId): Promise<VerificationPlan | null>;

  /**
   * Open the durable completion boundary of one final candidate.
   *
   * ```text
   * AgentStep COMPLETED          the candidate's own Step settles exactly once
   * AgentRun.currentStepId       cleared
   * AgentState                   usage settled, status VERIFYING
   * Run                          RUNNING -> VERIFYING
   * candidate messages           appended
   * continuation                 AWAITING_VERIFICATION with the plan pointer
   * VerificationPlan             created
   * durable events               status.changed, verification.planned
   * ```
   *
   * All of it commits in **one** transaction. A Run that named a plan it never wrote, or a plan
   * written for a boundary that failed to open, is not a state this port can produce.
   */
  commitCandidateBoundary(command: RunCandidateBoundaryCommit): Promise<RunExecutionCommitResult>;

  /**
   * Settle a verified completion.
   *
   * The plan the Run is already bound to is re-validated inside the transaction, so a completion
   * cannot be settled against a plan that moved, was replaced, or never existed. The final result is
   * parsed as a `VerifiedRunFinalResult` before anything is written.
   */
  commitVerifiedCompletion(command: RunVerifiedCompletionCommit): Promise<RunExecutionCommitResult>;
}

/** The one atomic transition that opens a candidate's verification boundary. */
export interface RunCandidateBoundaryCommit {
  readonly run: AgentRun;
  readonly state: AgentState;
  /** The plan this boundary binds, written in the same transaction. */
  readonly verificationPlan: VerificationPlan;
  /** The continuation the boundary opens. */
  readonly continuation: Extract<
    RunContinuationCheckpoint,
    { readonly type: "AWAITING_VERIFICATION" }
  >;
  readonly expectedStateRevision: number | null;
  readonly expectedContinuationRevision: number | null;
  readonly stepWrites: import("./run-execution-store.js").RunExecutionCommitView["stepWrites"];
  readonly messagesToAppend: import("./run-execution-store.js").RunExecutionCommitView["messagesToAppend"];
  readonly events: readonly DurableEventDraft[];
}

/**
 * The verified-completion transaction.
 *
 * It is the same shape Phase 11D froze: Run, AgentState, final result, plan identity, continuation
 * clear and lifecycle events settle atomically, and the commit refuses a Run that is not `VERIFYING`
 * or a plan that is not the one the Run is bound to.
 */
export interface RunVerifiedCompletionCommit {
  readonly run: AgentRun;
  readonly state: AgentState;
  readonly finalResult: VerifiedRunFinalResult;
  readonly verificationPlan: VerificationPlan;
  readonly expectedStateRevision: number | null;
  readonly expectedContinuationRevision: number | null;
  readonly events: readonly DurableEventDraft[];
}
