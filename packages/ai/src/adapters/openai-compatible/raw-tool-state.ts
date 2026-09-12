/**
 * Observations taken directly from the raw provider chunks.
 *
 * The AI SDK normalises a provider stream into typed parts, but two facts only
 * exist in the raw chunks and both matter:
 *
 * 1. **Tool-call identity ambiguity.** An OpenAI-compatible server may stream a
 *    tool-call delta with neither an `id` nor an `index`. That is only safe while
 *    exactly one tool call is known. Once several are open the delta cannot be
 *    attributed, and guessing (a "latest tool call" heuristic) would silently
 *    merge two calls. It fails closed instead.
 * 2. **The provider-native finish reason.** The SDK maps an unrecognised reason to
 *    a generic value, so the original string is read from the raw chunk and
 *    reported as `providerReason`, which is what keeps `OTHER` lossless.
 */

/** Raw-chunk observations for one provider turn. */
export interface RawStreamState {
  /** All distinct tool-call ids observed in raw chunks. */
  readonly ids: Set<string>;
  /** All distinct tool-call indexes observed in raw chunks. */
  readonly indexes: Set<number>;
  /** The last provider-native finish reason, when the provider supplied one. */
  nativeFinishReason(): string | undefined;
  /** Record a provider-native finish reason. Called only by the adapter. */
  observeFinishReason(reason: string): void;
}

/** Create the per-turn raw observation state. */
export function createRawStreamState(): RawStreamState {
  const ids = new Set<string>();
  const indexes = new Set<number>();
  let nativeFinishReason: string | undefined;

  return {
    ids,
    indexes,
    nativeFinishReason: () => nativeFinishReason,
    observeFinishReason: (reason) => {
      nativeFinishReason = reason;
    },
  };
}

/**
 * Reject an ambiguous tool-call delta.
 *
 * Throws a plain `Error`; the adapter converts it into the frozen
 * `AI_INVALID_RESPONSE` failure so the raw-chunk rule stays independent of the
 * error model.
 */
export function assertRawToolCallIdentity(rawValue: unknown, state: RawStreamState): void {
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

/** Capture the provider-native finish reason from a raw chunk. */
export function observeRawFinishReason(rawValue: unknown, state: RawStreamState): void {
  if (!isRecord(rawValue)) return;
  const choices = rawValue.choices;
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const reason = choice.finish_reason;
    if (typeof reason === "string" && reason.length > 0) state.observeFinishReason(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
