import type { AIMessage, AIToolResultMessage } from "@caelush/ai";

/**
 * Deterministic pruning of settled Tool results in the model-visible Context.
 *
 * ```text
 * a Tool result from the current turn      untouched
 * a settled Tool result over the budget    head + marker + tail
 * the durable record                       untouched
 * ```
 *
 * ## Why this exists
 *
 * A coding Run accumulates Tool output: file reads, search hits, command logs. The Context Engine can
 * compact a *conversation* (summarize it with a model), but that is slow, lossy and expensive. Most of
 * the growth is one kind of data — a bounded preview of what a Tool produced — and it can be reduced
 * with no model call at all.
 *
 * This is not compaction and it does not replace it:
 *
 * ```text
 * pruning      removes predictable bytes from tool output, deterministically, every turn
 * compaction   rewrites the conversation when the budget is genuinely running out
 * ```
 *
 * ## What it deliberately does not do
 *
 * ```text
 * never mutates a stored message     the projection is rebuilt from durable truth every turn
 * never touches the current turn     the model is still working with those results
 * never touches a non-text part      an image part inside a result is left exactly as it is
 * never prunes twice                 the marker makes a second pass a no-op
 * ```
 *
 * The marker is byte-counted and stable, so two hosts pruning the same history produce the same
 * Context. That property is what keeps prompt-prefix caching honest.
 */
export interface ToolResultPruningPolicy {
  /** A settled Tool result above this many UTF-8 bytes is pruned. */
  readonly maxBytes: number;
  /** Bytes kept from the start of the result. */
  readonly headBytes: number;
  /** Bytes kept from the end of the result. */
  readonly tailBytes: number;
}

export const DEFAULT_TOOL_RESULT_PRUNING: ToolResultPruningPolicy = Object.freeze({
  maxBytes: 8 * 1024,
  headBytes: 2 * 1024,
  tailBytes: 2 * 1024,
});

/** Prefix of the omission marker; also the idempotency guard. */
export const PRUNED_TOOL_RESULT_PREFIX = "[... ";

export function omissionMarker(omittedBytes: number): string {
  return `\n\n${PRUNED_TOOL_RESULT_PREFIX}${String(omittedBytes)} bytes omitted by Caelush context pruning ...]\n\n`;
}

export interface ToolResultPruningStats {
  readonly prunedMessages: number;
  readonly omittedBytes: number;
}

export function assertToolResultPruningPolicy(policy: ToolResultPruningPolicy): void {
  const bounds = [policy.maxBytes, policy.headBytes, policy.tailBytes];
  if (bounds.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError("Tool result pruning bounds must be safe positive integers.");
  }
  if (policy.headBytes + policy.tailBytes >= policy.maxBytes) {
    throw new RangeError("Tool result pruning must leave room for the omission marker.");
  }
}

/**
 * Prune one settled Tool result message.
 *
 * Returns the same message reference when nothing was pruned, so a caller can compare identity
 * instead of deep-equality. Only a string body or an all-text part list is touched: a result that
 * carries an image part is left alone, because bounding it would mean deciding what to do with the
 * image.
 */
export function pruneSettledToolResult(
  message: AIMessage,
  policy: ToolResultPruningPolicy,
): { readonly message: AIMessage; readonly omittedBytes: number } {
  if (message.role !== "tool") return { message, omittedBytes: 0 };
  const toolMessage = message as AIToolResultMessage;

  if (typeof toolMessage.content === "string") {
    const bounded = boundText(toolMessage.content, policy);
    return bounded === undefined
      ? { message, omittedBytes: 0 }
      : {
          message: { ...toolMessage, content: bounded.text },
          omittedBytes: bounded.omittedBytes,
        };
  }

  const parts = toolMessage.content;
  if (!parts.every((part) => part.type === "text")) return { message, omittedBytes: 0 };

  let omitted = 0;
  let changed = false;
  const nextParts = parts.map((part) => {
    const bounded = boundText((part as { readonly text: string }).text, policy);
    if (bounded === undefined) return part;
    changed = true;
    omitted += bounded.omittedBytes;
    return { ...part, text: bounded.text };
  });
  if (!changed) return { message, omittedBytes: 0 };
  return { message: { ...toolMessage, content: nextParts }, omittedBytes: omitted };
}

/** Narrow a text body to the policy, or report that it is already bounded. */
function boundText(
  text: string,
  policy: ToolResultPruningPolicy,
): { readonly text: string; readonly omittedBytes: number } | undefined {
  if (text.includes(PRUNED_TOOL_RESULT_PREFIX)) return undefined;
  const total = Buffer.byteLength(text, "utf8");
  if (total <= policy.maxBytes) return undefined;
  const head = takeUtf8Prefix(text, policy.headBytes);
  const tail = takeUtf8Suffix(text, policy.tailBytes);
  const omitted = total - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  if (omitted <= 0) return undefined;
  return { text: `${head}${omissionMarker(omitted)}${tail}`, omittedBytes: omitted };
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    bytes += width;
    index += character.length;
  }
  return text.slice(0, index);
}

function takeUtf8Suffix(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = text.length;
  while (index > 0) {
    let start = index - 1;
    const lastUnit = text.charCodeAt(start);
    const previousUnit = start > 0 ? text.charCodeAt(start - 1) : 0;
    if (
      lastUnit >= 0xdc00 &&
      lastUnit <= 0xdfff &&
      previousUnit >= 0xd800 &&
      previousUnit <= 0xdbff
    ) {
      start -= 1;
    }
    const character = text.slice(start, index);
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    bytes += width;
    index = start;
  }
  return text.slice(index);
}
