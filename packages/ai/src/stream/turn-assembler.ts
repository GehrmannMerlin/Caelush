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
import type { AIContent } from "../messages/content.js";
import type { AIMessagePhase, AIModelTurnAssistantItem } from "../messages/assistant-item.js";

type MutableAssistantPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: AIToolCall["input"] }
  | { type: "PENDING_TOOL_CALL"; toolCallId: string };

interface MutableAssistantItem {
  readonly assistantItemId: string;
  readonly phase: AIMessagePhase;
  readonly content: MutableAssistantPart[];
}

/**
 * Assembles one settled turn from a public event sequence.
 *
 * The assembler is the only place that turns a stream into durable-shaped data,
 * so the aggregation rules exist once:
 *
 * ```text
 * assistant items         source ordered, with text/tool-call interleaving retained
 * item phase               explicit adapter phase, otherwise UNKNOWN
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
  let usage: ModelUsage | undefined;
  let finishReason: AIModelTurnResult["finishReason"] | undefined;
  let streamError: AISerializableError | undefined;
  const items = new Map<string, MutableAssistantItem>();
  const itemOrder: string[] = [];
  const closedItems = new Set<string>();
  let activeItemId: string | undefined;
  const toolCallItems = new Map<string, string>();
  const toolCallOrder: string[] = [];
  const toolCalls = new Map<string, AIToolCall>();

  function failInvalidResponse(message: string): never {
    throw createAIError("AI_INVALID_RESPONSE", message, {
      ...(providerId === undefined ? {} : { providerId }),
      ...(model === undefined ? {} : { model }),
    });
  }

  function itemFor(assistantItemId: string, phase: AIMessagePhase): MutableAssistantItem {
    if (closedItems.has(assistantItemId)) {
      return failInvalidResponse("AI adapter resumed an assistant item after a later item began.");
    }
    if (activeItemId !== undefined && activeItemId !== assistantItemId) {
      closedItems.add(activeItemId);
    }
    activeItemId = assistantItemId;
    const existing = items.get(assistantItemId);
    if (existing !== undefined) {
      if (existing.phase !== phase) {
        return failInvalidResponse("AI adapter changed phase within one assistant item.");
      }
      return existing;
    }
    const created: MutableAssistantItem = {
      assistantItemId,
      phase,
      content: [],
    };
    items.set(assistantItemId, created);
    itemOrder.push(assistantItemId);
    return created;
  }

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
          {
            const item = itemFor(
              event.payload.assistantItemId ?? fallbackAssistantItemId(callId),
              event.payload.phase ?? "UNKNOWN",
            );
            const previous = item.content[item.content.length - 1];
            if (previous?.type === "text") previous.text += event.payload.text;
            else item.content.push({ type: "text", text: event.payload.text });
          }
          return;
        case "reasoning.summary.delta":
          // A summary is display-only and deliberately never becomes durable
          // assistant text.
          return;
        case "tool_call.start": {
          if (toolCallItems.has(event.payload.toolCallId)) {
            return failInvalidResponse("AI adapter announced a Tool call more than once.");
          }
          const item = itemFor(
            event.payload.assistantItemId ?? fallbackAssistantItemId(callId),
            event.payload.phase ?? "UNKNOWN",
          );
          toolCallItems.set(event.payload.toolCallId, item.assistantItemId);
          toolCallOrder.push(event.payload.toolCallId);
          item.content.push({ type: "PENDING_TOOL_CALL", toolCallId: event.payload.toolCallId });
          return;
        }
        case "tool_call.delta":
          // Partially received argument text is never executable and is dropped.
          return;
        case "tool_call.completed": {
          const assistantItemId = toolCallItems.get(event.payload.id);
          const item = assistantItemId === undefined ? undefined : items.get(assistantItemId);
          const slot = item?.content.findIndex(
            (part) => part.type === "PENDING_TOOL_CALL" && part.toolCallId === event.payload.id,
          );
          if (item === undefined || slot === undefined || slot < 0) {
            return failInvalidResponse(
              "AI adapter completed a Tool call without its announcement.",
            );
          }
          item.content[slot] = {
            type: "tool-call",
            toolCallId: event.payload.id,
            toolName: event.payload.name,
            input: event.payload.input,
          };
          toolCalls.set(event.payload.id, event.payload);
          return;
        }
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

      const assistantItems: AIModelTurnAssistantItem[] = itemOrder.map((assistantItemId) => {
        const item = items.get(assistantItemId);
        if (item === undefined)
          return failInvalidResponse("AI assistant item disappeared during assembly.");
        const content: AIContent[] = item.content.map((part) => {
          if (part.type === "PENDING_TOOL_CALL") {
            return failInvalidResponse("AI stream finished with an incomplete Tool call item.");
          }
          return part.type === "text"
            ? { type: "text", text: part.text }
            : {
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              };
        });
        return Object.freeze({
          assistantItemId: item.assistantItemId,
          phase: item.phase,
          content: Object.freeze(content),
        });
      });
      const text = assistantItems
        .flatMap((item) => item.content)
        .filter((part): part is Extract<AIContent, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
      const completedCalls = toolCallOrder.map((toolCallId) => {
        const toolCall = toolCalls.get(toolCallId);
        if (toolCall === undefined) {
          return failInvalidResponse("AI stream finished before a Tool call was completed.");
        }
        return toolCall;
      });

      const result: {
        callId: LLMCallId;
        providerId: ProviderId;
        model: ModelRef;
        text: string;
        toolCalls: readonly AIToolCall[];
        assistantItems: readonly AIModelTurnAssistantItem[];
        finishReason: AIModelTurnResult["finishReason"];
        usage?: ModelUsage;
        resolution: AIInvocationResolution;
      } = {
        callId,
        providerId,
        model,
        text,
        toolCalls: Object.freeze(completedCalls),
        assistantItems: Object.freeze(assistantItems),
        finishReason,
        resolution,
      };

      if (usage !== undefined) result.usage = usage;
      return result;
    },
  };
}

function fallbackAssistantItemId(callId: LLMCallId | undefined): string {
  return `${callId ?? "legacy"}:item:000`;
}
