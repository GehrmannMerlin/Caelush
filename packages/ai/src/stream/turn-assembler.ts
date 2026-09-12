import { createAIError } from "../errors/ai-error.js";
import { isAIErrorCode } from "../errors/ai-error-code.js";
import type { AIInvocationResolution } from "../request/resolved-model-request.js";
import type { AIStreamEvent } from "./events.js";
import type { AISerializableError } from "../errors/serializable-error.js";
import type { AIToolCall } from "../tools/tool-call.js";
import type { LLMCallId } from "../ids/llm-call-id.js";
import type { ModelRef } from "../models/model-ref.js";
import type { ModelUsage } from "../models/model-usage.js";
import type { ProviderId } from "../ids/provider-id.js";
import type { AIModelTurnResult } from "../models/model-turn-result.js";

/**
 * Assembles one settled turn from a public event sequence.
 *
 * The assembler is the only place that turns a stream into durable-shaped data,
 * so the aggregation rules exist once:
 *
 * ```text
 * text                     concatenated deltas
 * tool calls               completed calls only, in announcement order
 * usage                    finalUsage, else the last usage snapshot
 * reasoning summary        never durable
 * provider finish reason   never durable
 * stream.error             no result
 * unfinished stream        no result
 * ```
 */
export interface AIModelTurnAssembler {
  accept(event: AIStreamEvent): void;
  result(): AIModelTurnResult;
}

/** Create an assembler for one stream. */
export function createAIModelTurnAssembler(): AIModelTurnAssembler {
  let state: "NOT_STARTED" | "STARTED" | "FINISHED" | "ERRORED" = "NOT_STARTED";
  let callId: LLMCallId | undefined;
  let providerId: ProviderId | undefined;
  let model: ModelRef | undefined;
  let resolution: AIInvocationResolution | undefined;
  let text = "";
  let usage: ModelUsage | undefined;
  let finishReason: AIModelTurnResult["finishReason"] | undefined;
  let streamError: AISerializableError | undefined;
  const toolCalls: AIToolCall[] = [];

  return {
    accept(event: AIStreamEvent): void {
      switch (event.type) {
        case "stream.start":
          callId = event.payload.callId;
          providerId = event.payload.providerId;
          model = event.payload.model;
          resolution = event.payload.resolution;
          state = "STARTED";
          return;
        case "text.delta":
          text += event.payload.text;
          return;
        case "reasoning.summary.delta":
          // A summary is display-only and deliberately never becomes durable
          // assistant text.
          return;
        case "tool_call.start":
        case "tool_call.delta":
          // Partially received argument text is never executable and is dropped.
          return;
        case "tool_call.completed":
          toolCalls.push(event.payload);
          return;
        case "usage":
          usage = event.payload;
          return;
        case "stream.finish":
          finishReason = event.payload.finishReason;
          if (event.payload.finalUsage !== undefined) usage = event.payload.finalUsage;
          state = "FINISHED";
          return;
        case "stream.error":
          streamError = event.payload.error;
          state = "ERRORED";
          return;
        default:
          return;
      }
    },

    result(): AIModelTurnResult {
      if (state === "ERRORED" && streamError !== undefined) {
        const error = streamError;
        throw createAIError(
          isAIErrorCode(error.code) ? error.code : "AI_PROVIDER_ERROR",
          error.message,
          {
            ...(error.providerId === undefined ? {} : { providerId: error.providerId }),
            ...(error.model === undefined ? {} : { model: error.model }),
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
          },
        );
      }
      if (state !== "FINISHED" || finishReason === undefined) {
        throw createAIError(
          "AI_INVALID_RESPONSE",
          "AI stream did not finish and has no turn result.",
        );
      }
      if (
        callId === undefined ||
        providerId === undefined ||
        model === undefined ||
        resolution === undefined
      ) {
        throw createAIError(
          "AI_INVALID_RESPONSE",
          "AI stream did not start and has no turn result.",
        );
      }

      const result: {
        callId: LLMCallId;
        providerId: ProviderId;
        model: ModelRef;
        text: string;
        toolCalls: readonly AIToolCall[];
        finishReason: AIModelTurnResult["finishReason"];
        usage?: ModelUsage;
        resolution: AIInvocationResolution;
      } = {
        callId,
        providerId,
        model,
        text,
        toolCalls: Object.freeze([...toolCalls]),
        finishReason,
        resolution,
      };

      if (usage !== undefined) result.usage = usage;
      return result;
    },
  };
}
