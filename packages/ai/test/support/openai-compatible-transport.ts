/**
 * OpenAI-shaped SSE fixtures and a capturing transport for adapter tests.
 *
 * Everything here is a controlled local transport: no test in this package may
 * reach a real provider endpoint or use a real credential.
 */

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

/** A captured provider request. */
export interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
  readonly signalAborted: () => boolean;
}

/** A recording transport: it answers with a scripted response and records requests. */
export interface CapturingTransport {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly CapturedRequest[];
  callCount(): number;
}

/** Build a transport that answers every request with the same scripted response. */
export function capturingTransport(
  respond: (request: CapturedRequest) => Response | Promise<Response>,
): CapturingTransport {
  const requests: CapturedRequest[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }

    const rawBody = typeof init?.body === "string" ? init.body : "";
    const request: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: rawBody.length === 0 ? {} : (JSON.parse(rawBody) as Record<string, unknown>),
      signalAborted: () => init?.signal?.aborted === true,
    };
    requests.push(request);
    return respond(request);
  };

  return { fetch: fetchImpl, requests, callCount: () => requests.length };
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

/**
 * A transport whose response body never completes.
 *
 * Resolves only when the request signal aborts, so an aborted invocation is
 * observable as a transport-level cancellation rather than a parse failure.
 */
export function hangingTransport(): CapturingTransport & { readonly observedAbort: () => boolean } {
  let aborted = false;

  const transport = capturingTransport((request) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = request.signalAborted;
        const poll = setInterval(() => {
          if (signal()) {
            aborted = true;
            clearInterval(poll);
            controller.error(new Error("transport aborted"));
          }
        }, 5);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  return { ...transport, observedAbort: () => aborted };
}
