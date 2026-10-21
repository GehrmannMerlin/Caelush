import type { RunExecutionCommitResult } from "@caelush/agent";
import type { ResourceGovernanceState } from "./resource-governance-port.js";
import type { RunExecutionCommitView } from "./run-execution-store.js";

export interface RunProgressWrite {
  readonly expectedProgressRevision: number | null;
  readonly nextProgress: ResourceGovernanceState;
}

/** The Core-owned transaction boundary for accepted execution and its derived progress. */
export interface RunProgressPersistencePort {
  commitExecutionWithProgress(
    input: {
      readonly execution: RunExecutionCommitView;
    } & RunProgressWrite,
  ): Promise<RunExecutionCommitResult>;
}
