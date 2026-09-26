import type { AgentExecutionIdentity } from "../../loop/types.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";

export interface ContextAuthoritySnapshot {
  readonly goal?: string;
  readonly changedFiles?: readonly string[];
  readonly pendingApprovals?: readonly string[];
  readonly activeProcesses?: readonly string[];
  readonly verificationState?: string;
  readonly resourceGovernance?: string;
  readonly projectFacts?: readonly string[];
}

export interface ContextAuthorityProviderPort {
  snapshot(input: {
    readonly identity: AgentExecutionIdentity;
    readonly signal: AbortSignal;
  }): Promise<ContextAuthoritySnapshot>;
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

export interface ContextRehydratorPort {
  rehydrate(input: {
    readonly checkpoint?: StructuredCheckpoint;
    readonly authorities: ContextAuthoritySnapshot;
  }): Promise<RehydratedContextState>;
}
