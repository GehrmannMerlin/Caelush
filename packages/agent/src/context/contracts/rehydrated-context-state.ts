import type { StructuredCheckpoint } from "../item/context-item.js";

/**
 * The authority overlay consumed by the document boundary.
 *
 * Phase 7B defines this target input shape so a document builder does not invent a
 * second authority contract. Rehydration, checkpoint loading and authority acquisition
 * remain later-phase responsibilities.
 */
export interface RehydratedContextState {
  readonly goal: string;
  readonly changedFiles: readonly string[];
  readonly pendingApprovals: readonly string[];
  readonly activeProcesses: readonly string[];
  readonly verificationState: string;
  readonly resourceGovernance: string;
  readonly projectFacts: readonly string[];
  readonly checkpoint?: StructuredCheckpoint;
}
