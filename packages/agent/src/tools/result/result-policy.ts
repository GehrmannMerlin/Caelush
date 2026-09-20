import type { JsonObject } from "@caelush/ai";
import type { TimestampMs } from "@caelush/protocol";

import type { PreparedToolCall } from "../call/tool-call-preparer.js";
import type { AgentToolResult } from "../types/tool-result.js";

/**
 * How much of a Tool result this layer will commit.
 *
 * ```ts
 * export interface ToolResultLimits {
 *   readonly maxDurableContentBytes: number;
 *   readonly maxDetailsBytes: number;
 * }
 * ```
 *
 * ## Why the durable bound is not the model bound
 *
 * These limits bound what is **safe and durable**, not what a model is shown. A validated, sanitized
 * observation may legitimately be larger than the summary that reaches a provider: the model-visible
 * length is decided later by the Context layer's `ToolObservationPolicySnapshot`, from observation
 * token budgets it owns.
 *
 * The first migration wave keeps the values the Tool System already enforced, so nothing observable
 * shrinks:
 *
 * ```text
 * maxDurableContentBytes   64 KiB    (formerly maxModelContentBytes)
 * maxDetailsBytes          256 KiB
 * ```
 *
 * The legacy option name is retained only as a compatibility facet on the legacy DTO. New code states
 * the durable bound, because "model context budget" is a different kind of number owned by a
 * different layer.
 */
export interface ToolResultLimits {
  readonly maxDurableContentBytes: number;
  readonly maxDetailsBytes: number;
}

export const DEFAULT_TOOL_RESULT_LIMITS: ToolResultLimits = Object.freeze({
  maxDurableContentBytes: 64 * 1024,
  maxDetailsBytes: 256 * 1024,
});

/** The marker appended to content that had to be bounded. */
export const TOOL_RESULT_TRUNCATION_MARKER = "\n[output truncated]";

/**
 * Bound model-facing text to a UTF-8 byte budget.
 *
 * ```text
 * already within budget   returned unchanged, byte for byte
 * over budget             the longest whole-character prefix that leaves room for the marker,
 *                         followed by the marker
 * marker cannot fit       the longest whole-character prefix that fits at all, no marker
 * ```
 *
 * The unit is UTF-8 bytes, never `String.length`: `"中文"` is two characters and six bytes, and a
 * budget expressed in characters would cut it in the wrong place for every non-ASCII payload. The
 * prefix is built by whole Unicode code points, so the result can never end in a lone surrogate.
 */
export function boundToolResultContent(
  content: string,
  limits: ToolResultLimits = DEFAULT_TOOL_RESULT_LIMITS,
): string {
  validateToolResultLimits(limits);
  if (Buffer.byteLength(content, "utf8") <= limits.maxDurableContentBytes) return content;

  const markerBytes = Buffer.byteLength(TOOL_RESULT_TRUNCATION_MARKER, "utf8");
  if (markerBytes > limits.maxDurableContentBytes) {
    return wholeCharacterPrefix(content, limits.maxDurableContentBytes);
  }
  return `${wholeCharacterPrefix(content, limits.maxDurableContentBytes - markerBytes)}${TOOL_RESULT_TRUNCATION_MARKER}`;
}

/** The longest whole-character prefix of `content` within `maxBytes` UTF-8 bytes. */
function wholeCharacterPrefix(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let prefix = "";
  for (const character of content) {
    if (Buffer.byteLength(prefix + character, "utf8") > maxBytes) break;
    prefix += character;
  }
  return prefix;
}

/** A result limit must be a positive integer; a zero or non-integer budget is refused, not clamped. */
export function validateToolResultLimits(limits: ToolResultLimits): ToolResultLimits {
  if (
    !Number.isSafeInteger(limits.maxDurableContentBytes) ||
    limits.maxDurableContentBytes <= 0 ||
    !Number.isSafeInteger(limits.maxDetailsBytes) ||
    limits.maxDetailsBytes <= 0
  ) {
    throw new ToolResultLimitError();
  }
  return limits;
}

/** A misconfigured result budget. A configuration error, not a model-facing failure. */
export class ToolResultLimitError extends Error {
  constructor(
    message = "Tool result limits must be positive integers.",
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "ToolResultLimitError";
  }
}

/**
 * The generic settlement extension: what a Tool result contributes to a settlement beyond the
 * result itself.
 *
 * ```ts
 * export interface ToolSettlementExtension {
 *   readonly kind: string;
 *   readonly payload: JsonObject;
 * }
 * ```
 *
 * The general Agent layer **carries** this value, **returns** it and **passes it through**. It never
 * branches on `kind`, never understands a Coding Tool effect and never imports a Coding effect type.
 * The Coding overlay is free to declare its own kind — the production compatibility bridge uses
 * `caelush.coding.effects.v1` for the existing Tool effects — and only the layer that declared it
 * interprets it.
 *
 * The seam exists because two Architecture V2 principles have to hold at the same time: the Agent
 * layer must not depend on the Coding Agent, and the existing Coding Tool Effects must keep settling
 * in the Tool invocation's own atomic commit. A typed pass-through satisfies both; moving
 * `ToolEffect[]` into the kernel would break the first, and dropping effect projection would break
 * the second.
 */
export interface ToolSettlementExtension {
  readonly kind: string;
  readonly payload: JsonObject;
}

/** The extension kind the production Coding compatibility bridge produces. */
export const CODING_TOOL_EFFECTS_EXTENSION_KIND = "caelush.coding.effects.v1";

/**
 * The optional projector that produces a settlement extension for one Tool execution.
 *
 * It is called **after** sanitization and revalidation, so it only ever observes a result that is
 * known to be safe to commit. It is never called with the raw result, it may not mutate the result it
 * is given, and a throw is a `RESULT_PIPELINE` infrastructure failure — an effect that cannot be
 * projected safely must not be silently dropped, because the durable state would then disagree with
 * what actually happened.
 */
export type ToolSettlementExtensionProjector = (input: {
  readonly call: PreparedToolCall;
  readonly result: AgentToolResult;
  readonly now: TimestampMs;
}) => ToolSettlementExtension | undefined;
