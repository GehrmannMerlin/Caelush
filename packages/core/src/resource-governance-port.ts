import type {
  ResourceProgressBoundary,
  RunCorrectionRecoveryRecordV1,
  RunId,
  RunResourcePolicy,
  TimestampMs,
} from "@caelush/protocol";

import type { ResourceSemanticProgress } from "./resource-progress-projection.js";

export interface ResourceGovernanceState {
  readonly runId: RunId;
  readonly policyVersion: string;
  readonly mode: RunResourcePolicy["mode"];
  readonly leaseEpoch: number;
  readonly leaseStartAgentTurns: number;
  readonly leaseStartToolCalls: number;
  readonly agentTurnsConsumed: number;
  readonly toolOperationsConsumed: number;
  readonly lastProgressAt?: TimestampMs;
  readonly consecutiveNoProgressTurns: number;
  readonly replanCount: number;
  readonly resourceGuardState: "NONE" | "NUDGE" | "REPLAN_REQUIRED" | "WAITING_RESOURCE";
  readonly recentFingerprints: readonly { readonly request: string; readonly result: string }[];
  /**
   * The derived repeated-failure window, when this Run has produced one.
   *
   * Absent for a Run that has never had a rejected call, and absent for every historical row: a
   * missing projection means "no semantic evidence", never "no failures happened".
   */
  readonly semanticProgress?: ResourceSemanticProgress | undefined;
  /** The last result boundary folded into this projection, persisted with its accepted messages. */
  readonly lastAcceptedBoundary?: ResourceProgressBoundary | undefined;
  readonly correctionRecovery?: RunCorrectionRecoveryRecordV1 | undefined;
  readonly revision: number;
  readonly createdAt: TimestampMs;
  readonly updatedAt: TimestampMs;
}

export type { ResourceProgressBoundary } from "@caelush/protocol";

export interface ResourceGovernancePort {
  get(runId: RunId): Promise<ResourceGovernanceState | null>;
  createOrGet(
    runId: RunId,
    input: {
      readonly policyVersion: string;
      readonly mode: RunResourcePolicy["mode"];
      readonly now: TimestampMs;
    },
  ): Promise<ResourceGovernanceState>;
  compareAndSwap(
    runId: RunId,
    expectedRevision: number,
    next: ResourceGovernanceState,
  ): Promise<ResourceGovernanceState>;
}
