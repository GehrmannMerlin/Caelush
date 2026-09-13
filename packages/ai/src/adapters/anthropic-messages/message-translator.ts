import { createAIError } from "../../errors/ai-error.js";
import type { AIAssistantContent } from "../../messages/content.js";
import type { AIAssistantMessage, AIMessage, AIToolResultMessage } from "../../messages/message.js";
import type { AnthropicCacheControl } from "./tool-translator.js";
import type { JsonObject } from "../../json/json-value.js";
import type { ModelRef } from "../../models/model-ref.js";

/**
 * Native message content blocks.
 *
 * The union is deliberately private to this directory: `AIMessage` is frozen and
 * gains no thinking, signature, redacted-thinking, provider-block or provider-state
 * variant because of this dialect.
 */
export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string; readonly cache_control?: AnthropicCacheControl }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: JsonObject;
      readonly cache_control?: AnthropicCacheControl;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error: boolean;
      readonly cache_control?: AnthropicCacheControl;
    };

/** A native conversation message. */
export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly AnthropicContentBlock[];
}

/**
 * A native system prompt block.
 *
 * The system prompt is a top-level field in this dialect, never a
 * `messages[].role = "system"` entry, so leading system messages are projected out
 * of the conversation rather than kept in it.
 */
export interface AnthropicSystemBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: AnthropicCacheControl;
}

/** The translated conversation. */
export interface TranslatedAnthropicConversation {
  readonly system?: readonly AnthropicSystemBlock[];
  readonly messages: readonly AnthropicMessage[];
}

/**
 * Translate the frozen AI conversation into the Anthropic Messages dialect.
 *
 * Frozen projection rules, every one of them observable in a golden test:
 *
 * ```text
 * leading AISystemMessage[]        -> top-level system blocks, in caller order
 * a system message after any other -> AI_INVALID_REQUEST (fail closed)
 * AIUserMessage                    -> user message with one text block
 * AIAssistantMessage               -> assistant message, content order preserved
 *   AIAssistantTextContent         -> text block
 *   AIAssistantToolCallContent     -> tool_use block (id, name, input)
 * AIToolResultMessage[]            -> one user message whose content is the
 *                                     `tool_result` blocks, in caller order
 * ```
 *
 * Consecutive tool results are merged into a single native user message because that
 * is the shape the native protocol expects for a parallel batch: one user turn
 * carrying every `tool_result`. The merge preserves the caller's order exactly and
 * never reorders, sorts or deduplicates, so a batch answered in completion order
 * still reaches the provider in the order the caller supplied.
 *
 * `effort`/`thinking`/`cache` are *not* applied here: this function is a pure
 * projection of the caller's semantic messages, and cache markers are attached
 * afterwards at the fixed tail position.
 */
