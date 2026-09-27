import type { RunId } from "@caelush/protocol";

import type { ContextHistoryIndex } from "../history/semantic-history-unit.js";
import { ContextPlanningError } from "../planner/context-planning-errors.js";
import {
  createContextCompactionCoverage,
} from "./context-compaction-coverage.js";
import type {
  ContextCheckpointRecordV2,
  ContextCheckpointRepositoryPort,
  LegacyContextCheckpointRecordV1,
} from "./context-compaction-contracts.js";

export type IncrementalCheckpointState =
  | { readonly kind: "NONE" }
  | { readonly kind: "V2"; readonly checkpoint: ContextCheckpointRecordV2 }
  | { readonly kind: "LEGACY_V1"; readonly checkpoint: LegacyContextCheckpointRecordV1 };

export interface IncrementalCheckpointResolver {
  resolve(input: {
    readonly runId: RunId;
    readonly history: ContextHistoryIndex;
  }): Promise<IncrementalCheckpointState>;
}

export function createIncrementalCheckpointResolver(options: {
  readonly checkpointRepository: ContextCheckpointRepositoryPort;
}): IncrementalCheckpointResolver {
  return Object.freeze({
    async resolve(input: {
      readonly runId: RunId;
      readonly history: ContextHistoryIndex;
    }): Promise<IncrementalCheckpointState> {
      const latest = await options.checkpointRepository.getLatestByRun(input.runId);
      if (latest === undefined) return Object.freeze({ kind: "NONE" });
      if (String(latest.runId) !== String(input.runId)) {
        throw new ContextPlanningError("INCONSISTENT_PLAN");
      }
      if (latest.schemaVersion === 2) {
        createContextCompactionCoverage({
          history: input.history,
          latestCheckpoint: latest,
        });
        return Object.freeze({ kind: "V2", checkpoint: latest });
      }
      return Object.freeze({ kind: "LEGACY_V1", checkpoint: latest });
    },
  });
}
