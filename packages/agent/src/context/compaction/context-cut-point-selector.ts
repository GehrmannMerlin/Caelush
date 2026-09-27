import type {
  ContextCompactionCutCandidate,
  ContextCutPointSelector,
  ProtocolSafeSplitCut,
  TurnBoundaryCut,
} from "./context-compaction-cut.js";
import { freezeContextCompactionCutCandidate } from "./context-compaction-cut.js";
import type {
  ContextHistoryIndex,
  ContextHistoryUnit,
  ToolProtocolUnit,
} from "../history/semantic-history-unit.js";

/** Create the pure, deterministic safe-cut selector for indexed durable history. */
export function createContextCutPointSelector(): ContextCutPointSelector {
  return Object.freeze({
    select(
      input: Parameters<ContextCutPointSelector["select"]>[0],
    ): ContextCompactionCutCandidate | null {
      assertBudget("targetRecentTailTokens", input.targetRecentTailTokens);
      assertBudget("minRecentTailTokens", input.minRecentTailTokens);

      const turns = canonicalTurns(input.history.units);
      if (turns.length < 2) return null;

      const fullTurnCandidate = selectFullTurnBoundary(
        input.history,
        turns,
        input.targetRecentTailTokens,
        input.minRecentTailTokens,
      );
      return (
        fullTurnCandidate ??
        selectProtocolSafeSplit(
          input.history,
          turns,
          input.targetRecentTailTokens,
          input.minRecentTailTokens,
        )
      );
    },
  });
}

function selectFullTurnBoundary(
  history: ContextHistoryIndex,
  turns: readonly ContextHistoryUnit[],
  targetRecentTailTokens: number,
  minRecentTailTokens: number,
): ContextCompactionCutCandidate | null {
  const totalTokens = history.estimatedTokens;
  const canonical = canonicalUnits(history.units);
  let compacted: ContextHistoryUnit[] = [];
  let compactedTokens = 0;
  let best: ContextCompactionCutCandidate | null = null;

  // The newest primary Turn is the current Turn and remains protected from ordinary cuts.
  for (let index = 0; index < turns.length - 1; index += 1) {
    const turn = turns[index]!;
    if (turn.status !== "CLOSED" || !turn.compactionEligible) break;
    compacted = [...compacted, turn];
    compactedTokens += turn.tokenEstimate;

    const retained = turns.slice(index + 1);
    const retainedTokens = totalTokens - compactedTokens;
    if (retainedTokens < minRecentTailTokens) continue;
    const firstKept = retained[0]?.messages[0];
    if (firstKept === undefined) continue;

    const cut: TurnBoundaryCut = {
      kind: "TURN_BOUNDARY",
      firstKeptTurnId: firstKept.conversationTurnId,
      firstKeptMessageId: firstKept.messageId,
      firstKeptSequence: firstKept.sequence,
    };
    const candidate = freezeContextCompactionCutCandidate({
      cut,
      compactedUnitIds: compacted.map((unit) => unit.id),
      retainedUnitIds: canonical
        .filter((unit) => !compacted.some((selected) => selected.id === unit.id))
        .map((unit) => unit.id),
      compactedTokens,
      retainedTokens,
    });
    if (isBetterCandidate(candidate, best, targetRecentTailTokens)) best = candidate;
  }

  return best;
}

