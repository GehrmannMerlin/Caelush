import { createAIError } from "../../errors/ai-error.js";
import { isJsonObject } from "../../json/json-value.js";
import { mapAnthropicFinishReason, shouldReportProviderReason } from "./finish-reason.js";
import { mergeAnthropicUsage, normalizeAnthropicUsage } from "./usage-normalizer.js";
import {
  normalizeAnthropicInvalidResponse,
  normalizeAnthropicStreamError,
} from "./error-normalizer.js";
import { parseAnthropicToolInput } from "./tool-input-parser.js";
import type { AIAdapterEvent } from "../api-adapter-event.js";
import type { AIError } from "../../errors/ai-error.js";
import type { AIFinishReason } from "../../tools/tool-call.js";
import type { ModelRef } from "../../models/model-ref.js";
import type { ModelUsage } from "../../models/model-usage.js";
import type { ServerSentEvent } from "./sse-parser.js";

/**
 * The CAELUSH tool-name shape, reproduced here as an adapter-private guard.
 *
 * The provider would happily return a name the core cannot route, so the stream
 * fails closed instead of surfacing an unexecutable call.
 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The `content_block_start` payloads this dialect understands. */
type BlockHeader =
  | { readonly kind: "text" }
  | { readonly kind: "tool_use"; readonly id: string; readonly name: string }
  | { readonly kind: "thinking" };

type BlockState =
  | { readonly kind: "text"; readonly index: number }
  | {
      readonly kind: "tool_use";
      readonly index: number;
      readonly id: string;
      readonly name: string;
      json: string;
    }
  | { readonly kind: "thinking"; readonly index: number; announced: boolean };

/** Per-turn stream state. */
export interface AnthropicStreamState {
  readonly model: ModelRef;
  /** Whether a showable reasoning summary may be published for this turn. */
  readonly summaryRequested: boolean;
  readonly signal: AbortSignal;
  readonly blocks: Map<number, BlockState>;
  usage: ModelUsage | undefined;
  /** The last snapshot already published as a `usage` event. */
  emittedUsage: ModelUsage | undefined;
  sawMessageStart: boolean;
  stopReason: string | undefined;
  finished: boolean;
}

/** Create the per-turn stream state. */
export function createAnthropicStreamState(
  model: ModelRef,
  summaryRequested: boolean,
  signal: AbortSignal,
): AnthropicStreamState {
  return {
    model,
    summaryRequested,
    signal,
    blocks: new Map(),
    usage: undefined,
    emittedUsage: undefined,
    sawMessageStart: false,
    stopReason: undefined,
    finished: false,
  };
}

/**
 * Observe one native SSE event.
 *
 * The native usage counters arrive as cumulative *snapshots* — `message_start`
 * carries the input counters and `message_delta` restates the final ones — so the
 * merged snapshot is published whenever it actually changes, and never twice for
 * the same snapshot. A snapshot with no counters at all is a provider courtesy, not
 * a measurement, and produces no event.
 */
export function* observeAnthropicEvent(
  event: ServerSentEvent,
  state: AnthropicStreamState,
): Generator<AIAdapterEvent> {
  yield* translateAnthropicEvent(event, state);

  if (state.usage === undefined || Object.keys(state.usage).length === 0) return;
  if (state.emittedUsage !== undefined && sameUsage(state.emittedUsage, state.usage)) return;

  state.emittedUsage = state.usage;
  yield { type: "usage", payload: state.usage };
}

function sameUsage(left: ModelUsage, right: ModelUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.reasoningTokens === right.reasoningTokens
  );
}

/**
 * Translate one native SSE event into zero or more adapter events.
 *
 * This is the state machine for the native streaming protocol:
 *
 * ```text
 * message_start        record the input usage snapshot
 * content_block_start  open a text, tool_use or thinking block
 * content_block_delta  text_delta / input_json_delta / thinking_delta / signature_delta
 * content_block_stop   close the block; a tool block parses and completes its call
 * message_delta        record the stop reason and merge the usage snapshot
 * message_stop         emit `adapter.finish` exactly once
 * ping                 ignore
 * error                throw a normalised AIError (the gateway owns stream.error)
 * ```
 *
 * Signatures, redacted thinking and provider-private continuation state produce no
 * public event at all: the frozen adapter contract has no place for them, and
 * publishing them would be the leak this phase exists to prevent.
 */
