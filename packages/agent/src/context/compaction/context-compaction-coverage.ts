import type {
  ContextCheckpointRecordV2,
  ContextHistoryIndex,
  LegacyContextCheckpointRecordV1,
} from "./context-compaction-contracts.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";
import type { ContextHistoryUnit, ContextMessageRef } from "../history/semantic-history-unit.js";
import type { AgentMessageId } from "../../messages/types/ids.js";
import type { ContextCheckpointId } from "./context-compaction-contracts.js";
import { ContextPlanningError } from "../planner/context-planning-errors.js";

export interface ContextCompactionCandidatePreparation {
  readonly history: ContextHistoryIndex;
  readonly previousCheckpoint?: StructuredCheckpoint;
  readonly trustedPreviousCheckpointId?: ContextCheckpointId;
}

export interface ContextCompactionCoverage extends ContextCompactionCandidatePreparation {
  /** The unique model-visible messages removed by the checkpoint coverage projection. */
  readonly coveredMessageIds: ReadonlySet<AgentMessageId>;
}

/**
 * Project a checkpoint's covered messages out of the semantic history index.
 *
 * The history index deliberately contains overlapping conversation-turn and ToolProtocol
 * views. Coverage is therefore calculated from unique message identity first, then projected
 * back onto each view. V2 ranges are strict: a partial ToolProtocol boundary is unsafe and
 * fails closed. V1 ranges remain readable, but a partially affected protocol is retained in
 * full and never becomes a trusted predecessor for a future V2 checkpoint.
 */
export function createContextCompactionCoverage(input: {
  readonly history: ContextHistoryIndex;
  readonly latestCheckpoint?: ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1;
}): ContextCompactionCoverage {
  const uniqueRefs = collectUniqueMessageRefs(input.history.units);
  const latest = input.latestCheckpoint;
  if (latest === undefined) {
    return Object.freeze({
      history: input.history,
      coveredMessageIds: new Set<AgentMessageId>(),
    });
  }

  const range = checkpointRange(latest);
  const initialCoverage = resolveRangeCoverage(uniqueRefs, range, latest.schemaVersion === 2);
  const coveredMessageIds = new Set<AgentMessageId>(initialCoverage);

  if (latest.schemaVersion === 2) {
    assertV2ProtocolBoundaries(input.history.units, coveredMessageIds);
  } else {
    protectPartialLegacyProtocols(input.history.units, coveredMessageIds);
  }

  const remainingUnits = input.history.units
    .map((unit) => projectUnit(unit, coveredMessageIds, latest.schemaVersion === 2))
    .filter((unit): unit is ContextHistoryUnit => unit !== null);
  const history = rebuildHistory(remainingUnits);

  return Object.freeze({
    history,
    coveredMessageIds,
    previousCheckpoint: latest.structuredCheckpoint,
    ...(latest.schemaVersion === 2 ? { trustedPreviousCheckpointId: latest.checkpointId } : {}),
  });
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
  const coverage = createContextCompactionCoverage(input);
  return Object.freeze({
    history: coverage.history,
    ...(coverage.previousCheckpoint === undefined
      ? {}
      : { previousCheckpoint: coverage.previousCheckpoint }),
    ...(coverage.trustedPreviousCheckpointId === undefined
      ? {}
      : { trustedPreviousCheckpointId: coverage.trustedPreviousCheckpointId }),
  });
}

interface ContextCheckpointRange {
  readonly runId: string;
  readonly firstMessageId?: AgentMessageId;
  readonly lastMessageId?: AgentMessageId;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly conversationTurnId?: string;
}

function checkpointRange(
  checkpoint: ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1,
): ContextCheckpointRange {
  if (checkpoint.schemaVersion === 2) {
    if (String(checkpoint.runId) !== String(checkpoint.sourceRange.runId)) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
    return {
      runId: String(checkpoint.runId),
      firstMessageId: checkpoint.sourceRange.firstMessageId,
      lastMessageId: checkpoint.sourceRange.lastMessageId,
      firstSequence: checkpoint.sourceRange.firstSequence,
      lastSequence: checkpoint.sourceRange.lastSequence,
      conversationTurnId: String(checkpoint.sourceRange.conversationTurnId),
    };
  }
  if (
    !Number.isSafeInteger(checkpoint.sourceSequenceFrom) ||
    !Number.isSafeInteger(checkpoint.sourceSequenceTo) ||
    checkpoint.sourceSequenceFrom < 1 ||
    checkpoint.sourceSequenceTo < checkpoint.sourceSequenceFrom
  ) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
  return {
    runId: String(checkpoint.runId),
    firstSequence: checkpoint.sourceSequenceFrom,
    lastSequence: checkpoint.sourceSequenceTo,
  };
}

