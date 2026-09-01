import type { LLMMessage } from "@caelush/llm/messages";

export function buildRunExecutionHistory(input: {
  readonly historyPrefix?: readonly LLMMessage[];
  readonly durableConversation: readonly LLMMessage[];
  readonly mode: "RUN" | "RESUME_WITH_TOOL_RESULTS";
}): readonly LLMMessage[] {
  const currentRunHistory =
    input.mode === "RESUME_WITH_TOOL_RESULTS"
      ? input.durableConversation
      : input.durableConversation.slice(0, findCurrentTurnStart(input.durableConversation));
  return [...(input.historyPrefix ?? []), ...currentRunHistory];
}

function findCurrentTurnStart(messages: readonly LLMMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return messages.length;
}
