import type { StructuredCheckpoint } from "./checkpoint.js";

export interface ContextAuthoritySnapshot {
  readonly goal?: string;
  readonly changedFiles?: readonly string[];
  readonly pendingApprovals?: readonly string[];
  readonly activeProcesses?: readonly string[];
  readonly verificationState?: string;
  readonly resourceGovernance?: string;
  readonly projectFacts?: readonly string[];
}

export interface ContextRehydrationInput {
  readonly checkpoint?: StructuredCheckpoint;
  readonly authorities: ContextAuthoritySnapshot;
}

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

export class ContextRehydrator {
  async rehydrate(input: ContextRehydrationInput): Promise<RehydratedContextState> {
    const checkpoint = input.checkpoint;
    const goal = input.authorities.goal ?? checkpoint?.goal;
    if (goal === undefined || goal.length === 0) {
      throw new Error("Context rehydration requires an authoritative goal");
    }
    return Object.freeze({
      goal,
      changedFiles: Object.freeze([
        ...(input.authorities.changedFiles ?? checkpoint?.changedFiles ?? []),
      ]),
      pendingApprovals: Object.freeze([
        ...(input.authorities.pendingApprovals ?? checkpoint?.pendingApprovals ?? []),
      ]),
      activeProcesses: Object.freeze([
        ...(input.authorities.activeProcesses ?? checkpoint?.activeProcesses ?? []),
      ]),
      verificationState:
        input.authorities.verificationState ?? checkpoint?.verificationState ?? "UNKNOWN",
      resourceGovernance:
        input.authorities.resourceGovernance ?? checkpoint?.resourceGovernance ?? "UNKNOWN",
      projectFacts: Object.freeze([...(input.authorities.projectFacts ?? [])]),
      ...(checkpoint === undefined ? {} : { checkpoint }),
    });
  }
}
