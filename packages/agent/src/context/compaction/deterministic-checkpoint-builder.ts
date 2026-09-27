import {
  createStructuredCheckpoint,
  type StructuredCheckpoint,
} from "../checkpoint/structured-checkpoint.js";
import type { ContextMessageRange } from "./context-compaction-contracts.js";
import type { DeterministicCompactionFacts } from "./deterministic-compaction-facts.js";

export interface DeterministicCheckpointBuilder {
  build(input: {
    readonly goal: string;
    readonly sourceRange: ContextMessageRange;
    readonly facts: DeterministicCompactionFacts;
    readonly previousCheckpoint?: StructuredCheckpoint;
  }): StructuredCheckpoint;
}

export const DETERMINISTIC_SUMMARY_FALLBACK_MARKER =
  "Semantic summarization was unavailable; continue from deterministic durable state.";

export function createDeterministicCheckpointBuilder(): DeterministicCheckpointBuilder {
  const builder: DeterministicCheckpointBuilder = {
    build(input: Parameters<DeterministicCheckpointBuilder["build"]>[0]) {
      const previous = input.previousCheckpoint;
      const blocked = [...(previous?.blocked ?? [])];
      if (!blocked.includes(DETERMINISTIC_SUMMARY_FALLBACK_MARKER)) {
        blocked.push(DETERMINISTIC_SUMMARY_FALLBACK_MARKER);
      }
      return createStructuredCheckpoint({
        version: 1,
        goal: input.goal,
        constraints: previous?.constraints ?? [],
        completedWork: previous?.completedWork ?? [],
        inProgress: previous?.inProgress ?? [],
        blocked,
        importantDiscoveries: previous?.importantDiscoveries ?? [],
        keyDecisions: previous?.keyDecisions ?? [],
        changedFiles: input.facts.changedFiles,
        readFiles: input.facts.readFiles,
        recentErrors: input.facts.recentErrors,
        verificationState: input.facts.verificationState,
        activeProcesses: input.facts.activeProcesses,
        pendingApprovals: input.facts.pendingApprovals,
        resourceGovernance: input.facts.resourceGovernance,
        criticalReferences: previous?.criticalReferences ?? [],
        nextIntent: previous?.nextIntent ?? "Continue from the durable source range.",
        sourceRange: {
          from: input.sourceRange.firstSequence,
          to: input.sourceRange.lastSequence,
        },
      });
    },
  };
  return Object.freeze(builder);
}