function collectUniqueMessageRefs(
  units: readonly ContextHistoryUnit[],
): ReadonlyMap<string, ContextMessageRef> {
  const refs = new Map<string, ContextMessageRef>();
  for (const unit of units) {
    for (const ref of unit.messages) {
      const key = String(ref.messageId);
      const previous = refs.get(key);
      if (
        previous !== undefined &&
        (String(previous.runId) !== String(ref.runId) ||
          String(previous.conversationTurnId) !== String(ref.conversationTurnId) ||
          previous.sequence !== ref.sequence)
      ) {
        throw new ContextPlanningError("INCONSISTENT_PLAN");
      }
      refs.set(key, ref);
    }
  }
  return refs;
}

function resolveRangeCoverage(
  refs: ReadonlyMap<string, ContextMessageRef>,
  range: ContextCheckpointRange,
  isV2: boolean,
): readonly AgentMessageId[] {
  if (range.firstSequence > range.lastSequence) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }

  let firstRef: ContextMessageRef | undefined;
  let lastRef: ContextMessageRef | undefined;
  if (isV2) {
    firstRef =
      range.firstMessageId === undefined ? undefined : refs.get(String(range.firstMessageId));
    lastRef = range.lastMessageId === undefined ? undefined : refs.get(String(range.lastMessageId));
    if (
      firstRef === undefined ||
      lastRef === undefined ||
      String(firstRef.runId) !== range.runId ||
      String(lastRef.runId) !== range.runId ||
      firstRef.sequence !== range.firstSequence ||
      lastRef.sequence !== range.lastSequence ||
      (range.conversationTurnId !== undefined &&
        String(firstRef.conversationTurnId) !== range.conversationTurnId)
    ) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
  }

  const covered: AgentMessageId[] = [];
  const messageIdBySequence = new Map<number, AgentMessageId>();
  for (const ref of refs.values()) {
    if (ref.sequence < range.firstSequence || ref.sequence > range.lastSequence) continue;
    if (String(ref.runId) !== range.runId) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
    const existingMessageId = messageIdBySequence.get(ref.sequence);
    if (existingMessageId !== undefined && existingMessageId !== ref.messageId) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
    messageIdBySequence.set(ref.sequence, ref.messageId);
    covered.push(ref.messageId);
  }
  return covered;
}

function assertV2ProtocolBoundaries(
  units: readonly ContextHistoryUnit[],
  coveredMessageIds: ReadonlySet<AgentMessageId>,
): void {
  for (const unit of units) {
    if (unit.kind !== "TOOL_PROTOCOL") continue;
    const coveredCount = unit.messages.filter((ref) => coveredMessageIds.has(ref.messageId)).length;
    if (coveredCount > 0 && coveredCount < unit.messages.length) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
  }
}

function protectPartialLegacyProtocols(
  units: readonly ContextHistoryUnit[],
  coveredMessageIds: Set<AgentMessageId>,
): void {
  for (const unit of units) {
    if (unit.kind !== "TOOL_PROTOCOL") continue;
    const coveredCount = unit.messages.filter((ref) => coveredMessageIds.has(ref.messageId)).length;
    if (coveredCount > 0 && coveredCount < unit.messages.length) {
      for (const ref of unit.messages) coveredMessageIds.delete(ref.messageId);
    }
  }
}

function projectUnit(
  unit: ContextHistoryUnit,
  coveredMessageIds: ReadonlySet<AgentMessageId>,
  isV2: boolean,
): ContextHistoryUnit | null {
  if (unit.kind === "TOOL_PROTOCOL") {
    const coveredCount = unit.messages.filter((ref) => coveredMessageIds.has(ref.messageId)).length;
    if (coveredCount === unit.messages.length) return null;
    if (isV2 && coveredCount > 0) throw new ContextPlanningError("INCONSISTENT_PLAN");
    return rebuildUnit(unit, unit.messages);
  }

  const remainingMessages = unit.messages.filter((ref) => !coveredMessageIds.has(ref.messageId));
  return remainingMessages.length === 0 ? null : rebuildUnit(unit, remainingMessages);
}

function rebuildUnit(
  unit: ContextHistoryUnit,
  messages: readonly ContextMessageRef[],
): ContextHistoryUnit {
  const unique = new Set<string>();
  const tokenEstimate = messages.reduce((total, ref) => {
    const key = String(ref.messageId);
    if (unique.has(key)) return total;
    unique.add(key);
    return total + (ref.tokenEstimate ?? 0);
  }, 0);
  return Object.freeze({
    ...unit,
    messages: Object.freeze([...messages]),
    tokenEstimate,
  });
}

function rebuildHistory(units: readonly ContextHistoryUnit[]): ContextHistoryIndex {
  const ordered = Object.freeze([...units].sort(compareUnits));
  const unique = new Set<string>();
  let estimatedTokens = 0;
  for (const unit of ordered) {
    for (const ref of unit.messages) {
      const key = String(ref.messageId);
      if (unique.has(key)) continue;
      unique.add(key);
      estimatedTokens += ref.tokenEstimate ?? 0;
    }
  }
  return Object.freeze({
    units: ordered,
    openUnits: Object.freeze(ordered.filter((unit) => unit.status === "OPEN")),
    closedUnits: Object.freeze(ordered.filter((unit) => unit.status === "CLOSED")),
    estimatedTokens,
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
