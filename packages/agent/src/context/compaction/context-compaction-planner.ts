import type {
  ContextCompactionPlan,
  ContextCompactionPlanner,
  ContextCompactionReason,
  ContextHistoryIndex,
  ContextMessageRange,
} from "./context-compaction-contracts.js";
import { createContextMessageRange } from "./context-compaction-contracts.js";
import type { ContextHistoryUnit } from "../history/semantic-history-unit.js";
import type { ContextPolicy } from "../policy/context-policy.js";

/** Create the pure, deterministic semantic compaction planner. */
export function createContextCompactionPlanner(): ContextCompactionPlanner {
  return Object.freeze({
    plan(input: {
      readonly history: ContextHistoryIndex;
      readonly policy: ContextPolicy;
      readonly reason: ContextCompactionReason;
    }): ContextCompactionPlan | null {
      return planCompaction(input.history, input.policy, input.reason);
    },
  });
}

function planCompaction(
  history: ContextHistoryIndex,
  policy: ContextPolicy,
  reason: ContextCompactionReason,
): ContextCompactionPlan | null {
  const units = canonicalUnits(history.units);
  if (units.length === 0 || history.estimatedTokens <= policy.targetRecentTailTokens) return null;

  const compactablePrefix: ContextHistoryUnit[] = [];
  let sourceTurn = units[0]?.messages[0]?.conversationTurnId;
  for (const unit of units) {
    const firstRef = unit.messages[0];
    if (firstRef === undefined) continue;
    if (unit.status !== "CLOSED" || !unit.compactionEligible) break;
    if (sourceTurn === undefined) sourceTurn = firstRef.conversationTurnId;
    if (firstRef.conversationTurnId !== sourceTurn) break;
    compactablePrefix.push(unit);
  }

  const selected: ContextHistoryUnit[] = [];
  let selectedTokens = 0;
  for (const unit of compactablePrefix) {
    const remainingAfterSelection = history.estimatedTokens - selectedTokens - unit.tokenEstimate;
    if (remainingAfterSelection < policy.minRecentTailTokens) break;
    selected.push(unit);
    selectedTokens += unit.tokenEstimate;
    if (remainingAfterSelection <= policy.targetRecentTailTokens) break;
  }
  if (selected.length === 0) return null;

  const selectedIds = new Set(selected.map((unit) => unit.id));
  const selectedRefs = selected.flatMap((unit) => unit.messages).sort(compareRefs);
  const sourceRange = createRange(selectedRefs);
  if (sourceRange === null) return null;

  return Object.freeze({
    reason,
    sourceRange,
    selectedUnitIds: Object.freeze(selected.map((unit) => unit.id)),
    retainedUnitIds: Object.freeze(
      units.filter((unit) => !selectedIds.has(unit.id)).map((unit) => unit.id),
    ),
    estimatedTokensBefore: history.estimatedTokens,
    selectedTokens,
    targetRecentTailTokens: policy.targetRecentTailTokens,
  });
}

/**
 * A turn and its protocol views overlap in the history index. Prefer the turn view,
 * which already carries the complete conversation boundary, and never double-count the
 * same durable message through a second semantic view.
 */
function canonicalUnits(units: readonly ContextHistoryUnit[]): readonly ContextHistoryUnit[] {
  const ordered = [...units].sort(compareUnits);
  const coveredMessageIds = new Set<string>();
  const result: ContextHistoryUnit[] = [];
  for (const unit of ordered) {
    if (unit.messages.length === 0) continue;
    if (unit.messages.some((message) => coveredMessageIds.has(message.messageId))) continue;
    result.push(unit);
    for (const message of unit.messages) coveredMessageIds.add(message.messageId);
  }
  return result;
}

function createRange(
  refs: readonly ContextHistoryUnit["messages"][number][],
): ContextMessageRange | null {
  const first = refs[0];
  const last = refs[refs.length - 1];
  if (first === undefined || last === undefined) return null;
  if (refs.some((ref) => ref.conversationTurnId !== first.conversationTurnId)) return null;
  if (first.runId !== last.runId) return null;
  return createContextMessageRange({
    runId: first.runId,
    conversationTurnId: first.conversationTurnId,
    firstMessageId: first.messageId,
    lastMessageId: last.messageId,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
  });
}

function compareUnits(left: ContextHistoryUnit, right: ContextHistoryUnit): number {
  return (
    (left.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER) ||
    (left.kind === "CONVERSATION_TURN" ? 0 : 1) - (right.kind === "CONVERSATION_TURN" ? 0 : 1) ||
    compareStrings(left.id, right.id)
  );
}

function compareRefs(
  left: ContextHistoryUnit["messages"][number],
  right: ContextHistoryUnit["messages"][number],
): number {
  return left.sequence - right.sequence || compareStrings(left.messageId, right.messageId);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
