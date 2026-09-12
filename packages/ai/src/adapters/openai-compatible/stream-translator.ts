import type { TextStreamPart, ToolSet } from "ai";
import { createAIError } from "../../errors/ai-error.js";
import { normalizeOpenAICompatibleError } from "./error-normalizer.js";
import { parseOpenAICompatibleToolInput } from "./tool-call-parser.js";
import {
  assertRawToolCallIdentity,
  createRawStreamState,
  observeRawFinishReason,
} from "./raw-tool-state.js";
import { mapOpenAICompatibleFinishReason } from "./finish-reason.js";
import { normalizeAISDKUsage } from "./usage-normalizer.js";
import type { AIAdapterEvent } from "../api-adapter-event.js";
import type { ModelRef } from "../../models/model-ref.js";
import type { RawStreamState } from "./raw-tool-state.js";

/**
 * The CAELUSH tool-name shape, reproduced here as an adapter-private guard.
 *
 * A provider that returns a name outside this shape has produced a response the
 * core cannot route, so the stream fails closed instead of surfacing a tool call
 * nothing can execute.
 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

interface ToolLifecycle {
  readonly name: string;
  completed: boolean;
}

/** Per-turn state of the stream translation. */
export interface StreamTranslationState {
  readonly toolLifecycles: Map<string, ToolLifecycle>;
  readonly raw: RawStreamState;
  readonly signal: AbortSignal;
  readonly model: ModelRef;
}

/** Create the per-turn stream translation state. */
export function createStreamTranslationState(
  signal: AbortSignal,
  model: ModelRef,
): StreamTranslationState {
  return {
    toolLifecycles: new Map(),
    raw: createRawStreamState(),
    signal,
    model,
  };
}

/**
 * Translate one SDK stream part into zero or more adapter events.
 *
 * The adapter emits only `text.delta`, the tool-call lifecycle, `usage` and
 * `adapter.finish`. It never emits a gateway envelope event, because
 * `AIAdapterEvent` has no such variants.
 *
 * Reasoning parts are dropped. The pinned SDK sources them from the provider's raw
 * `reasoning_content` / `reasoning` delta, which is undisclosed chain-of-thought,
 * and raw model reasoning must never enter a public contract. This dialect has no
 * verified *summary* source, so no `reasoning.summary.delta` is produced at all
 * rather than publishing chain-of-thought under a summary name.
 */
export function* translateOpenAICompatiblePart(
  part: TextStreamPart<ToolSet>,
  state: StreamTranslationState,
): Generator<AIAdapterEvent> {
  switch (part.type) {
    case "raw": {
      observeRawFinishReason(part.rawValue, state.raw);
      try {
        assertRawToolCallIdentity(part.rawValue, state.raw);
      } catch {
        throw invalidResponse(state, "The stream contained ambiguous tool identity.");
      }
      return;
    }

    case "text-delta": {
      if (part.text.length > 0) yield { type: "text.delta", payload: { text: part.text } };
      return;
    }

    case "tool-input-start": {
      assertToolName(part.toolName, state);
      if (state.toolLifecycles.has(part.id)) {
        throw invalidResponse(state, "The stream repeated a tool call id.");
      }
      state.toolLifecycles.set(part.id, { name: part.toolName, completed: false });
      yield {
        type: "tool_call.start",
        payload: { toolCallId: part.id, toolName: part.toolName },
      };
      return;
    }

    case "tool-input-delta": {
      const lifecycle = state.toolLifecycles.get(part.id);
      if (lifecycle === undefined || lifecycle.completed) {
        throw invalidResponse(state, "The stream emitted an inactive tool input delta.");
      }
      yield { type: "tool_call.delta", payload: { toolCallId: part.id, delta: part.delta } };
      return;
    }

    case "tool-call": {
      const input = parseOpenAICompatibleToolInput(part.input);
      if (input === undefined) {
        throw invalidResponse(state, "The stream returned an invalid tool call.");
      }
      if (part.toolCallId.length === 0) {
        throw invalidResponse(state, "The stream returned a tool call without identity.");
      }
      assertToolName(part.toolName, state);

      const call = { id: part.toolCallId, name: part.toolName, input };
      const lifecycle = state.toolLifecycles.get(call.id);
      if (lifecycle === undefined) {
        // The SDK buffered the call until a late function name arrived, so the
        // lifecycle is announced here from the completed call.
        state.toolLifecycles.set(call.id, { name: call.name, completed: false });
        yield { type: "tool_call.start", payload: { toolCallId: call.id, toolName: call.name } };
        yield {
          type: "tool_call.delta",
          payload: { toolCallId: call.id, delta: JSON.stringify(call.input) },
        };
      } else if (lifecycle.completed || lifecycle.name !== call.name) {
        throw invalidResponse(state, "The stream changed a completed tool call.");
      }

      const current = state.toolLifecycles.get(call.id);
      if (current === undefined) {
        throw invalidResponse(state, "The stream lost a tool call lifecycle.");
      }
      current.completed = true;
      yield { type: "tool_call.completed", payload: call };
      return;
    }

    case "finish-step": {
      const usage = normalizeAISDKUsage(part.usage);
      if (usage !== undefined) yield { type: "usage", payload: usage };
      return;
    }

    case "finish": {
      const finalUsage = normalizeAISDKUsage(part.totalUsage);
      const finishReason = mapOpenAICompatibleFinishReason(part.finishReason);
      // The provider-native reason is preferred so a mapped `OTHER` stays
      // lossless; the SDK's normalised value is the fallback.
      const providerReason = state.raw.nativeFinishReason() ?? part.finishReason;
      yield {
        type: "adapter.finish",
        payload: {
          finishReason,
          ...(finalUsage === undefined ? {} : { finalUsage }),
          ...(providerReason.length === 0 ? {} : { providerReason }),
        },
      };
      return;
    }

    case "error":
      throw normalizeOpenAICompatibleError(part.error, state.model);

    case "abort": {
      // A gateway-owned abort is a cancellation, not a malformed response. Only a
      // stream that stopped without our signal is treated as a broken stream.
      if (state.signal.aborted) {
        throw createAIError("AI_ABORTED", undefined, {
          providerId: state.model.provider,
          model: state.model,
        });
      }
      throw invalidResponse(state, "The stream aborted before completion.");
    }

    default:
      // Reasoning, source, file, tool-result and step boundary parts are not part
      // of the frozen adapter contract.
      return;
  }
}

function assertToolName(name: string, state: StreamTranslationState): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw invalidResponse(state, "The stream returned an invalid tool name.");
  }
}

function invalidResponse(
  state: StreamTranslationState,
  message: string,
): ReturnType<typeof createAIError> {
  return createAIError("AI_INVALID_RESPONSE", message, {
    providerId: state.model.provider,
    model: state.model,
  });
}
