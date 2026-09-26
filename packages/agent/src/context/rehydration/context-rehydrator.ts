import {
  createStructuredCheckpoint,
  type StructuredCheckpoint,
} from "../checkpoint/structured-checkpoint.js";
import type {
  ContextAuthoritySnapshot,
  ContextRehydratorPort,
  RehydratedContextState,
} from "./context-authority-contracts.js";

/** Rehydrate a model-facing state without mutating any authority or Run state. */
export function createContextRehydrator(): ContextRehydratorPort {
  return Object.freeze({
    async rehydrate(input: {
      readonly checkpoint?: StructuredCheckpoint;
      readonly authorities: ContextAuthoritySnapshot;
    }): Promise<RehydratedContextState> {
      const checkpoint =
        input.checkpoint === undefined ? undefined : createStructuredCheckpoint(input.checkpoint);
      return Object.freeze({
        goal: input.authorities.goal ?? checkpoint?.goal ?? "",
        changedFiles: freezeList(input.authorities.changedFiles ?? checkpoint?.changedFiles ?? []),
        pendingApprovals: freezeList(
          input.authorities.pendingApprovals ?? checkpoint?.pendingApprovals ?? [],
        ),
        activeProcesses: freezeList(
          input.authorities.activeProcesses ?? checkpoint?.activeProcesses ?? [],
        ),
        verificationState:
          input.authorities.verificationState ?? checkpoint?.verificationState ?? "",
        resourceGovernance:
          input.authorities.resourceGovernance ?? checkpoint?.resourceGovernance ?? "",
        projectFacts: freezeList(input.authorities.projectFacts ?? []),
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
    },
  });
}

function freezeList(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}
