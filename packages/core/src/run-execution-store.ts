import type {
  DurableEventDraft,
  RunExecutionCommit,
  RunExecutionCommitResult,
  RunExecutionSnapshot,
  RunExecutionStorePort,
} from "@caelush/agent";
import type {
  AgentRun,
  AgentState,
  RunId,
  VerifiedRunFinalResult,
  VerificationPlan,
  VerificationPlanId,
} from "@caelush/protocol";

/**
 * The Run Layer's compatibility view over the canonical Run execution store.
 *
 * ```text
 * General Run execution store   @caelush/agent      — the contract, and only the contract
 * Verification compatibility    @caelush/core       — this file
 * Storage implementation        @caelush/storage    — implements both
 * ```
 *
 * The general symbols below are *re-exports*. There is deliberately no second declaration of
 * `RunExecutionStorePort`, `RunExecutionSnapshot`, `RunExecutionCommit` or the two error classes:
 * two declarations would mean two identities, and `instanceof` would silently stop agreeing with
 * the throw.
 *
 * What is genuinely Core-owned is the coding-verification concern, which the general Run port
 * must not carry:
 *
 * ```text
 * VerificationPlan            a coding-verification artefact, not a Run execution fact
 * VerifiedRunFinalResult      the completion authority's result
 * commitVerifiedCompletion    the completion transaction
 * ```
 *
 * This split is transitional and closes in Phase 3E, when completion authority moves.
 */

export { RunExecutionConflictError, RunExecutionInvariantError } from "@caelush/agent";
export type {
  DurableAgentEvent,
  DurableEventDraft,
  RunConversationEntry,
  RunExecutionCommit,
  RunExecutionCommitResult,
  RunExecutionContinuationWrite,
  RunExecutionMessageAppend,
  RunExecutionSnapshot,
  RunExecutionStepWrite,
  RunExecutionStorePort,
} from "@caelush/agent";

/**
 * The general snapshot plus the verification plan the Run Layer's coding path reads.
 *
 * The plan is *not* part of the canonical snapshot: the compatibility layer assembles it from the
 * general snapshot and the verification extension, so a general Run never carries a coding
 * artefact while a coding Run still sees what it needs.
 */
export type RunExecutionSnapshotView = RunExecutionSnapshot & {
  readonly verificationPlan?: VerificationPlan | undefined;
};

/** The general commit plus the plan a final candidate's boundary writes atomically. */
export type RunExecutionCommitView = RunExecutionCommit & {
  readonly verificationPlan?: VerificationPlan | undefined;
};

/**
 * The store contract the Run Layer uses.
 *
 * It extends the canonical agent port with the compatibility view, so the General Run surface
 * stays exactly the agent's while the coding path keeps working. A store implementation satisfies
 * both by implementing this interface.
 */
export interface RunExecutionStore extends RunExecutionStorePort {
  load(runId: RunId): Promise<RunExecutionSnapshotView | null>;
  commit(command: RunExecutionCommitView): Promise<RunExecutionCommitResult>;
}

/**
 * The verification-specific durable completion.
 *
 * Reused from the existing semantics rather than redesigned: the Run, the AgentState, the final
 * result, the plan and the events settle in one transaction, and the command must name the plan
 * the Run is actually verifying.
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

/**
 * The transitional coding-verification extension of the Run execution store.
 *
 * It exists so a general Run store never has to answer a verification question. Phase 3E replaces
 * it when completion authority is extracted.
 */
export interface VerificationRunExecutionStoreExtension {
  /** The plan a `VERIFYING` Run is bound to, or `null` when there is none. */
  loadVerificationPlan(runId: RunId, planId: VerificationPlanId): Promise<VerificationPlan | null>;
  /** Settle a verified completion. */
  commitVerifiedCompletion(command: RunVerifiedCompletionCommit): Promise<RunExecutionCommitResult>;
}
