import { streamText } from "ai";
import { normalizeOpenAICompatibleError } from "./error-normalizer.js";
import { createOpenAICompatibleClient, openAICompatibleChatModel } from "./sdk-client.js";
import {
  createStreamTranslationState,
  translateOpenAICompatiblePart,
} from "./stream-translator.js";
import { translateOpenAICompatibleMessages } from "./message-translator.js";
import {
  translateOpenAICompatibleToolChoice,
  translateOpenAICompatibleTools,
} from "./tool-translator.js";
import {
  resolveOpenAICompatibleNativeOptions,
  toOpenAICompatibleProviderOptions,
} from "./request-options.js";
import type { AIAdapterEvent } from "../api-adapter-event.js";
import type { ApiAdapter, ApiAdapterStreamInput } from "../api-adapter.js";
import type { ApiId } from "../../ids/api-id.js";

/**
 * The API dialect this adapter implements.
 *
 * Reserved by the frozen V2 design. Several providers may share it, and one
 * adapter serves all of them: the dialect is not a vendor.
 */
export const OPENAI_COMPATIBLE_API_ID: ApiId = "openai-compatible-chat";

/**
 * Create the OpenAI-compatible chat adapter.
 *
 * The factory takes no options on purpose. Every candidate option would either
 * change the frozen dialect id or weaken a required guarantee: retries are always
 * disabled, the abort signal is always forwarded, raw chunk inspection is always
 * enabled, and the dialect id is fixed by the frozen design.
 *
 * The adapter performs exactly one provider turn. It parses no provider dialect
 * outside this directory, executes no tool, mints no call id and owns no timeout.
 */
export function createOpenAICompatibleApiAdapter(): ApiAdapter {
  return {
    id: OPENAI_COMPATIBLE_API_ID,

    async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
      const { model, provider, request, signal } = input;

      // Fail closed before any transport is created when the resolution cannot be
      // expressed in this dialect.
      const nativeOptions = resolveOpenAICompatibleNativeOptions(model, request);

      const client = createOpenAICompatibleClient(provider);
      const translated = translateOpenAICompatibleMessages(request.messages);
      const tools = translateOpenAICompatibleTools(request.tools);
      const toolChoice = translateOpenAICompatibleToolChoice(request.toolChoice);
      const providerOptions = toOpenAICompatibleProviderOptions(client.providerName, nativeOptions);

      const result = streamText({
        model: openAICompatibleChatModel(client, model.ref.model),
        messages: [...translated.messages],
        ...(translated.instructions === undefined ? {} : { instructions: translated.instructions }),
        ...(tools === undefined ? {} : { tools }),
        ...(toolChoice === undefined ? {} : { toolChoice }),
        ...(providerOptions === undefined ? {} : { providerOptions }),
        ...(request.settings.temperature === undefined
          ? {}
          : { temperature: request.settings.temperature }),
        ...(request.settings.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.settings.maxOutputTokens }),
        // The gateway owns the signal; the adapter only forwards it to the real
        // transport so an abort stops the network request itself.
        abortSignal: signal,
        // Retry policy belongs to the durable run layer. The SDK must never retry,
        // so one adapter invocation is at most one transport attempt.
        maxRetries: 0,
        // Raw chunks are required for tool-call identity policing and for the
        // provider-native finish reason.
        includeRawChunks: true,
        onError: () => undefined,
      });

      const state = createStreamTranslationState(signal, model.ref);

      try {
        for await (const part of result.fullStream) {
          yield* translateOpenAICompatiblePart(part, state);
        }
      } catch (error) {
        throw normalizeOpenAICompatibleError(error, model.ref);
      }
    },
  };
}