export function* translateAnthropicEvent(
  event: ServerSentEvent,
  state: AnthropicStreamState,
): Generator<AIAdapterEvent> {
  switch (event.event) {
    case "message_start": {
      const payload = parseJsonEvent(event, state);
      const message = isJsonObject(payload["message"]) ? payload["message"] : undefined;
      state.sawMessageStart = true;
      state.usage = mergeAnthropicUsage(state.usage, normalizeAnthropicUsage(message?.["usage"]));
      return;
    }

    case "content_block_start": {
      yield* startBlock(event, state);
      return;
    }

    case "content_block_delta": {
      yield* deltaBlock(event, state);
      return;
    }

    case "content_block_stop": {
      yield* stopBlock(event, state);
      return;
    }

    case "message_delta": {
      const payload = parseJsonEvent(event, state);
      const delta = isJsonObject(payload["delta"]) ? payload["delta"] : undefined;
      const stopReason = delta?.["stop_reason"];
      if (typeof stopReason === "string") state.stopReason = stopReason;
      state.usage = mergeAnthropicUsage(state.usage, normalizeAnthropicUsage(payload["usage"]));
      // `adapter.finish` is deliberately NOT emitted here: only `message_stop`
      // owns the finish timing, and reporting completion at `message_delta` would
      // end the stream before usage and the final block are known.
      return;
    }

    case "message_stop": {
      if (state.finished) {
        throw invalid(state, "The native stream stopped more than once.");
      }
      state.finished = true;
      for (const block of state.blocks.values()) {
        if (block.kind === "tool_use") {
          throw invalid(state, "The native stream stopped with an open tool_use block.");
        }
      }
      state.blocks.clear();
      yield { type: "adapter.finish", payload: finishPayload(state) };
      return;
    }

    case "ping":
      // A transport-level keep-alive. It never becomes a public event.
      return;

    case "error": {
      const payload = tryParseJson(event.data);
      throw normalizeAnthropicStreamError(payload, state.model);
    }

    default:
      throw unknownEvent(event, state);
  }
}

function* startBlock(
  event: ServerSentEvent,
  state: AnthropicStreamState,
): Generator<AIAdapterEvent> {
  const payload = parseJsonEvent(event, state);
  const index = readIndex(payload, state);
  const header = readBlockHeader(payload["content_block"], state);

  if (state.blocks.has(index)) {
    throw invalid(state, `The native stream opened the content block ${String(index)} twice.`);
  }

  if (header.kind === "tool_use") {
    if (!TOOL_NAME_PATTERN.test(header.name)) {
      throw invalid(state, "The native stream returned an invalid tool name.");
    }
    if (header.id.length === 0) {
      throw invalid(state, "The native stream returned a tool call without identity.");
    }
    state.blocks.set(index, {
      kind: "tool_use",
      index,
      id: header.id,
      name: header.name,
      json: "",
    });
    // Identity is announced immediately: `tool_use.id` is the only source of
    // `AIToolCall.id`, and the adapter never synthesises or guesses one.
    yield { type: "tool_call.start", payload: { toolCallId: header.id, toolName: header.name } };
    return;
  }

  state.blocks.set(
    index,
    header.kind === "text"
      ? { kind: "text", index }
      : { kind: "thinking", index, announced: false },
  );
}

function* deltaBlock(
  event: ServerSentEvent,
  state: AnthropicStreamState,
): Generator<AIAdapterEvent> {
  const payload = parseJsonEvent(event, state);
  const index = readIndex(payload, state);
  const block = state.blocks.get(index);
  if (block === undefined) {
    throw invalid(
      state,
      `The native stream emitted a delta for the unopened block ${String(index)}.`,
    );
  }

  const delta = payload["delta"];
  if (!isJsonObject(delta)) {
    throw invalid(state, "The native stream emitted a delta without a delta object.");
  }

  switch (delta["type"]) {
    case "text_delta": {
      if (block.kind !== "text") {
        throw invalid(state, "The native stream emitted a text delta inside a non-text block.");
      }
      const text = delta["text"];
      if (typeof text !== "string") {
        throw invalid(state, "The native stream emitted a text delta without text.");
      }
      if (text.length > 0) yield { type: "text.delta", payload: { text } };
      return;
    }

    case "input_json_delta": {
      if (block.kind !== "tool_use") {
        throw invalid(state, "The native stream emitted a tool input delta outside a tool block.");
      }
      const partial = delta["partial_json"];
      if (typeof partial !== "string") {
        throw invalid(state, "The native stream emitted a tool input delta without a fragment.");
      }
      block.json += partial;
      yield { type: "tool_call.delta", payload: { toolCallId: block.id, delta: partial } };
      return;
    }

    case "thinking_delta": {
      if (block.kind !== "thinking") {
        throw invalid(
          state,
          "The native stream emitted a thinking delta outside a thinking block.",
        );
      }
      const thinking = delta["thinking"];
      if (typeof thinking !== "string") {
        throw invalid(state, "The native stream emitted a thinking delta without text.");
      }
      // Only a showable summary may be published, and only when the request asked
      // this model for one. Raw thinking text never enters a public contract.
      if (!state.summaryRequested) return;
      if (thinking.length > 0) {
        state.blocks.set(index, { kind: "thinking", index, announced: true });
        yield { type: "reasoning.summary.delta", payload: { text: thinking } };
      }
      return;
    }

    case "signature_delta":
      // Provider-private continuation state. The frozen V2 contract has no place
      // for it, so it is ignored rather than published or persisted. A tool
      // continuation that would need it never reaches this path, because the
      // tool+thinking guard rejects that combination before any transport call.
      return;

    default:
      throw invalid(state, "The native stream emitted an unknown content block delta.");
  }
}

