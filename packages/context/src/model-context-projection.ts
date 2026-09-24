import type { AIMessage } from "@caelush/ai";
import { buildExecutionUnits, selectSafeExecutionUnits } from "./execution-unit.js";
import { estimateAIMessage } from "./conversation-history.js";
import type { TokenEstimator } from "./token-estimator.js";
import type { ContextItem } from "./context-item.js";

export interface ModelContextProjectionInput {
  readonly goal: string;
  readonly durableHistory: readonly AIMessage[];
  readonly recentTail?: readonly AIMessage[];
  readonly maxRecentTailTokens: number;
  readonly checkpointMessages?: readonly AIMessage[];
  readonly openProtocolUnit?: readonly AIMessage[];
  readonly memoryItems?: readonly ContextItem[];
  readonly maxMemoryContextTokens?: number;
  readonly estimator: TokenEstimator;
}

export interface ModelContextProjection {
  readonly messages: readonly AIMessage[];
  readonly durableHistoryMessageCount: number;
  readonly retainedMessageCount: number;
  readonly droppedMessageCount: number;
  readonly estimatedTokens: number;
}

export function buildModelContextProjection(
  input: ModelContextProjectionInput,
): ModelContextProjection {
  if (input.goal.length === 0) throw new RangeError("Model projection requires a goal");
  if (!Number.isSafeInteger(input.maxRecentTailTokens) || input.maxRecentTailTokens < 0) {
    throw new RangeError("maxRecentTailTokens must be a non-negative safe integer");
  }
  const tail = input.recentTail ?? input.durableHistory;
  const units = buildExecutionUnits(tail, {
    runId: "projection",
    createdAt: 0,
    estimateText: input.estimator.estimateText,
  });
  const selected = selectSafeExecutionUnits(units, input.maxRecentTailTokens);
  const tailMessages = selected.flatMap((unit) =>
    tail.slice(unit.sourceSequenceFrom, unit.sourceSequenceTo + 1),
  );
  const messages: AIMessage[] = [
    { role: "user", content: input.goal },
    ...(input.checkpointMessages ?? []),
    ...tailMessages,
    ...selectMemoryMessages(input.memoryItems ?? [], input.maxMemoryContextTokens ?? 0),
    ...(input.openProtocolUnit ?? []),
  ];
  return {
    messages,
    durableHistoryMessageCount: input.durableHistory.length,
    retainedMessageCount: messages.length,
    droppedMessageCount: Math.max(0, input.durableHistory.length - tailMessages.length),
    estimatedTokens: messages.reduce(
      (total, message) => total + estimateAIMessage(message, input.estimator),
      0,
    ),
  };
}

function selectMemoryMessages(
  items: readonly ContextItem[],
  maxTokens: number,
): readonly AIMessage[] {
  if (maxTokens <= 0) return [];
  let used = 0;
  const messages: AIMessage[] = [];
  for (const item of items) {
    if (item.content === undefined || used + item.tokenEstimate > maxTokens) continue;
    messages.push({ role: "user", content: `[memory:${item.sourceRef}]\n${item.content}` });
    used += item.tokenEstimate;
  }
  return messages;
}
