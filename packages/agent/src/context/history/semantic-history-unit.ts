import type { ModelDescriptor } from "@caelush/ai";
import type { RunId } from "@caelush/protocol";

import type { AgentConversationSnapshot } from "../../messages/conversation/conversation-snapshot.js";
import type { ConversationTurn } from "../../messages/conversation/conversation-turn.js";
import { assistantToolCalls } from "../../messages/types/content.js";
import type { AgentMessageId, ConversationTurnId } from "../../messages/types/ids.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import { createAgentConversationValidator } from "../../messages/conversation/validator.js";
import { createUtf8HeuristicTokenEstimator } from "../token/context-token-estimator.js";

export interface ContextMessageRef {
  readonly messageId: AgentMessageId;
  readonly runId: RunId;
  readonly conversationTurnId: ConversationTurnId;
  readonly sequence: number;
}

export type ContextHistoryUnitStatus = "OPEN" | "CLOSED";
export type ContextHistoryUnitKind = "CONVERSATION_TURN" | "TOOL_PROTOCOL";

export interface ContextHistoryUnit {
  readonly id: string;
  readonly kind: ContextHistoryUnitKind;
  readonly status: ContextHistoryUnitStatus;
  readonly messages: readonly ContextMessageRef[];
  readonly tokenEstimate: number;
  readonly atomicGroupId: string;
  readonly compactionEligible: boolean;
}

export interface ToolProtocolUnit extends ContextHistoryUnit {
  readonly kind: "TOOL_PROTOCOL";
  readonly sourceAssistantMessageId: AgentMessageId;
  readonly toolCallIds: readonly string[];
  readonly toolResultMessageIds: readonly AgentMessageId[];
}

export interface ContextHistoryIndex {
  readonly units: readonly ContextHistoryUnit[];
  readonly openUnits: readonly ContextHistoryUnit[];
  readonly closedUnits: readonly ContextHistoryUnit[];
  readonly estimatedTokens: number;
}

export interface ContextHistoryIndexer {
  index(input: {
    readonly conversation: AgentConversationSnapshot;
    readonly model: ModelDescriptor;
  }): ContextHistoryIndex;
}

/**
 * Build the Context-level semantic history view from the Message Domain snapshot.
 *
 * Conversation turns and Tool protocol units intentionally coexist in the index: a turn is
 * the user-interaction boundary while a Tool protocol unit is the smaller call/result
 * atomicity boundary used by planning. `estimatedTokens` counts each durable message once,
 * even though a Tool protocol unit is also visible through its containing turn.
 */
export function createContextHistoryIndexer(): ContextHistoryIndexer {
  return Object.freeze({
    index(input: {
      readonly conversation: AgentConversationSnapshot;
      readonly model: ModelDescriptor;
    }): ContextHistoryIndex {
      createAgentConversationValidator().validate(input.conversation);
      return indexConversation(input.conversation, input.model);
    },
  });
}

function indexConversation(
  conversation: AgentConversationSnapshot,
  model: ModelDescriptor,
): ContextHistoryIndex {
  const estimator = createUtf8HeuristicTokenEstimator();
  const units: ContextHistoryUnit[] = [];
  const allVisible = new Map<string, StoredAgentMessage>();

  for (const turn of conversation.turns) {
    const visible = turn.messages.filter((stored) => stored.message.audience.model);
    for (const stored of visible) allVisible.set(stored.message.id, stored);
    if (visible.length > 0) units.push(createConversationTurnUnit(turn, visible, model, estimator));
    units.push(...createToolProtocolUnits(turn, visible, model, estimator));
  }

  const ordered = units.sort(compareUnits);
  const frozenUnits = ordered.map(freezeUnit);
  const openUnits = frozenUnits.filter((unit) => unit.status === "OPEN");
  const closedUnits = frozenUnits.filter((unit) => unit.status === "CLOSED");
  const estimatedTokens = [...allVisible.values()].reduce(
    (total, stored) => total + estimator.estimateAgentMessage(stored.message, model),
    0,
  );

  return Object.freeze({
    units: Object.freeze(frozenUnits),
    openUnits: Object.freeze(openUnits),
    closedUnits: Object.freeze(closedUnits),
    estimatedTokens,
  });
}

