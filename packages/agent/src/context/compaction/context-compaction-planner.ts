import type {
  ContextCompactionPlan,
  ContextCompactionPlanner,
  ContextCompactionReason,
  ContextHistoryIndex,
  ContextMessageRange,
} from "./context-compaction-contracts.js";
import { createContextMessageRange } from "./context-compaction-contracts.js";
import { createContextCutPointSelector } from "./context-cut-point-selector.js";
import type { ContextCompactionCutCandidate } from "./context-compaction-cut.js";
import {
  orderContextHistoryUnits,
  type ContextHistoryUnit,
} from "../history/semantic-history-unit.js";
import type { ContextPolicy } from "../policy/context-policy.js";

/** Create the pure, deterministic semantic compaction planner. */
export function createContextCompactionPlanner(): ContextCompactionPlanner {
  const selector = createContextCutPointSelector();
  return Object.freeze({
    plan(input: {
      readonly history: ContextHistoryIndex;
      readonly policy: ContextPolicy;
      readonly reason: ContextCompactionReason;
      readonly latestCheckpoint?: import("./context-compaction-contracts.js").ContextCheckpointRecordV2;
    }): ContextCompactionPlan | null {
      return planCompaction(input.history, input.policy, input.reason, selector);
    },
  });
}

function planCompaction(
  history: ContextHistoryIndex,
  policy: ContextPolicy,
  reason: ContextCompactionReason,
  selector: ReturnType<typeof createContextCutPointSelector>,
): ContextCompactionPlan | null {
  const candidate = selector.select({
    history,
    targetRecentTailTokens: policy.targetRecentTailTokens,
    minRecentTailTokens: policy.minRecentTailTokens,
  });
  if (candidate === null) return null;

  const sourceRange = createRange(history.units, candidate);
  if (sourceRange === null) return null;

  return Object.freeze({
    reason,
    cut: candidate.cut,
    sourceRange,
    selectedUnitIds: candidate.compactedUnitIds,
    retainedUnitIds: candidate.retainedUnitIds,
    estimatedTokensBefore: history.estimatedTokens,
    selectedTokens: candidate.compactedTokens,
    retainedTokens: candidate.retainedTokens,
    targetRecentTailTokens: policy.targetRecentTailTokens,
    minRecentTailTokens: policy.minRecentTailTokens,
  });
}

/**
 * A turn and its protocol views overlap in the history index. Prefer the turn view,
 * which already carries the complete conversation boundary, and never double-count the
 * same durable message through a second semantic view.
 */
function canonicalUnits(units: readonly ContextHistoryUnit[]): readonly ContextHistoryUnit[] {
  const coveredMessageIds = new Set<string>();
  const result: ContextHistoryUnit[] = [];
  // Units arrive in canonical ConversationTurn order. Preserve it instead of flattening
  // Runs into a Session-wide sequence order.
  for (const unit of orderContextHistoryUnits(units)) {
    if (unit.messages.length === 0) continue;
    if (unit.messages.some((message) => coveredMessageIds.has(message.messageId))) continue;
    result.push(unit);
    for (const message of unit.messages) coveredMessageIds.add(message.messageId);
  }
  return result;
}

function createRange(
  units: readonly ContextHistoryUnit[],
  candidate: ContextCompactionCutCandidate,
): ContextMessageRange | null {
  const selectedIds = new Set(candidate.compactedUnitIds);
  const cut = candidate.cut;
  const primaryTurns = canonicalUnits(units).filter((unit) => unit.kind === "CONVERSATION_TURN");
  const refs =
    cut.kind === "TURN_BOUNDARY"
      ? primaryTurns.filter((unit) => selectedIds.has(unit.id)).flatMap((unit) => unit.messages)
      : (() => {
          const splitMessage = units.find((unit) => unit.id === cut.firstKeptProtocolUnitId)
            ?.messages[0];
          if (
            splitMessage === undefined ||
            String(splitMessage.conversationTurnId) !== String(cut.conversationTurnId)
          ) {
            return [];
          }
          const splitTurnIndex = primaryTurns.findIndex(
            (unit) =>
              String(unit.messages[0]?.runId) === String(splitMessage?.runId) &&
              String(unit.messages[0]?.conversationTurnId) ===
                String(splitMessage.conversationTurnId),
          );
          if (splitTurnIndex < 0) return [];
          return primaryTurns.flatMap((unit, index) => {
            if (index < splitTurnIndex) return unit.messages;
            if (index > splitTurnIndex) return [];
            return unit.messages.filter((message) => message.sequence < cut.firstKeptSequence);
          });
        })();
  const first = refs[0];
  const last = refs[refs.length - 1];
  if (first === undefined || last === undefined) return null;
  if (
    refs.some(
      (ref) => ref.runId !== first.runId || ref.conversationTurnId !== first.conversationTurnId,
    )
  ) {
    return null;
  }
  return createContextMessageRange({
    runId: first.runId,
    conversationTurnId: first.conversationTurnId,
    firstMessageId: first.messageId,
    lastMessageId: last.messageId,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
  });
}
