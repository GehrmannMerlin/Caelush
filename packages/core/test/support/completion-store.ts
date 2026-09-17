import type {
  RunCandidateBoundaryCommit,
  RunCompletionPersistencePort,
  RunExecutionStore,
  RunVerifiedCompletionCommit,
} from "../../src/index.js";
import type { VerificationPlan, VerificationPlanId } from "@caelush/protocol";

/**
 * A completion persistence port over an in-memory Run store.
 *
 * ```text
 * Phase 3E: the plan left the general Run snapshot
 * ```
 *
 * A general Run snapshot no longer carries a `VerificationPlan`, which means every Run fixture that
 * reaches a final candidate has to answer the Core-private completion persistence port as well: the
 * candidate boundary writes the plan in the same call that writes the Run continuation, and a verified
 * completion commits the accepted result.
 *
 * This is that adapter, so each suite composes it rather than growing a second copy of the same two
 * methods and the same plan registry.
 *
 * The two commits route through the *supplied* store's `commit`, which is what keeps an instrumented
 * fixture instrumented: a suite that wraps `commit` to observe or refuse a transition still observes
 * and still refuses the candidate boundary.
 */
export function completionStoreOver(store: RunExecutionStore): RunCompletionPersistencePort {
  const plans = new Map<string, VerificationPlan>();
  return {
    async loadVerificationPlan(
      _runId,
      planId: VerificationPlanId,
    ): Promise<VerificationPlan | null> {
      return plans.get(planId) ?? null;
    },
    async commitCandidateBoundary(command: RunCandidateBoundaryCommit) {
      plans.set(command.verificationPlan.id, command.verificationPlan);
      return store.commit({
        run: command.run,
        state: command.state,
        expectedStateRevision: command.expectedStateRevision,
        expectedContinuationRevision: command.expectedContinuationRevision,
        stepWrites: command.stepWrites,
        messagesToAppend: command.messagesToAppend,
        continuation: {
          operation: "SET",
          checkpoint: command.continuation,
          updatedAt: command.state.updatedAt,
        },
        events: command.events,
      });
    },
    async commitVerifiedCompletion(command: RunVerifiedCompletionCommit) {
      return store.commit({
        run: command.run,
        state: command.state,
        expectedStateRevision: command.expectedStateRevision,
        expectedContinuationRevision: command.expectedContinuationRevision,
        stepWrites: [],
        messagesToAppend: [],
        continuation: { operation: "CLEAR" },
        events: command.events,
      });
    },
  };
}
