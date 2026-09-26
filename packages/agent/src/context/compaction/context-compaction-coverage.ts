import type {
  ContextCheckpointRecordV2,
  ContextHistoryIndex,
  LegacyContextCheckpointRecordV1,
} from "./context-compaction-contracts.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";
import type { ContextHistoryUnit } from "../history/semantic-history-unit.js";
import type { ContextCheckpointId } from "./context-compaction-contracts.js";

export interface ContextCompactionCandidatePreparation {
  readonly history: ContextHistoryIndex;
  readonly previousCheckpoint?: StructuredCheckpoint;
  readonly trustedPreviousCheckpointId?: ContextCheckpointId;
}

/**
 * Remove semantic units fully covered by the latest checkpoint. A V1 range remains
 * usable as recovery context, but only a V2 message range can establish trusted chain
 * identity for the next record.
 */
export function prepareContextCompactionCandidates(input: {
  readonly history: ContextHistoryIndex;
  readonly latestCheckpoint?: ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1;
}): ContextCompactionCandidatePreparation {
  const latest = input.latestCheckpoint;
  if (latest === undefined) return Object.freeze({ history: input.history });

  const cutoff =
    latest.schemaVersion === 2 ? latest.sourceRange.lastSequence : latest.sourceSequenceTo;
  const remaining = input.history.units.filter((unit) =>
    unit.messages.some((message) => message.sequence > cutoff),
  );
  const removedTokenEstimate = input.history.units
    .filter((unit) => !remaining.includes(unit))
    .reduce((total, unit) => total + unit.tokenEstimate, 0);
  const history = rebuildHistory(input.history, remaining, removedTokenEstimate);
  return Object.freeze({
    history,
    previousCheckpoint: latest.structuredCheckpoint,
    ...(latest.schemaVersion === 2 ? { trustedPreviousCheckpointId: latest.checkpointId } : {}),
  });
}

function rebuildHistory(
  source: ContextHistoryIndex,
  units: readonly ContextHistoryUnit[],
  removedTokenEstimate: number,
): ContextHistoryIndex {
  const ordered = Object.freeze([...units].sort(compareUnits));
  return Object.freeze({
    units: ordered,
    openUnits: Object.freeze(ordered.filter((unit) => unit.status === "OPEN")),
    closedUnits: Object.freeze(ordered.filter((unit) => unit.status === "CLOSED")),
    estimatedTokens: Math.max(0, source.estimatedTokens - removedTokenEstimate),
  });
}

function compareUnits(left: ContextHistoryUnit, right: ContextHistoryUnit): number {
  return (
    (left.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER) || compareStrings(left.id, right.id)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