export function translateAnthropicMessages(
  messages: readonly AIMessage[],
  model: ModelRef,
): TranslatedAnthropicConversation {
  const system: AnthropicSystemBlock[] = [];
  const translated: AnthropicMessage[] = [];
  const toolNamesByCallId = new Map<string, string>();
  const answeredToolCallIds = new Set<string>();
  /**
   * Tool call ids announced by the assistant and not yet answered.
   *
   * A batch stays "open" across several consecutive tool-result messages, so the
   * gate is the set rather than a single flag: a boolean would either reject the
   * second result of a parallel batch or accept a continuation that abandons the
   * batch entirely.
   */
  const unansweredToolCallIds = new Set<string>();
  /** The tool_result blocks accumulated for the current native user message. */
  let pendingToolResults: AnthropicContentBlock[] = [];
  let conversationStarted = false;

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    translated.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      // A system instruction that appears after the conversation began cannot be
      // hoisted to the top-level system prompt without reordering the caller's
      // semantics, so it fails closed instead of being silently moved.
      if (conversationStarted) {
        throw invalid(
          "AI message list has a system message after the conversation started; the Anthropic Messages dialect can only project leading system messages.",
          model,
        );
      }
      system.push({ type: "text", text: message.content });
      continue;
    }

    conversationStarted = true;

    if (message.role === "tool") {
      pendingToolResults.push(
        toToolResultBlock(
          message,
          toolNamesByCallId,
          answeredToolCallIds,
          unansweredToolCallIds,
          model,
        ),
      );
      continue;
    }

    flushToolResults();

    // A continuation that abandons a pending tool batch is a structurally broken
    // conversation: the provider must not be the one to discover it.
    if (unansweredToolCallIds.size > 0) {
      throw invalid(
        `AI message list continues with a non-tool message while the tool call "${firstOf(unansweredToolCallIds)}" is still awaiting its result.`,
        model,
      );
    }

    if (message.role === "user") {
      translated.push({ role: "user", content: [{ type: "text", text: message.content }] });
      continue;
    }

    translated.push(toAssistantMessage(message, toolNamesByCallId, unansweredToolCallIds, model));
  }

  flushToolResults();

  if (unansweredToolCallIds.size > 0) {
    throw invalid(
      `AI message list ends with the unresolved tool call "${firstOf(unansweredToolCallIds)}".`,
      model,
    );
  }

  return {
    ...(system.length === 0 ? {} : { system }),
    messages: translated,
  };
}

function firstOf(ids: ReadonlySet<string>): string {
  for (const id of ids) return id;
  return "";
}

function toAssistantMessage(
  message: AIAssistantMessage,
  toolNamesByCallId: Map<string, string>,
  unansweredToolCallIds: Set<string>,
  model: ModelRef,
): AnthropicMessage {
  const content = message.content.map((part) =>
    toAssistantContent(part, toolNamesByCallId, unansweredToolCallIds, model),
  );
  return { role: "assistant", content };
}

function toAssistantContent(
  part: AIAssistantContent,
  toolNamesByCallId: Map<string, string>,
  unansweredToolCallIds: Set<string>,
  model: ModelRef,
): AnthropicContentBlock {
  if (part.type === "text") return { type: "text", text: part.text };

  if (toolNamesByCallId.has(part.toolCallId)) {
    throw invalid(
      `AI message list declares the tool call id "${part.toolCallId}" more than once.`,
      model,
    );
  }
  toolNamesByCallId.set(part.toolCallId, part.toolName);
  unansweredToolCallIds.add(part.toolCallId);

  return {
    type: "tool_use",
    id: part.toolCallId,
    name: part.toolName,
    input: part.input,
  };
}

function toToolResultBlock(
  message: AIToolResultMessage,
  toolNamesByCallId: ReadonlyMap<string, string>,
  answeredToolCallIds: Set<string>,
  unansweredToolCallIds: Set<string>,
  model: ModelRef,
): AnthropicContentBlock {
  const originatingName = toolNamesByCallId.get(message.toolCallId);
  if (originatingName === undefined) {
    throw invalid(
      `AI tool result message references the unknown tool call id "${message.toolCallId}".`,
      model,
    );
  }
  if (originatingName !== message.toolName) {
    throw invalid(
      `AI tool result message names the tool "${message.toolName}" but the tool call id "${message.toolCallId}" was a "${originatingName}" call.`,
      model,
    );
  }
  if (answeredToolCallIds.has(message.toolCallId)) {
    throw invalid(
      `AI message list answers the tool call id "${message.toolCallId}" more than once.`,
      model,
    );
  }
  answeredToolCallIds.add(message.toolCallId);
  unansweredToolCallIds.delete(message.toolCallId);

  return {
    type: "tool_result",
    tool_use_id: message.toolCallId,
    content: message.content,
    is_error: message.isError,
  };
}

function invalid(message: string, model: ModelRef) {
  return createAIError("AI_INVALID_REQUEST", message, {
    providerId: model.provider,
    model,
  });
}
