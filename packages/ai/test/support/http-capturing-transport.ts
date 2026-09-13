/**
 * A dialect-neutral HTTP capture transport for adapter tests.
 *
 * This is the shared conformance harness for *every* API dialect: it records what a
 * provider adapter actually put on the wire — url, method, headers, raw body text,
 * the request `AbortSignal` and the attempt count — and never inspects the dialect
 * of the payload. `CapturedHttpRequest` deliberately carries the body as **text**:
 * a generic capture cannot know which dialect is being captured, and parsing one
 * dialect's JSON there would be exactly the OpenAI-specific coupling this file
 * exists to remove.
 *
 * Everything here is a controlled local transport. No test in this package may
 * reach a real provider endpoint or use a real credential.
 */

/** A captured provider request, in dialect-neutral terms. */
export interface CapturedHttpRequest {
  readonly url: string;
  readonly method: string;
  /** Header names lower-cased, because HTTP header lookup is case-insensitive. */
  readonly headers: Record<string, string>;
  /** The exact request body text, or `""` when the request carried no body. */
  readonly bodyText: string;
  /** Whether the gateway-owned signal had already fired when the request was made. */
  readonly signalAborted: () => boolean;
  /** Whether the request carried an `AbortSignal` at all. */
  readonly hasSignal: () => boolean;
}

/** A recording transport: it answers with a scripted response and records requests. */
export interface CapturingTransport<TRequest extends CapturedHttpRequest = CapturedHttpRequest> {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly TRequest[];
  callCount(): number;
}

/** The response a scripted transport should produce for one captured request. */
export type Responder<TRequest extends CapturedHttpRequest = CapturedHttpRequest> = (
  request: TRequest,
) => Response | Promise<Response>;

/**
 * Build a transport that answers every request with the same scripted response.
 *
 * `decorate` lets a dialect-specific support file attach a parsed body to each
 * captured request without teaching this generic harness about that dialect.
 */
export function capturingTransport<TRequest extends CapturedHttpRequest = CapturedHttpRequest>(
  respond: Responder<TRequest>,
  decorate?: (request: CapturedHttpRequest) => TRequest,
): CapturingTransport<TRequest> {
  const requests: TRequest[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }

    const request: CapturedHttpRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      bodyText: typeof init?.body === "string" ? init.body : "",
      signalAborted: () => init?.signal?.aborted === true,
      hasSignal: () => init?.signal !== undefined && init?.signal !== null,
    };
    requests.push(decorate === undefined ? (request as TRequest) : decorate(request));
    return respond(request as TRequest);
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
export function hangingTransport<TRequest extends CapturedHttpRequest = CapturedHttpRequest>(
  decorate?: (request: CapturedHttpRequest) => TRequest,
): CapturingTransport<TRequest> & { readonly observedAbort: () => boolean } {
  let aborted = false;

  const transport = capturingTransport<TRequest>((request) => {
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
  }, decorate);

  return { ...transport, observedAbort: () => aborted };
}

/** Parse a captured body as JSON, failing loudly when it is not an object. */
export function jsonBodyOf(request: CapturedHttpRequest): Record<string, unknown> {
  const parsed: unknown = JSON.parse(request.bodyText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("captured request body is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** The first captured request, or a loud failure when none was sent. */
export function firstRequest<TRequest extends CapturedHttpRequest>(
  transport: CapturingTransport<TRequest>,
  index = 0,
): TRequest {
  const request = transport.requests[index];
  if (request === undefined) throw new Error("no provider request was captured");
  return request;
}

/** The first captured request body parsed as JSON. */
export function firstBody<TRequest extends CapturedHttpRequest>(
  transport: CapturingTransport<TRequest>,
  index = 0,
): Record<string, unknown> {
  return jsonBodyOf(firstRequest(transport, index));
}
