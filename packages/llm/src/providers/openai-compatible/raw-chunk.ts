interface RawToolCallState {
  readonly ids: Set<string>;
  readonly indexes: Set<number>;
}

export function createRawToolCallState(): RawToolCallState {
  return { ids: new Set(), indexes: new Set() };
}

export function assertRawToolCallIdentity(rawValue: unknown, state: RawToolCallState): void {
  if (!isRecord(rawValue)) return;
  const choices = rawValue.choices;
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    const toolCalls = choice.delta.tool_calls;
    if (!Array.isArray(toolCalls)) continue;

    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue;
      if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
        if (toolCall.id.trim().length === 0) {
          throw new Error("OpenAI-compatible stream contained a whitespace tool-call id.");
        }
        state.ids.add(toolCall.id);
      }
      if (typeof toolCall.index === "number" && Number.isInteger(toolCall.index)) {
        state.indexes.add(toolCall.index);
      }
      if (toolCall.id === undefined && toolCall.index === undefined) {
        if (state.ids.size > 1 || state.indexes.size > 1) {
          throw new Error(
            "OpenAI-compatible stream contained an ambiguous tool-call delta without id or index.",
          );
        }
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