function createConversationTurnUnit(
  turn: ConversationTurn,
  messages: readonly StoredAgentMessage[],
  model: ModelDescriptor,
  estimator: ReturnType<typeof createUtf8HeuristicTokenEstimator>,
): ContextHistoryUnit {
  return {
    id: `conversation:${turn.id}`,
    kind: "CONVERSATION_TURN",
    status: turn.status,
    messages: messages.map(toMessageRef),
    tokenEstimate: messages.reduce(
      (total, stored) => total + estimator.estimateAgentMessage(stored.message, model),
      0,
    ),
    atomicGroupId: turn.id,
    compactionEligible: turn.status === "CLOSED",
  };
}

function createToolProtocolUnits(
  turn: ConversationTurn,
  messages: readonly StoredAgentMessage[],
  model: ModelDescriptor,
  estimator: ReturnType<typeof createUtf8HeuristicTokenEstimator>,
): readonly ToolProtocolUnit[] {
  const units: ToolProtocolUnit[] = [];
  for (const stored of turn.messages) {
    const message = stored.message;
    if (!message.audience.model || message.type !== "ASSISTANT") continue;
    const calls = assistantToolCalls(message.content);
    if (calls.length === 0) continue;

    const callIds = calls.map((call) => call.toolCallId);
    const results = new Map<string, StoredAgentMessage>();
    for (const candidate of messagesAfter(
      messages,
      messages.findIndex((entry) => entry === stored),
    )) {
      if (candidate.message.type !== "TOOL_RESULT") continue;
      if (!callIds.includes(candidate.message.toolCallId)) continue;
      if (!results.has(candidate.message.toolCallId))
        results.set(candidate.message.toolCallId, candidate);
      if (results.size === callIds.length) break;
    }

    const resultMessageIds = new Set(
      [...results.values()].map((candidate) => candidate.message.id),
    );
    const members = [
      stored,
      ...turn.messages.filter((candidate) => resultMessageIds.has(candidate.message.id)),
    ].sort((left, right) => left.sequence - right.sequence);
    const resultIds = calls
      .map((call) => results.get(call.toolCallId)?.message.id)
      .filter((id): id is AgentMessageId => id !== undefined);
    const closed = resultIds.length === callIds.length;
    const refs = members.map(toMessageRef);
    const tokenEstimate = members.reduce(
      (total, member) => total + estimator.estimateAgentMessage(member.message, model),
      0,
    );

    units.push({
      id: `tool-protocol:${message.id}`,
      kind: "TOOL_PROTOCOL",
      status: closed ? "CLOSED" : "OPEN",
      messages: refs,
      tokenEstimate,
      atomicGroupId: `tool-protocol:${message.id}`,
      compactionEligible: closed,
      sourceAssistantMessageId: message.id,
      toolCallIds: callIds,
      toolResultMessageIds: resultIds,
    });
  }
  return units;
}

function messagesAfter(
  messages: readonly StoredAgentMessage[],
  index: number,
): readonly StoredAgentMessage[] {
  return index < 0 ? [] : messages.slice(index + 1);
}

function toMessageRef(stored: StoredAgentMessage): ContextMessageRef {
  const message = stored.message;
  return Object.freeze({
    messageId: message.id,
    runId: message.runId,
    conversationTurnId: message.conversationTurnId,
    sequence: stored.sequence,
  });
}

function compareUnits(left: ContextHistoryUnit, right: ContextHistoryUnit): number {
  const leftSequence = left.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
  return (
    leftSequence - rightSequence ||
    unitKindRank(left.kind) - unitKindRank(right.kind) ||
    compareStrings(left.id, right.id)
  );
}

function unitKindRank(kind: ContextHistoryUnitKind): number {
  return kind === "CONVERSATION_TURN" ? 0 : 1;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeUnit(unit: ContextHistoryUnit): ContextHistoryUnit {
  if (unit.kind === "TOOL_PROTOCOL") {
    const protocol = unit as ToolProtocolUnit;
    return Object.freeze({
      ...unit,
      messages: Object.freeze([...unit.messages]),
      toolCallIds: Object.freeze([...protocol.toolCallIds]),
      toolResultMessageIds: Object.freeze([...protocol.toolResultMessageIds]),
    });
  }
  return Object.freeze({ ...unit, messages: Object.freeze([...unit.messages]) });
}
