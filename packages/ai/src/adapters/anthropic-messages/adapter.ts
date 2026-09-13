import { createAnthropicStreamState, observeAnthropicEvent } from "./stream-translator.js";
import { createServerSentEventParser } from "./sse-parser.js";
import { createTextDecoderStream } from "./text-decoder.js";
import {
  normalizeAnthropicFetchFailure,
  normalizeAnthropicHttpError,
  normalizeAnthropicInvalidResponse,
} from "./error-normalizer.js";
import { parseAnthropicMessagesConnectionMetadata } from "./adapter-metadata.js";
import { parseAnthropicMessagesModelMetadata } from "./adapter-metadata.js";
import { translateAnthropicRequest } from "./request-translator.js";
import type { AIAdapterEvent } from "../api-adapter-event.js";
import type { AIError } from "../../errors/ai-error.js";
import type { ApiAdapter, ApiAdapterStreamInput } from "../api-adapter.js";
import type { ApiId } from "../../ids/api-id.js";
import type { ModelRef } from "../../models/model-ref.js";
import type { ResolvedProviderConnection } from "../../providers/resolved-provider-connection.js";

/**
 * The API dialect this adapter implements.
 *
 * Reserved by the frozen V2 design. It names a wire protocol, not a vendor: several
 * providers may share it, and one adapter instance serves all of them. No vendor
 * name is ever used to select behaviour.
 */
export const ANTHROPIC_MESSAGES_API_ID: ApiId = "anthropic-messages";

/**
 * Create the native Anthropic Messages adapter.
 *
 * The factory takes no options on purpose. Every candidate option would either
 * change the frozen dialect id or weaken a required guarantee: the dialect is fixed
 * by the frozen design, retries are always disabled, the abort signal is always
 * forwarded, and the endpoint always comes from the resolved provider connection.
 *
 * The adapter speaks the native protocol over `fetch` and its own SSE parser. It
 * deliberately depends on no provider SDK: transport ownership stays with the
 * provider connection's fetch seam, no SDK retry policy can slip in, no SDK type can
 * leak into a public contract, and the frozen `ApiAdapter` abstraction is proven
 * against a dialect that shares nothing with the OpenAI-compatible one.
 *
 * It performs exactly one provider turn. It executes no tool, mints no Caelush call
 * id, owns no timeout and never retries.
 */
export function createAnthropicMessagesApiAdapter(): ApiAdapter {
  return {
    id: ANTHROPIC_MESSAGES_API_ID,

    async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
      const { model, provider, request, signal } = input;
      const ref = model.ref;

      // Fail closed before any transport is created: metadata, endpoint, headers,
      // authentication, message projection and the thinking/tool safety rules all
      // decide here, so a request the dialect cannot express never reaches a socket.
      const modelMetadata = parseAnthropicMessagesModelMetadata(model.adapterMetadata);
      const connectionMetadata = parseAnthropicMessagesConnectionMetadata(provider.compatibility);
      const translated = translateAnthropicRequest(
        modelMetadata,
        provider,
        request,
        connectionMetadata,
      );

      const fetchImpl = resolveFetch(provider);
      let response: Response;
      try {
        response = await fetchImpl(translated.url, {
          method: translated.method,
          headers: { ...translated.headers },
          body: JSON.stringify(translated.body),
          signal,
        });
      } catch (error) {
        // The gateway owns abort semantics, so an abort is reported as one instead
        // of as the transport symptom the runtime produced while unwinding.
        throw normalizeAnthropicFetchFailure(error, signal.aborted, ref);
      }

      if (!response.ok) {
        throw normalizeAnthropicHttpError(
          {
            status: response.status,
            headers: readResponseHeaders(response),
            bodyText: await readFailureBody(response),
          },
          ref,
        );
      }

      const body = response.body;
      if (body === null) {
        throw normalizeAnthropicInvalidResponse(
          undefined,
          ref,
          "AI provider returned an empty Anthropic Messages stream.",
        );
      }

      const state = createAnthropicStreamState(ref, translated.native.summaryRequested, signal);
      const parser = createServerSentEventParser();

      // The dialect streams over a POST with custom headers, which `EventSource`
      // cannot do, so the response body is read directly.
      const decoder = createTextDecoderStream(body);
      for await (const text of decoder) {
        for (const event of parser.push(text)) {
          yield* observeAnthropicEvent(event, state);
        }
      }
      for (const event of parser.end()) {
        yield* observeAnthropicEvent(event, state);
      }

      // A body that simply stops is not a completed turn: the stream contract
      // requires `message_stop` to own the finish, exactly once.
      if (!state.finished) {
        if (signal.aborted) throw abortedFailure(state.model);
        throw normalizeAnthropicInvalidResponse(
          undefined,
          ref,
          "The native Anthropic Messages stream ended without message_stop.",
        );
      }
    },
  };
}

/**
 * Resolve the transport implementation.
 *
 * The provider connection owns the fetch seam; `globalThis.fetch` is only the
 * fallback for a host that supplies none. No second transport abstraction is
 * created, and `node-fetch`, `undici` or `axios` are never imported.
 */
function resolveFetch(connection: ResolvedProviderConnection): typeof globalThis.fetch {
  const override = connection.transport?.fetch;
  if (override !== undefined) return override;
  return globalThis.fetch;
}

function readResponseHeaders(response: Response): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

/**
 * Read a bounded amount of a failure body.
 *
 * The body is read only to classify the status — a spend cap, a context overflow —
 * and is never copied into an error message, a public event or a diagnostic.
 */
async function readFailureBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 65_536 ? text.slice(0, 65_536) : text;
  } catch {
    return "";
  }
}

function abortedFailure(model: ModelRef): AIError {
  return normalizeAnthropicFetchFailure(undefined, true, model);
}
