import type {
  ContextCompactionPlan,
  ContextCompactionPlanner,
  ContextCompactionReason,
  ContextHistoryIndex,
  ContextMessageRange,
} from "./context-compaction-contracts.js";
import { createContextMessageRange } from "./context-compaction-contracts.js";
import { createContextCutPointSelector } from "./context-cut-point-selector.js";
import { selectProtocolSafeSplitCandidate } from "./context-cut-point-selector.js";
import type { ContextCompactionCutCandidate } from "./context-compaction-cut.js";
import {
  orderContextHistoryUnits,
  type ContextMessageRef,
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
  const cutInput = {
    history,
    targetRecentTailTokens: policy.targetRecentTailTokens,
    minRecentTailTokens: policy.minRecentTailTokens,
    allowCurrentTurnPrefix: policy.allowCurrentTurnPrefix === true,
  };
  const candidate = selector.select(cutInput);
  if (candidate === null) return null;

  const sourceCoverageDelta = createRanges(history.units, candidate);
  if (sourceCoverageDelta.length > 0) {
    return buildPlan(history, policy, reason, candidate, sourceCoverageDelta);
  }

  /*
   * The best candidate turned out unrepresentable, which must not become "nothing to compact".
   *
   * A cut is only durable if it can be written as one `ContextMessageRange` — a single Run and a
   * single Conversation Turn. The selector is supposed to respect that (`selectFullTurnBoundary`
   * stops at the first foreign Turn), so reaching this branch means a future selector rule slipped
   * past it. Falling back to the in-Turn protocol-safe cut keeps a whole Run from losing compaction
   * because its *preferred* cut was inexpressible: a narrower fold tonight beats no fold at all.
   */
  const split = selectProtocolSafeSplitCandidate(cutInput);
  const splitRanges = split === null ? [] : createRanges(history.units, split);
  if (split === null || splitRanges.length === 0) return null;
  return buildPlan(history, policy, reason, split, splitRanges);
}

function buildPlan(
  history: ContextHistoryIndex,
  policy: ContextPolicy,
  reason: ContextCompactionReason,
  candidate: ContextCompactionCutCandidate,
  sourceCoverageDelta: readonly ContextMessageRange[],
): ContextCompactionPlan {
  const sourceRange = sourceCoverageDelta[0];
  if (sourceRange === undefined)
    throw new TypeError("Compaction source coverage must not be empty.");
  return Object.freeze({
    reason,
    cut: candidate.cut,
    sourceRange,
    sourceCoverageDelta: Object.freeze([...sourceCoverageDelta]),
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

function createRanges(
  units: readonly ContextHistoryUnit[],
  candidate: ContextCompactionCutCandidate,
): readonly ContextMessageRange[] {
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
          if (cut.preserveLeadingMessages === true) {
            const firstCompactedProtocol = units.find(
              (unit) =>
                unit.kind === "TOOL_PROTOCOL" &&
                unit.messages.some(
                  (message) =>
                    String(message.runId) === String(splitMessage.runId) &&
                    String(message.conversationTurnId) ===
                      String(splitMessage.conversationTurnId) &&
                    message.sequence < cut.firstKeptSequence,
                ),
            );
            const firstCompactedSequence = firstCompactedProtocol?.messages[0]?.sequence;
            if (firstCompactedSequence === undefined) return [];
            return primaryTurns[splitTurnIndex]!.messages.filter(
              (message) =>
                message.sequence >= firstCompactedSequence &&
                message.sequence < cut.firstKeptSequence,
            );
          }
          return primaryTurns.flatMap((unit, index) => {
            if (index < splitTurnIndex) return unit.messages;
            if (index > splitTurnIndex) return [];
            return unit.messages.filter((message) => message.sequence < cut.firstKeptSequence);
          });
        })();
  if (refs.length === 0) return [];
  const grouped: ContextMessageRef[][] = [];
  for (const ref of refs) {
    const priorGroup = grouped.at(-1);
    const prior = priorGroup?.at(-1);
    if (
      prior !== undefined &&
      String(prior.runId) === String(ref.runId) &&
      String(prior.conversationTurnId) === String(ref.conversationTurnId)
    ) {
      if (ref.sequence !== prior.sequence + 1) return [];
      priorGroup!.push(ref);
    } else {
      grouped.push([ref]);
    }
  }
  return grouped.map((group) => {
    const first = group[0]!;
    const last = group.at(-1)!;
    return createContextMessageRange({
      runId: first.runId,
      conversationTurnId: first.conversationTurnId,
      firstMessageId: first.messageId,
      lastMessageId: last.messageId,
      firstSequence: first.sequence,
      lastSequence: last.sequence,
    });
  });
}
