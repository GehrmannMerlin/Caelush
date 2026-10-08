import { streamText } from "ai";
import { createAIError } from "../../errors/ai-error.js";
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
  requiresReasoningReplayWithTools,
  toOpenAICompatibleProviderOptions,
} from "./request-options.js";
import { resolveOpenAICompatibleCacheOptions } from "./cache-options.js";
import type { AIAdapterEvent } from "../api-adapter-event.js";
import type { ApiAdapter, ApiAdapterStreamInput } from "../api-adapter.js";
import type { ApiId } from "../../ids/api-id.js";
import {
  createDeepSeekPrivateReplayCapture,
  deepSeekReplayConnectionFingerprint,
} from "./private-replay.js";
import { decodeDeepSeekNativeReplayPayload } from "./private-replay.js";
import type { DeepSeekNativeReplayPayloadV1 } from "./private-replay.js";
import { isDeepStrictEqual } from "node:util";
import { parseOpenAICompatibleToolInput } from "./tool-call-parser.js";

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
      resolveOpenAICompatibleCacheOptions(model, request);
      const nativeReplayEnabled = requiresReasoningReplayWithTools(model);
      const nativeReplayByMessageIndex =
        nativeReplayEnabled && (request.tools?.length ?? 0) > 0
          ? await resolveNativeReplay(input)
          : new Map<number, DeepSeekNativeReplayPayloadV1>();

      const client = createOpenAICompatibleClient(provider);
      const translated = translateOpenAICompatibleMessages(
        request.messages,
        nativeReplayByMessageIndex,
      );
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

      const privateReplayCapture = nativeReplayEnabled
        ? createDeepSeekPrivateReplayCapture({
            requireReasoning: (request.tools?.length ?? 0) > 0,
          })
        : undefined;
      const state = createStreamTranslationState(signal, model.ref, privateReplayCapture);
      let finishSeen = false;
      let replayFinishComplete = false;

      try {
        for await (const part of result.fullStream) {
          if (part.type === "finish") {
            finishSeen = true;
            replayFinishComplete =
              part.finishReason === "stop" || part.finishReason === "tool-calls";
          }
          const translatedEvents = [...translateOpenAICompatiblePart(part, state)];
          if (translatedEvents.length === 0 && isProviderOutputPart(part)) {
            yield { type: "provider.activity" };
          }
          yield* translatedEvents;
        }
        if (finishSeen && privateReplayCapture !== undefined) {
          if (!replayFinishComplete) privateReplayCapture.dispose();
          const candidate = privateReplayCapture.finalize(
            model.ref.provider,
            model.ref.model,
            deepSeekReplayConnectionFingerprint(
              provider,
              model.adapterMetadata?.["openai-compatible"],
            ),
          );
          if (input.capturePrivateCompletion !== undefined) {
            input.capturePrivateCompletion(candidate);
          } else if (candidate.completeness === "COMPLETE") {
            candidate.payload.fill(0);
          }
        }
      } catch (error) {
        throw normalizeOpenAICompatibleError(error, model.ref);
      } finally {
        privateReplayCapture?.dispose();
        nativeReplayByMessageIndex.clear();
      }
    },
  };
}

async function resolveNativeReplay(
  input: ApiAdapterStreamInput,
): Promise<Map<number, DeepSeekNativeReplayPayloadV1>> {
  const resolved = new Map<number, DeepSeekNativeReplayPayloadV1>();
  const { model, request, privateReplayResolver } = input;
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role !== "assistant") continue;
    const state = message.providerState;
    if (state === undefined || state.providerId !== model.ref.provider || state.api !== model.api)
      throw replayUnavailable(model.ref.provider, model.ref);
    const metadataModel = record(state.payload).model;
    if (metadataModel !== model.ref.model) throw replayUnavailable(model.ref.provider, model.ref);
    if (privateReplayResolver === undefined) throw replayUnavailable(model.ref.provider, model.ref);

    let bytes: Uint8Array | undefined;
    try {
      bytes = await privateReplayResolver.resolve({
        providerState: state,
        providerId: model.ref.provider,
        model: model.ref,
        api: model.api,
      });
    } catch {
      throw replayUnavailable(model.ref.provider, model.ref);
    }
    if (bytes === undefined) throw replayUnavailable(model.ref.provider, model.ref);
    try {
      const replay = decodeDeepSeekNativeReplayPayload(bytes);
      if (
        replay === undefined ||
        replay.providerId !== model.ref.provider ||
        replay.model !== model.ref.model ||
        replay.api !== model.api ||
        replay.connectionFingerprint !==
          deepSeekReplayConnectionFingerprint(
            input.provider,
            model.adapterMetadata?.["openai-compatible"],
          ) ||
        replay.reasoning.state !== "PRESENT"
      )
        throw replayUnavailable(model.ref.provider, model.ref);
      assertReplayToolCalls(message.content, replay.toolCalls, model.ref.provider, model.ref);
      resolved.set(messageIndex, replay);
    } finally {
      bytes.fill(0);
    }
  }
  return resolved;
}

function assertReplayToolCalls(
  content: readonly import("../../messages/content.js").AIAssistantContent[],
  rawCalls: DeepSeekNativeReplayPayloadV1["toolCalls"],
  providerId: string,
  model: import("../../models/model-ref.js").ModelRef,
): void {
  const semanticCalls = content.filter((part) => part.type === "tool-call");
  if (semanticCalls.length !== rawCalls.length) throw replayUnavailable(providerId, model);
  for (let index = 0; index < semanticCalls.length; index += 1) {
    const semantic = semanticCalls[index];
    const raw = rawCalls[index];
    if (
      semantic === undefined ||
      semantic.type !== "tool-call" ||
      raw === undefined ||
      raw.id !== semantic.toolCallId ||
      raw.name !== semantic.toolName
    )
      throw replayUnavailable(providerId, model);
    const parsed = parseOpenAICompatibleToolInput(raw.rawArguments);
    if (parsed === undefined || !isDeepStrictEqual(parsed, semantic.input)) {
      throw replayUnavailable(providerId, model);
    }
    let direct: unknown;
    let directJson = true;
    try {
      direct = JSON.parse(raw.rawArguments) as unknown;
    } catch {
      directJson = false;
    }
    if (
      (raw.argumentMode === "PROVIDER_JSON" &&
        (!directJson || !isDeepStrictEqual(direct, semantic.input))) ||
      (raw.argumentMode === "SDK_EMPTY_INPUT_NORMALIZATION" &&
        (raw.rawArguments.trim().length !== 0 || directJson)) ||
      (raw.argumentMode === "SDK_TRAILING_COMMA_NORMALIZATION" &&
        (raw.rawArguments.trim().length === 0 || directJson))
    )
      throw replayUnavailable(providerId, model);
  }
}

function replayUnavailable(
  providerId: string,
  model: import("../../models/model-ref.js").ModelRef,
) {
  return createAIError(
    "AI_CAPABILITY_UNSUPPORTED",
    "Required native replay is unavailable for the selected conversation.",
    { providerId, model },
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isProviderOutputPart(part: import("ai").TextStreamPart<import("ai").ToolSet>): boolean {
  switch (part.type) {
    case "start":
    case "start-step":
    case "finish-step":
    case "finish":
    case "error":
    case "abort":
      return false;
    default:
      return true;
  }
}
