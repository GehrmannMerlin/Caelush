import {
  LLMMessageSchema,
  type LLMAssistantMessage,
  type LLMMessage,
} from "@caelush/llm/messages";
import { ContextConversationError } from "./errors.js";
import type { ContextConversationReport } from "./context-build-report.js";
import type { TokenEstimator } from "./token-estimator.js";

export interface ConversationTurnGroup {
  readonly messages: readonly LLMMessage[];
  readonly estimatedTokens: number;
}

export interface ValidatedConversation {
  readonly groups: readonly ConversationTurnGroup[];
  readonly estimatedTokens: number;
}

export interface SelectedConversation extends ContextConversationReport {
  readonly messages: readonly LLMMessage[];
}

function invalidHistory(): ContextConversationError {
  return new ContextConversationError("conversation history contains an invalid message");
}

function assistantToolCalls(message: LLMAssistantMessage): readonly { id: string; name: string }[] {
  return message.content.flatMap((part) =>
    part.type === "tool-call" ? [{ id: part.toolCallId, name: part.toolName }] : [],
  );
}

export function estimateLLMMessage(message: LLMMessage, estimator: TokenEstimator): number {
  return estimator.estimateText(JSON.stringify(message));
}

export function validateAndGroupConversation(
  messages: readonly LLMMessage[],
  estimator: TokenEstimator,
): ValidatedConversation {
  const groups: ConversationTurnGroup[] = [];
  let current: LLMMessage[] = [];
  let pendingTools = new Map<string, string>();
  let completedTools = new Set<string>();

  const closeGroup = (): void => {
    if (current.length === 0) return;
    groups.push({
      messages: current,
      estimatedTokens: current.reduce(
        (total, message) => total + estimateLLMMessage(message, estimator),
        0,
      ),
    });
    current = [];
    pendingTools = new Map<string, string>();
    completedTools = new Set<string>();
  };

  for (const message of messages) {
    const parsed = LLMMessageSchema.safeParse(message);
    if (!parsed.success) throw invalidHistory();
    if (message.role === "system") throw new ContextConversationError("system messages are not allowed in conversation history");
    if (message.role === "user") {
      if (pendingTools.size > 0) throw new ContextConversationError("conversation history has a missing tool result");
      closeGroup();
      current.push(message);
      continue;
    }
    if (message.role === "assistant") {
      for (const call of assistantToolCalls(message)) {
        if (pendingTools.has(call.id) || completedTools.has(call.id)) {
          throw new ContextConversationError("conversation history has a duplicate tool call");
        }
        pendingTools.set(call.id, call.name);
      }
      current.push(message);
      continue;
    }
    const expectedName = pendingTools.get(message.toolCallId);
    if (expectedName === undefined) {
      throw new ContextConversationError("conversation history has an orphan tool result");
    }
    if (expectedName !== message.toolName) {
      throw new ContextConversationError("conversation history has a mismatched tool name");
    }
    pendingTools.delete(message.toolCallId);
    completedTools.add(message.toolCallId);
    current.push(message);
  }
  if (pendingTools.size > 0) {
    throw new ContextConversationError("conversation history has a missing tool result");
  }
  closeGroup();
  return {
    groups,
    estimatedTokens: groups.reduce((total, group) => total + group.estimatedTokens, 0),
  };
}

export function selectRecentConversation(
  groups: readonly ConversationTurnGroup[],
  maxTokens: number,
): SelectedConversation {
  let used = 0;
  let firstSelected = groups.length;
  let latestTurnTooLarge = false;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group === undefined || used + group.estimatedTokens > maxTokens) {
      if (index === groups.length - 1 && group !== undefined) latestTurnTooLarge = true;
      break;
    }
    used += group.estimatedTokens;
    firstSelected = index;
  }
  const selectedGroups = groups.slice(firstSelected);
  const selectedMessages = selectedGroups.flatMap((group) => group.messages);
  const droppedTurns = firstSelected;
  const selectedTurns = selectedGroups.length;
  return {
    messages: selectedMessages,
    providedMessages: groups.reduce((total, group) => total + group.messages.length, 0),
    selectedMessages: selectedMessages.length,
    droppedMessages:
      groups.slice(0, firstSelected).reduce((total, group) => total + group.messages.length, 0),
    providedTurns: groups.length,
    selectedTurns,
    droppedTurns,
    estimatedTokensUsed: used,
    requiresCompaction: droppedTurns > 0,
    latestTurnTooLarge,
  };
}
