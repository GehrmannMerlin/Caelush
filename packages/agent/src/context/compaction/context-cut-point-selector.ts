import type {
  ContextCompactionCutCandidate,
  ContextCutPointSelector,
  ProtocolSafeSplitCut,
  TurnBoundaryCut,
} from "./context-compaction-cut.js";
import { freezeContextCompactionCutCandidate } from "./context-compaction-cut.js";
import {
  orderContextHistoryUnits,
  type ContextHistoryIndex,
  type ContextHistoryUnit,
  type ToolProtocolUnit,
} from "../history/semantic-history-unit.js";

/** Create the pure, deterministic safe-cut selector for indexed durable history. */
export function createContextCutPointSelector(): ContextCutPointSelector {
  return Object.freeze({
    select(
      input: Parameters<ContextCutPointSelector["select"]>[0],
    ): ContextCompactionCutCandidate | null {
      assertBudget("targetRecentTailTokens", input.targetRecentTailTokens);
      assertBudget("minRecentTailTokens", input.minRecentTailTokens);

      const history = Object.freeze({
        ...input.history,
        units: orderContextHistoryUnits(input.history.units),
      });
      const turns = canonicalTurns(history.units);
      if (turns.length === 0) return null;

      const fullTurnCandidate = selectFullTurnBoundary(
        history,
        turns,
        input.targetRecentTailTokens,
        input.minRecentTailTokens,
      );
      return (
        fullTurnCandidate ??
        selectProtocolSafeSplit(
          history,
          turns,
          input.targetRecentTailTokens,
          input.minRecentTailTokens,
          input.allowCurrentTurnPrefix === true,
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
  allowCurrentTurnPrefix: boolean,
): ContextCompactionCutCandidate | null {
  let best: ContextCompactionCutCandidate | null = null;

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex]!;
    const currentTurnPrefix =
      allowCurrentTurnPrefix && turnIndex === turns.length - 1 && turn.status === "OPEN";
    if (!currentTurnPrefix && (turn.status !== "CLOSED" || !turn.compactionEligible)) continue;
    if (!currentTurnPrefix && turnIndex === turns.length - 1) continue;
    if (
      turns
        .slice(0, turnIndex)
        .some((previous) => previous.status !== "CLOSED" || !previous.compactionEligible)
    ) {
      continue;
    }

    const protocols = protocolsForTurn(history.units, turn);
    if (protocols.length < 2) continue;
    if (currentTurnPrefix) {
      // Keep one recent completed batch and every open call/result obligation in the active input.
      const completed = protocols.filter(
        (unit) => unit.status === "CLOSED" && unit.compactionEligible,
      );
      if (completed.length < 2) continue;
      const firstOpenProtocol = protocols.findIndex(
        (unit) => unit.status !== "CLOSED" || !unit.compactionEligible,
      );
      if (
        firstOpenProtocol >= 0 &&
        protocols
          .slice(firstOpenProtocol)
          .some((unit) => unit.status === "CLOSED" && unit.compactionEligible)
      )
        continue;
      if (
        protocols.some((unit) =>
          unit.messages.some((message) => message.tokenEstimate === undefined),
        )
      )
        continue;
    } else if (protocols.some((unit) => unit.status !== "CLOSED" || !unit.compactionEligible)) {
      continue;
    }
    if (turn.messages.some((message) => message.tokenEstimate === undefined)) continue;

    for (let protocolIndex = 0; protocolIndex < protocols.length - 1; protocolIndex += 1) {
      if (
        currentTurnPrefix &&
        (protocols
          .slice(0, protocolIndex + 1)
          .some((unit) => unit.status !== "CLOSED" || !unit.compactionEligible) ||
          !protocols
            .slice(protocolIndex + 1)
            .some((unit) => unit.status === "CLOSED" && unit.compactionEligible))
      ) {
        continue;
      }
      const firstKeptProtocol = protocols[protocolIndex + 1]!;
      const firstKeptMessage = firstKeptProtocol.messages[0];
      if (firstKeptMessage === undefined) continue;
      if (firstKeptProtocol.messages.some((message) => message.tokenEstimate === undefined))
        continue;

      const firstProtocolMessage = protocols[0]!.messages[0];
      if (firstProtocolMessage === undefined) continue;
      const compactedTokens = currentTurnPrefix
        ? turn.messages
            .filter(
              (message) =>
                message.sequence >= firstProtocolMessage.sequence &&
                message.sequence < firstKeptMessage.sequence,
            )
            .reduce((total, message) => total + (message.tokenEstimate ?? 0), 0)
        : history.estimatedTokens -
          retainedTokensForSplit(turns, turnIndex, firstKeptMessage.sequence);
      const retainedTokens = history.estimatedTokens - compactedTokens;
      if (retainedTokens < minRecentTailTokens) continue;
      const cut: ProtocolSafeSplitCut = {
        kind: "PROTOCOL_SAFE_SPLIT",
        conversationTurnId: firstKeptMessage.conversationTurnId,
        originalUserMessageId: turn.messages[0]?.messageId ?? firstKeptMessage.messageId,
        ...(currentTurnPrefix ? { preserveLeadingMessages: true as const } : {}),
        firstKeptProtocolUnitId: firstKeptProtocol.id,
        firstKeptMessageId: firstKeptMessage.messageId,
        firstKeptSequence: firstKeptMessage.sequence,
      };
      const selectedProtocolIds = protocols.slice(0, protocolIndex + 1).map((unit) => unit.id);
      const candidate = freezeContextCompactionCutCandidate({
        cut,
        compactedUnitIds: currentTurnPrefix
          ? selectedProtocolIds
          : [...turns.slice(0, turnIndex).map((unit) => unit.id), ...selectedProtocolIds],
        retainedUnitIds: currentTurnPrefix
          ? canonicalUnits(history.units)
              .filter((unit) => !selectedProtocolIds.includes(unit.id))
              .map((unit) => unit.id)
          : [
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
  // The history index already follows Snapshot Turn order and each Turn's message sequence.
  // Filtering preserves that authority; a cross-Turn sequence sort would interleave Runs.
  return units.filter(
    (unit): unit is ToolProtocolUnit =>
      unit.kind === "TOOL_PROTOCOL" &&
      unit.messages.length > 0 &&
      unit.messages.every(
        (message) =>
          message.runId === turn.messages[0]?.runId &&
          message.conversationTurnId === turn.messages[0]?.conversationTurnId,
      ),
  );
}

function canonicalTurns(units: readonly ContextHistoryUnit[]): readonly ContextHistoryUnit[] {
  return units.filter((unit) => unit.kind === "CONVERSATION_TURN" && unit.messages.length > 0);
}

function canonicalUnits(units: readonly ContextHistoryUnit[]): readonly ContextHistoryUnit[] {
  const ordered = units.filter((unit) => unit.messages.length > 0);
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

function assertBudget(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}
