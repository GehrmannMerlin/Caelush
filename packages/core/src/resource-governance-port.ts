import type { RunId, RunResourcePolicy, TimestampMs } from "@caelush/protocol";

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
  readonly revision: number;
  readonly createdAt: TimestampMs;
  readonly updatedAt: TimestampMs;
}

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
