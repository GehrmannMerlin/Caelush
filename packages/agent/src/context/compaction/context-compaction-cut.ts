import type { AgentMessageId, ConversationTurnId } from "../../messages/types/ids.js";
import type { ContextHistoryIndex } from "../history/semantic-history-unit.js";

export type ContextCompactionCutKind = "TURN_BOUNDARY" | "PROTOCOL_SAFE_SPLIT";

export interface TurnBoundaryCut {
  readonly kind: "TURN_BOUNDARY";
  readonly firstKeptTurnId: ConversationTurnId;
  readonly firstKeptMessageId: AgentMessageId;
  readonly firstKeptSequence: number;
}

export interface ProtocolSafeSplitCut {
  readonly kind: "PROTOCOL_SAFE_SPLIT";
  readonly conversationTurnId: ConversationTurnId;
  readonly originalUserMessageId: AgentMessageId;
  /** Current-turn working set cuts preserve all leading user authority messages byte-for-byte. */
  readonly preserveLeadingMessages?: true;
  readonly firstKeptProtocolUnitId: string;
  readonly firstKeptMessageId: AgentMessageId;
  readonly firstKeptSequence: number;
}

export type ContextCompactionCut = TurnBoundaryCut | ProtocolSafeSplitCut;

export interface ContextCompactionCutCandidate {
  readonly cut: ContextCompactionCut;
  readonly compactedUnitIds: readonly string[];
  readonly retainedUnitIds: readonly string[];
  readonly compactedTokens: number;
  readonly retainedTokens: number;
}

export interface ContextCutPointSelector {
  select(input: {
    readonly history: ContextHistoryIndex;
    readonly targetRecentTailTokens: number;
    readonly minRecentTailTokens: number;
    readonly allowCurrentTurnPrefix?: boolean;
  }): ContextCompactionCutCandidate | null;
}

export function freezeContextCompactionCutCandidate(
  candidate: ContextCompactionCutCandidate,
): ContextCompactionCutCandidate {
  return Object.freeze({
    ...candidate,
    cut: Object.freeze({ ...candidate.cut }),
    compactedUnitIds: Object.freeze([...candidate.compactedUnitIds]),
    retainedUnitIds: Object.freeze([...candidate.retainedUnitIds]),
  });
}
