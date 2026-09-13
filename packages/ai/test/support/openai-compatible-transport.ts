/**
 * OpenAI-shaped SSE fixtures and a capturing transport for adapter tests.
 *
 * The generic capture harness lives in `http-capturing-transport.ts` and knows
 * nothing about any dialect. This file is the OpenAI-compatible layer on top of it:
 * it adds the wire chunk builders and the parsed-JSON `body` view that the
 * OpenAI-compatible golden tests assert on.
 *
 * Everything here is a controlled local transport: no test in this package may
 * reach a real provider endpoint or use a real credential.
 */

import {
  capturingTransport as capturingHttpTransport,
  hangingTransport as hangingHttpTransport,
} from "./http-capturing-transport.js";
import type {
  CapturedHttpRequest,
  CapturingTransport as HttpCapturingTransport,
} from "./http-capturing-transport.js";

interface OpenAIChunkInput {
  readonly id: string;
  readonly model: string;
  readonly delta: Record<string, unknown>;
  readonly finishReason?: string | null;
  readonly index?: number;
  readonly usage?: Record<string, unknown>;
}

interface ToolCallDeltaInput {
  readonly index?: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

/** One `chat.completion.chunk` payload. */
export function openAIChunk(input: OpenAIChunkInput): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: 1,
    model: input.model,
    choices: [
      {
        index: input.index ?? 0,
        delta: input.delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  };
}

/** One streamed tool-call delta. */
export function toolCallDelta(input: ToolCallDeltaInput): Record<string, unknown> {
  return {
    ...(input.index === undefined ? {} : { index: input.index }),
    ...(input.id === undefined ? {} : { id: input.id }),
    type: "function",
    function: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
    },
  };
}

/** A terminal chunk carrying the provider finish reason. */
export function finishChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly finishReason: string;
  readonly usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return openAIChunk({
    id: input.id,
    model: input.model,
    delta: {},
    finishReason: input.finishReason,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  });
}

/** A usage-only chunk. */
export function usageChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly usage: Record<string, unknown>;
}): Record<string, unknown> {
  return openAIChunk({ id: input.id, model: input.model, delta: {}, usage: input.usage });
}

/** Encode chunks as an SSE response body. */
export function sseBody(chunks: readonly Record<string, unknown>[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** Encode chunks as a complete SSE `Response`. */
export function sseResponse(chunks: readonly Record<string, unknown>[]): Response {
  return new Response(sseBody(chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * A captured provider request with the OpenAI-compatible body already parsed.
 *
 * The dialect-neutral base carries the body as text; this dialect's tests read it as
 * JSON, so the parsed view is attached here rather than in the shared harness.
 */
export interface CapturedRequest extends CapturedHttpRequest {
  readonly body: Record<string, unknown>;
}

/** A recording transport that records OpenAI-compatible requests. */
export type CapturingTransport = HttpCapturingTransport<CapturedRequest>;

/** Parse a captured body once, for every request this transport records. */
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
