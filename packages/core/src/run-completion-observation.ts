import type {
  VerificationCheckId,
  VerificationEvidenceId,
  VerificationPlan,
} from "@caelush/protocol";

/**
 * The Core-private record of what one completion evaluation actually did.
 *
 * ```text
 * Core-private — never a @caelush/agent public contract
 * ```
 *
 * The frozen `CompletionGateDecision` is the answer: may this candidate become the Run's result, and
 * if not, what should happen instead. It is deliberately free of every host fact that produced that
 * answer, and three of those facts are needed by a durable write:
 *
 * ```text
 * the plan and its evidence      the seal binds a plan identity, a candidate hash and an evidence
 *                                digest, and none of them can be recovered from `ACCEPT`
 * the failed and errored checks   `WAITING_VERIFICATION_REPAIR` has always persisted exactly which
 *                                checks failed and which evidence described them
 * the freshness verdicts          a completion is only trustworthy when the workspace and the
 *                                repository are still the ones the evidence was taken from
 * ```
 *
 * Exactly as in Phase 3C's `AgentTurnObservation` and Phase 3D's `RunToolTurnObservation`, this is the
 * channel for those facts. It is produced by the completion gate, consumed by the Run Layer's own
 * settlement, and it is **not** added to the frozen completion contract.
 *
 * Every field is a fact about work that *did* happen. A verification status is the evaluator's own
 * verdict, a failed check id is one the evaluator named, and a seal is the object that was actually
 * created — nothing here is inferred from a message, a string or a default.
 */

/** The evaluator's verdict for one plan, as the gate read it. */
export type CompletionVerificationStatus = "PASSED" | "FAILED" | "ERROR" | "INCOMPLETE";

/** Whether the workspace is still the one the verification evidence was taken from. */
export type CompletionWorkspaceFreshness = "FRESH" | "STALE" | "UNPROVABLE";

/** Whether the repository state is still the one the verification evidence was taken from. */
export type CompletionGitFreshness = "FRESH" | "STALE" | "UNPROVABLE" | "SKIPPED";

/**
 * The completion evaluation's Core-private observation.
 *
 * Mutable on purpose: the gate fills it in as the evaluation proceeds, so a decision that stops early
 * reports exactly what it established and nothing more. A field that is absent means the gate never
 * got that far — an absent seal is not an empty seal.
 */
export interface CompletionGateObservation {
  /**
   * How this evaluation was entered.
   *
   * ```text
   * EXECUTE  a fresh candidate, evaluated for the first time
   * RECOVER  a candidate a restart found, re-evaluated from durable evidence
   * ```
   *
   * It never changes what a verified completion *means*. It is recorded so a decision can be
   * attributed to the path that produced it, and so a recovery is distinguishable from a first
   * attempt in the ledger's own reasoning.
   */
  readonly effectiveMode: "EXECUTE" | "RECOVER";
  /** The durable plan this evaluation ran against. */
  plan?: VerificationPlan | undefined;
  /** The evaluator's verdict for that plan. */
  verificationStatus?: CompletionVerificationStatus | undefined;
  /** The checks the evaluator named as blocking failures. */
  failedCheckIds?: readonly VerificationCheckId[] | undefined;
  /** The checks the evaluator named as errors. */
  errorCheckIds?: readonly VerificationCheckId[] | undefined;
  /**
   * The evidence the repair boundary points at.
   *
   * They are the ids of the evidence rows that describe the *failed* checks, read from the durable
   * verification execution rather than parsed out of the frozen repair metadata.
   */
  evidenceIds?: readonly VerificationEvidenceId[] | undefined;
  /** The repair cycle this evaluation decided under, when it decided one. */
  repairCycle?: number | undefined;
  /** The workspace freshness verdict. */
  workspaceFreshness?: CompletionWorkspaceFreshness | undefined;
  /** The Git freshness verdict. */
  gitFreshness?: CompletionGitFreshness | undefined;
  /** The completion seal, when one was created. */
  seal?: import("@caelush/protocol").VerificationCompletionSeal | undefined;
  /**
   * The exact `VerifiedRunFinalResult` the gate accepted.
   *
   * It is the same object the frozen `ACCEPT` decision carries. It is recorded separately so the
   * settlement can assert the two agree before committing a completion: a decision that accepted one
   * result while the gate recorded another would be a completion nobody verified.
   */
  verifiedFinalResult?: import("@caelush/protocol").VerifiedRunFinalResult | undefined;
  /** The gate's own id, so a commit can be attributed to the policy that produced it. */
  gateId?: string | undefined;
}

/** Create the observation one completion evaluation starts from. */
export function createCompletionGateObservation(input: {
  readonly effectiveMode: "EXECUTE" | "RECOVER";
  readonly gateId?: string | undefined;
}): CompletionGateObservation {
  return {
    effectiveMode: input.effectiveMode,
    ...(input.gateId === undefined ? {} : { gateId: input.gateId }),
  };
}
