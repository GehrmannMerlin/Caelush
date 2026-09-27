import {
  createStructuredCheckpoint,
  type StructuredCheckpoint,
} from "../checkpoint/structured-checkpoint.js";
import type { ContextMessageRange } from "./context-compaction-contracts.js";
import type { DeterministicCompactionFacts } from "./deterministic-compaction-facts.js";
import type { SemanticCheckpointDraft } from "./semantic-checkpoint-draft.js";

export interface ContextCheckpointEnricher {
  enrich(input: {
    readonly semantic: SemanticCheckpointDraft;
    readonly facts: DeterministicCompactionFacts;
    readonly sourceRange: ContextMessageRange;
  }): StructuredCheckpoint;
}

export function createContextCheckpointEnricher(): ContextCheckpointEnricher {
  const enricher: ContextCheckpointEnricher = {
    enrich(input: Parameters<ContextCheckpointEnricher["enrich"]>[0]) {
      return createStructuredCheckpoint({
        version: 1,
        goal: input.semantic.goal,
        constraints: input.semantic.constraints,
        completedWork: input.semantic.completedWork,
        inProgress: input.semantic.inProgress,
        blocked: input.semantic.blocked,
        importantDiscoveries: input.semantic.importantDiscoveries,
        keyDecisions: input.semantic.keyDecisions,
        changedFiles: input.facts.changedFiles,
        readFiles: input.facts.readFiles,
        recentErrors: input.facts.recentErrors,
        verificationState: input.facts.verificationState,
        activeProcesses: input.facts.activeProcesses,
        pendingApprovals: input.facts.pendingApprovals,
        resourceGovernance: input.facts.resourceGovernance,
        criticalReferences: input.semantic.criticalReferences,
        nextIntent: input.semantic.nextIntent,
        sourceRange: {
          from: input.sourceRange.firstSequence,
          to: input.sourceRange.lastSequence,
        },
      });
    },
  };
  return Object.freeze(enricher);
}