function* stopBlock(
  event: ServerSentEvent,
  state: AnthropicStreamState,
): Generator<AIAdapterEvent> {
  const payload = parseJsonEvent(event, state);
  const index = readIndex(payload, state);
  const block = state.blocks.get(index);
  if (block === undefined) {
    throw invalid(state, `The native stream closed the unopened block ${String(index)}.`);
  }
  state.blocks.delete(index);

  if (block.kind !== "tool_use") return;

  // The accumulated fragments only become a value here, and a value that is not a
  // JSON object fails closed instead of being cast.
  const call = {
    id: block.id,
    name: block.name,
    input: parseAnthropicToolInput(block.id, block.json, state.model),
  };
  yield { type: "tool_call.completed", payload: call };
}

function finishPayload(state: AnthropicStreamState): {
  readonly finishReason: AIFinishReason;
  readonly finalUsage?: ModelUsage;
  readonly providerReason?: string;
} {
  const reason = state.stopReason;
  const finishReason: AIFinishReason =
    reason === undefined ? "OTHER" : mapAnthropicFinishReason(reason);

  return {
    finishReason,
    ...(state.usage === undefined ? {} : { finalUsage: state.usage }),
    ...(reason === undefined || !shouldReportProviderReason(reason)
      ? {}
      : { providerReason: reason }),
  };
}

function readBlockHeader(value: unknown, state: AnthropicStreamState): BlockHeader {
  if (!isJsonObject(value)) {
    throw invalid(state, "The native stream opened a content block without a block object.");
  }

  const type = value["type"];
  if (type === "text") return { kind: "text" };

  if (type === "tool_use") {
    const id = value["id"];
    const name = value["name"];
    if (typeof id !== "string" || typeof name !== "string") {
      throw invalid(state, "The native stream opened a tool block without identity.");
    }
    return { kind: "tool_use", id, name };
  }

  // `thinking` and `redacted_thinking` are native provider blocks with no frozen
  // counterpart. They are absorbed rather than published: the frozen adapter event
  // set has no variant for them, and dropping them is the only safe projection.
  if (type === "thinking" || type === "redacted_thinking") return { kind: "thinking" };

  throw invalid(state, "The native stream opened an unknown content block type.");
}

function readIndex(payload: Record<string, unknown>, state: AnthropicStreamState): number {
  const index = payload["index"];
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw invalid(state, "The native stream omitted a valid content block index.");
  }
  return index;
}

function parseJsonEvent(
  event: ServerSentEvent,
  state: AnthropicStreamState,
): Record<string, unknown> {
  const parsed = tryParseJson(event.data);
  if (!isJsonObject(parsed)) {
    throw invalid(state, `The native stream sent a malformed "${event.event ?? "message"}" event.`);
  }
  return parsed;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reject an event this adapter does not understand.
 *
 * A future protocol extension that changes message semantics must never be read as
 * text or as a finish signal. An unrecognised event therefore fails the stream
 * closed; a genuinely harmless transport-level addition is added to the switch
 * explicitly, with its own test.
 */
function unknownEvent(event: ServerSentEvent, state: AnthropicStreamState): AIError {
  return normalizeAnthropicInvalidResponse(
    undefined,
    state.model,
    `The native Anthropic Messages stream emitted an unknown event "${event.event ?? "message"}".`,
  );
}

function invalid(state: AnthropicStreamState, message: string): AIError {
  return normalizeAnthropicInvalidResponse(undefined, state.model, message);
}

/** Build an abort failure for a stream that stopped because the gateway aborted. */
export function abortedError(state: AnthropicStreamState): AIError {
  return createAIError("AI_ABORTED", undefined, {
    providerId: state.model.provider,
    model: state.model,
  });
}
