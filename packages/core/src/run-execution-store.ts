import type {
  RunExecutionCommit,
  RunExecutionCommitResult,
  RunExecutionSnapshot,
  RunExecutionStorePort,
} from "@caelush/agent";
import type { RunId } from "@caelush/protocol";

/**
 * The Run Layer's view over the canonical Run execution store.
 *
 * ```text
 * General Run execution store   @caelush/agent      — the contract, and only the contract
 * Coding completion persistence @caelush/core       — run-completion-store.ts
 * Storage implementation        @caelush/storage    — implements both
 * ```
 *
 * The general symbols below are *re-exports*. There is deliberately no second declaration of
 * `RunExecutionStorePort`, `RunExecutionSnapshot`, `RunExecutionCommit` or the two error classes:
 * two declarations would mean two identities, and `instanceof` would silently stop agreeing with the
 * throw.
 *
 * Phase 3E closed the verification half of this view. A general Run snapshot used to carry the
 * `VerificationPlan` the Run was bound to, which meant a general store had to answer a verification
 * question and the Run Layer could read a coding artefact straight off a general snapshot. The plan now
 * lives behind the Core-private completion persistence port, where it is written in the same
 * transaction as the boundary that names it, and nothing here mentions verification at all.
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
 * The general Run snapshot the Run Layer reads.
 *
 * It is the canonical snapshot, unchanged. The alias exists so the Run Layer's call sites keep one
 * name for it, and so a future change to how a Run is read has exactly one place to happen.
 */
export type RunExecutionSnapshotView = RunExecutionSnapshot;

/** The general Run commit the Run Layer describes. */
export type RunExecutionCommitView = RunExecutionCommit;

/**
 * The store contract the Run Layer uses.
 *
 * It is the canonical agent port, and nothing more. A store implementation satisfies it directly; a
 * host that also implements the Core-private completion persistence port is asked for that separately,
 * by the one boundary that needs it.
 */
export interface RunExecutionStore extends RunExecutionStorePort {
  load(runId: RunId): Promise<RunExecutionSnapshotView | null>;
  commit(command: RunExecutionCommitView): Promise<RunExecutionCommitResult>;
}

/**
 * The plan a `VERIFYING` Run is bound to, as the completion boundary needs it.
 *
 * Re-exported here so the completion port and the store view agree on one name. It is the only
 * verification symbol left in this file, and it appears as an *import type of a port*, never as a field
 * of a general Run.
 */
export type { RunContinuationCheckpoint } from "./agent-continuation.js";
