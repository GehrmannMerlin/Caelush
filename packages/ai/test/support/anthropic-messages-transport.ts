/**
 * Anthropic Messages SSE fixtures and a capturing transport for adapter tests.
 *
 * Every fixture is a deterministic, locally generated event stream. No test in this
 * package may reach `api.anthropic.com`, and no test may use a real API key.
 */

import {
  capturingTransport as capturingHttpTransport,
  hangingTransport as hangingHttpTransport,
} from "./http-capturing-transport.js";
import type {
  CapturedHttpRequest,
  CapturingTransport as HttpCapturingTransport,
} from "./http-capturing-transport.js";

/** One native SSE event, before encoding. */
export interface NativeEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Encode native events as an SSE body with LF line endings. */
export function sseBody(
  events: readonly NativeEvent[],
  options: { readonly terminator?: string } = {},
): string {
  const terminator = options.terminator ?? "\n\n";
  return events
    .map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}${terminator}`)
    .join("");
}

/** Encode native events as a complete SSE `Response`. */
export function sseResponse(events: readonly NativeEvent[]): Response {
  return new Response(sseBody(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Encode a raw body as an SSE `Response`, for malformed-stream scenarios. */
export function rawSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// Native event builders
// ---------------------------------------------------------------------------

/** `message_start`, carrying the provider-native input usage snapshot. */
export function messageStart(
  usage: Record<string, unknown> = { input_tokens: 11, output_tokens: 0 },
  id = "msg_fixture",
): NativeEvent {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "fixture-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
  };
}

/** `content_block_start` for a text block. */
export function textBlockStart(index = 0): NativeEvent {
  return {
    event: "content_block_start",
    data: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  };
}

/** `content_block_start` for a `tool_use` block. */
export function toolBlockStart(index: number, id: string, name: string): NativeEvent {
  return {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    },
  };
}

/** `content_block_start` for a thinking block. */
export function thinkingBlockStart(index = 0): NativeEvent {
  return {
    event: "content_block_start",
    data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
  };
}

/** `content_block_delta` carrying text. */
export function textDelta(index: number, text: string): NativeEvent {
  return {
    event: "content_block_delta",
    data: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  };
}

/** `content_block_delta` carrying a tool input JSON fragment. */
export function inputJsonDelta(index: number, partialJson: string): NativeEvent {
  return {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partialJson },
    },
  };
}

/** `content_block_delta` carrying showable thinking text. */
export function thinkingDelta(index: number, thinking: string): NativeEvent {
  return {
    event: "content_block_delta",
    data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } },
  };
}

/** `content_block_delta` carrying provider-private signature bytes. */
export function signatureDelta(index: number, signature: string): NativeEvent {
  return {
    event: "content_block_delta",
    data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
  };
}

/** `content_block_stop`. */
export function blockStop(index: number): NativeEvent {
  return { event: "content_block_stop", data: { type: "content_block_stop", index } };
}

/** `message_delta`, carrying the stop reason and the final usage snapshot. */
export function messageDelta(
  stopReason: string | null,
  usage: Record<string, unknown> = { output_tokens: 5 },
): NativeEvent {
  return {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    },
  };
}

/** `message_stop`. */
export function messageStop(): NativeEvent {
  return { event: "message_stop", data: { type: "message_stop" } };
}

/** `ping`. */
export function ping(): NativeEvent {
  return { event: "ping", data: { type: "ping" } };
}

/** A mid-stream native `error` event. */
export function errorEvent(type = "overloaded_error", message = "Overloaded"): NativeEvent {
  return { event: "error", data: { type: "error", error: { type, message } } };
}

// ---------------------------------------------------------------------------
// Whole-turn compositions
// ---------------------------------------------------------------------------

/** A complete text turn. */
export function textTurnEvents(text: string): readonly NativeEvent[] {
  return [
    messageStart(),
    textBlockStart(0),
    textDelta(0, text),
    blockStop(0),
    messageDelta("end_turn", { output_tokens: 5 }),
    messageStop(),
  ];
}

/** A complete single-tool turn, with the input split across two fragments. */
export function toolTurnEvents(
  id = "toolu_a",
  name = "read_file",
  firstFragment = '{"pa',
  secondFragment = 'th":"a.ts"}',
): readonly NativeEvent[] {
  return [
    messageStart(),
    toolBlockStart(0, id, name),
    inputJsonDelta(0, firstFragment),
    inputJsonDelta(0, secondFragment),
    blockStop(0),
    messageDelta("tool_use", { output_tokens: 9 }),
    messageStop(),
  ];
}

/** A complete two-tool turn with interleaved blocks. */
export function parallelToolTurnEvents(): readonly NativeEvent[] {
  return [
    messageStart(),
    toolBlockStart(0, "toolu_a", "read_file"),
    toolBlockStart(1, "toolu_b", "search_text"),
    inputJsonDelta(0, '{"path":'),
    inputJsonDelta(1, '{"query":'),
    inputJsonDelta(0, '"a.ts"}'),
    inputJsonDelta(1, '"b"}'),
    blockStop(0),
    blockStop(1),
    messageDelta("tool_use", { output_tokens: 12 }),
    messageStop(),
  ];
}

/** A complete turn whose usage covers input, cache read and reasoning detail. */
export function usageTurnEvents(): readonly NativeEvent[] {
  return [
    messageStart({ input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 2 }),
    textBlockStart(0),
    textDelta(0, "hi"),
    blockStop(0),
    messageDelta("end_turn", {
      output_tokens: 3,
      output_tokens_details: { thinking_tokens: 1 },
    }),
    messageStop(),
  ];
}

/**
 * A captured provider request with the Anthropic body already parsed.
 *
 * The dialect-neutral base carries the body as text; this dialect's tests read it as
 * JSON, so the parsed view is attached here rather than in the shared harness.
 */
export interface CapturedRequest extends CapturedHttpRequest {
  readonly body: Record<string, unknown>;
}

/** A recording transport that records Anthropic Messages requests. */
export type CapturingTransport = HttpCapturingTransport<CapturedRequest>;

function decorate(request: CapturedHttpRequest): CapturedRequest {
  return {
    ...request,
    body:
      request.bodyText.length === 0
        ? {}
        : (JSON.parse(request.bodyText) as Record<string, unknown>),
  };
}

/** Build a transport that answers every request with the same scripted response. */
export function capturingTransport(
  respond: (request: CapturedRequest) => Response | Promise<Response>,
): CapturingTransport {
  return capturingHttpTransport<CapturedRequest>(respond, decorate);
}

/** A transport that answers every request with one scripted event list. */
export function turnTransport(events: readonly NativeEvent[]): CapturingTransport {
  return capturingTransport(() => sseResponse(events));
}

/** A transport that always fails with an HTTP status and optional body. */
export function failingTransport(
  status: number,
  body = "",
  headers: Record<string, string> = {},
): CapturingTransport {
  return capturingTransport(
    () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  );
}

/** A transport whose response body never completes until the request is aborted. */
export function hangingTransport(): CapturingTransport & { readonly observedAbort: () => boolean } {
  return hangingHttpTransport<CapturedRequest>(decorate);
}
