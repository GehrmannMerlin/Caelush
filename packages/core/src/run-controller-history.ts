import type { AIMessage } from "@caelush/ai";

export function buildRunExecutionHistory(input: {
  readonly historyPrefix?: readonly AIMessage[];
  readonly durableConversation: readonly AIMessage[];
  readonly mode: "RUN" | "RESUME_WITH_TOOL_RESULTS";
}): readonly AIMessage[] {
  const currentRunHistory =
    input.mode === "RESUME_WITH_TOOL_RESULTS"
      ? input.durableConversation
      : input.durableConversation.slice(0, findCurrentTurnStart(input.durableConversation));
  return [...(input.historyPrefix ?? []), ...currentRunHistory];
}

/**
 * Returns durable agent_messages.sequence values aligned with the history used
 * by the AgentLoop. Synthetic history prefixes deliberately disable this
 * mapping; callers then retain the explicit LOCAL_HISTORY_INDEX semantics.
 */
export function buildRunExecutionHistorySourceSequences(input: {
  readonly historyPrefix?: readonly AIMessage[];
  readonly durableConversation: readonly {
    readonly message: AIMessage;
    readonly sequence: number;
  }[];
  readonly mode: "RUN" | "RESUME_WITH_TOOL_RESULTS";
}): readonly number[] | undefined {
  if (input.historyPrefix !== undefined && input.historyPrefix.length > 0) return undefined;
  const messages = input.durableConversation.map((entry) => entry.message);
  const currentRun =
    input.mode === "RESUME_WITH_TOOL_RESULTS"
      ? input.durableConversation
      : input.durableConversation.slice(0, findCurrentTurnStart(messages));
  return currentRun.map((entry) => entry.sequence);
}

function findCurrentTurnStart(messages: readonly AIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return messages.length;
}
