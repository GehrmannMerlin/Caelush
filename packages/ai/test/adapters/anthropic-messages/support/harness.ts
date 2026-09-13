import { createAISubsystem } from "../../../../src/create-ai-subsystem.js";
import { createAnthropicMessagesApiAdapter } from "../../../../src/adapters/anthropic-messages/index.js";
import { modelDescriptor } from "../../../support/fixtures.js";
import {
  capturingTransport,
  type CapturedRequest,
  type CapturingTransport,
} from "../../../support/anthropic-messages-transport.js";
import type { AIModelRequest } from "../../../../src/request/model-request.js";
import type { AIStreamEvent } from "../../../../src/stream/events.js";
import type { AISerializableError } from "../../../../src/errors/serializable-error.js";
import type { JsonObject } from "../../../../src/json/json-value.js";
import type { ModelDescriptor } from "../../../../src/models/model-descriptor.js";
import type { ProviderCredentials } from "../../../../src/providers/credentials.js";

/** Every scenario runs against this provider id unless a test says otherwise. */
export const ANTHROPIC_PROVIDER_ID = "anthropic-fixture";

/** The dialect id under test. */
export const ANTHROPIC_API_ID = "anthropic-messages";

/** Options that only affect the composition, never the assertion. */
export interface CaptureTurnOptions {
  readonly descriptor?: ModelDescriptor;
  readonly endpoint?: string;
  readonly credentials?: ProviderCredentials;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryParams?: Readonly<Record<string, string>>;
  readonly compatibility?: JsonObject;
  readonly transport?: CapturingTransport;
  /**
   * The invocation timeout.
   *
   * A scripted transport that never completes only settles through the gateway's
   * timeout authority, so a scenario that exercises it must supply one instead of
   * hanging until the test runner gives up.
   */
  readonly timeoutMs?: number;
  /** The caller's abort signal, forwarded to the gateway unchanged. */
  readonly signal?: AbortSignal;
}

/** Everything one captured turn produced. */
export interface CapturedTurn {
  /** The single captured provider request, in dialect-neutral terms. */
  readonly request: CapturedRequest;
  /** The captured request body, already parsed. */
  readonly body: Record<string, unknown>;
  /** The captured request url. */
  readonly url: string;
  /** The public gateway events, in order. */
  readonly events: readonly AIStreamEvent[];
  /** The failure a synchronous preflight rejection threw, when there was one. */
  readonly thrown: unknown;
  /** The terminal `stream.error` payload, when the turn failed after streaming. */
  readonly streamError: AISerializableError | undefined;
  /** How many transport attempts were made. */
  readonly transportAttempts: number;
}

/**
 * The failure code of a turn, wherever the gateway reported it.
 *
 * `AIGateway.stream()` resolves before the adapter runs, so an adapter preflight
 * rejection surfaces as a terminal `stream.error` rather than as a throw. A test
 * that asserts a fail-closed outcome must not care which of the two paths produced
 * it, so both are normalised here.
 */
export function failureCode(turn: CapturedTurn): string | undefined {
  if (turn.thrown !== undefined) {
    const code = (turn.thrown as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return turn.streamError?.code;
}

/** Assert a turn failed closed with a specific frozen error code and no transport. */
export function expectFailClosed(turn: CapturedTurn, code: string): void {
  if (failureCode(turn) !== code) {
    throw new Error(
      `expected the turn to fail closed with ${code}, received ${String(failureCode(turn))}${
        turn.thrown === undefined ? "" : ` (thrown: ${String(turn.thrown)})`
      }`,
    );
  }
  if (turn.transportAttempts !== 0) {
    throw new Error(
      `expected zero transport attempts for a fail-closed turn, received ${String(turn.transportAttempts)}`,
    );
  }
}

/**
 * Run one request through the real gateway over a controlled transport.
 *
 * The composition is the production one — `createAISubsystem` with a real model
 * source, a real provider binding and the real adapter — so an assertion here is an
 * assertion about the shipped path, not about a test-only shortcut.
 */
export async function captureTurn(
  request: AIModelRequest,
  options: CaptureTurnOptions = {},
): Promise<CapturedTurn> {
  const descriptor =
    options.descriptor ??
    modelDescriptor({
      ref: { provider: request.model.provider, model: request.model.model },
      api: ANTHROPIC_API_ID,
    });

  const transport =
    options.transport ?? capturingTransport(() => sseBodyResponse(textTurnEvents("ok")));

  const ai = createAISubsystem({
    modelSources: [
      {
        id: "anthropic-golden",
        priority: 0,
        resolve: (ref) =>
          ref.provider === descriptor.ref.provider && ref.model === descriptor.ref.model
            ? descriptor
            : undefined,
        list: () => [descriptor],
      },
    ],
    providers: [
      {
        id: descriptor.ref.provider,
        endpoint: options.endpoint ?? "https://api.anthropic.com",
        defaultApi: ANTHROPIC_API_ID,
        allowUnknownModels: false,
        credentials: {
          resolve: () => Promise.resolve(options.credentials ?? { apiKey: "fixture-key" }),
        },
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.queryParams === undefined ? {} : { queryParams: options.queryParams }),
        ...(options.compatibility === undefined ? {} : { compatibility: options.compatibility }),
        transport: { fetch: transport.fetch },
      },
    ],
    adapters: [createAnthropicMessagesApiAdapter()],
  });

  const events: AIStreamEvent[] = [];
  let thrown: unknown;

  try {
    const streamOptions = {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const stream = await ai.gateway.stream(
      request,
      Object.keys(streamOptions).length === 0 ? undefined : streamOptions,
    );
    for await (const event of stream.events) events.push(event);
  } catch (error) {
    thrown = error;
  }

  const captured = transport.requests[0];
  const terminal = events.at(-1);

  if (captured === undefined && thrown === undefined && terminal?.type !== "stream.error") {
    throw new Error("captureTurn: the turn neither captured a request nor reported a failure");
  }

  return {
    request: captured ?? emptyRequest(),
    body: captured?.body ?? {},
    url: captured?.url ?? "",
    events,
    thrown,
    streamError: terminal?.type === "stream.error" ? terminal.payload.error : undefined,
    transportAttempts: transport.callCount(),
  };
}

function emptyRequest(): CapturedRequest {
  return {
    url: "",
    method: "",
    headers: {},
    bodyText: "",
    body: {},
    signalAborted: () => false,
    hasSignal: () => false,
  };
}

function sseBodyResponse(events: readonly { event: string; data: Record<string, unknown> }[]): Response {
  return new Response(
    events.map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