function selectProtocolSafeSplit(
  history: ContextHistoryIndex,
  turns: readonly ContextHistoryUnit[],
  targetRecentTailTokens: number,
  minRecentTailTokens: number,
): ContextCompactionCutCandidate | null {
  let best: ContextCompactionCutCandidate | null = null;

  for (let turnIndex = 0; turnIndex < turns.length - 1; turnIndex += 1) {
    const turn = turns[turnIndex]!;
    if (turn.status !== "CLOSED" || !turn.compactionEligible) continue;
    if (
      turns
        .slice(0, turnIndex)
        .some((previous) => previous.status !== "CLOSED" || !previous.compactionEligible)
    ) {
      continue;
    }

    const protocols = protocolsForTurn(history.units, turn);
    if (
      protocols.length < 2 ||
      protocols.some((unit) => unit.status !== "CLOSED" || !unit.compactionEligible)
    ) {
      continue;
    }
    if (turn.messages.some((message) => message.tokenEstimate === undefined)) continue;

    for (let protocolIndex = 0; protocolIndex < protocols.length - 1; protocolIndex += 1) {
      const firstKeptProtocol = protocols[protocolIndex + 1]!;
      const firstKeptMessage = firstKeptProtocol.messages[0];
      if (firstKeptMessage === undefined) continue;
      if (firstKeptProtocol.messages.some((message) => message.tokenEstimate === undefined))
        continue;

      const retainedTokens = retainedTokensForSplit(turns, turnIndex, firstKeptMessage.sequence);
      if (retainedTokens < minRecentTailTokens) continue;
      const compactedTokens = history.estimatedTokens - retainedTokens;
      const cut: ProtocolSafeSplitCut = {
        kind: "PROTOCOL_SAFE_SPLIT",
        conversationTurnId: firstKeptMessage.conversationTurnId,
        originalUserMessageId: turn.messages[0]?.messageId ?? firstKeptMessage.messageId,
        firstKeptProtocolUnitId: firstKeptProtocol.id,
        firstKeptMessageId: firstKeptMessage.messageId,
        firstKeptSequence: firstKeptMessage.sequence,
      };
      const candidate = freezeContextCompactionCutCandidate({
        cut,
        compactedUnitIds: [
          ...turns.slice(0, turnIndex).map((unit) => unit.id),
          ...protocols.slice(0, protocolIndex + 1).map((unit) => unit.id),
        ],
        retainedUnitIds: [
          ...protocols.slice(protocolIndex + 1).map((unit) => unit.id),
          ...turns.slice(turnIndex + 1).map((unit) => unit.id),
        ],
        compactedTokens,
        retainedTokens,
      });
      if (isBetterCandidate(candidate, best, targetRecentTailTokens)) best = candidate;
    }
  }

  return best;
}

function retainedTokensForSplit(
  turns: readonly ContextHistoryUnit[],
  splitTurnIndex: number,
  firstKeptSequence: number,
): number {
  let total = 0;
  for (let index = splitTurnIndex; index < turns.length; index += 1) {
    const turn = turns[index]!;
    for (const message of turn.messages) {
      if (index !== splitTurnIndex || message.sequence >= firstKeptSequence) {
        total += message.tokenEstimate ?? 0;
      }
    }
  }
  return total;
}

function protocolsForTurn(
  units: readonly ContextHistoryUnit[],
  turn: ContextHistoryUnit,
): readonly ToolProtocolUnit[] {
  return units
    .filter(
      (unit): unit is ToolProtocolUnit =>
        unit.kind === "TOOL_PROTOCOL" &&
        unit.messages.length > 0 &&
        unit.messages.every(
          (message) => message.conversationTurnId === turn.messages[0]?.conversationTurnId,
        ),
    )
    .sort(compareUnits);
}

function canonicalTurns(units: readonly ContextHistoryUnit[]): readonly ContextHistoryUnit[] {
  return units
    .filter((unit) => unit.kind === "CONVERSATION_TURN" && unit.messages.length > 0)
    .sort(compareUnits);
}

function canonicalUnits(units: readonly ContextHistoryUnit[]): readonly ContextHistoryUnit[] {
  const ordered = [...units].filter((unit) => unit.messages.length > 0).sort(compareUnits);
  const coveredMessageIds = new Set<string>();
  const result: ContextHistoryUnit[] = [];
  for (const unit of ordered) {
    if (unit.messages.some((message) => coveredMessageIds.has(message.messageId))) continue;
    result.push(unit);
    for (const message of unit.messages) coveredMessageIds.add(message.messageId);
  }
  return result;
}

function isBetterCandidate(
  candidate: ContextCompactionCutCandidate,
  current: ContextCompactionCutCandidate | null,
  targetRecentTailTokens: number,
): boolean {
  if (current === null) return true;
  const candidateDistance = Math.abs(candidate.retainedTokens - targetRecentTailTokens);
  const currentDistance = Math.abs(current.retainedTokens - targetRecentTailTokens);
  return (
    candidateDistance < currentDistance ||
    (candidateDistance === currentDistance && candidate.retainedTokens > current.retainedTokens)
  );
}

function compareUnits(left: ContextHistoryUnit, right: ContextHistoryUnit): number {
  return (
    (left.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER) ||
    (left.kind === "CONVERSATION_TURN" ? 0 : 1) - (right.kind === "CONVERSATION_TURN" ? 0 : 1) ||
    compareStrings(left.id, right.id)
  );
}

function assertBudget(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
