import type { ModelMessage } from "ai";
import { createAIError } from "../../errors/ai-error.js";
import type { AIAssistantContent } from "../../messages/content.js";
import type { AIUserContent } from "../../messages/content.js";
import type {
  AIAssistantMessage,
  AIMessage,
  AIToolResultMessage,
  AIUserMessage,
} from "../../messages/message.js";
import type { DeepSeekNativeReplayPayloadV1 } from "./private-replay.js";

type AssistantModelMessage = Extract<ModelMessage, { role: "assistant" }>;
type ToolModelMessage = Extract<ModelMessage, { role: "tool" }>;
type UserModelMessage = Extract<ModelMessage, { role: "user" }>;
type AssistantPart = Exclude<AssistantModelMessage["content"], string>[number];

/** The translated request prompt: optional instructions plus the message list. */
export interface TranslatedMessages {
  readonly instructions?: string;
  readonly messages: readonly ModelMessage[];
}

/**
 * Translate the AI-local message list into the OpenAI-compatible dialect.
 *
 * System messages become `instructions` rather than a message, matching the
 * long-standing behaviour of this dialect: several system messages are joined with
 * a blank line and removed from the message list. The join order is the caller's
 * order and is never sorted, so prompt caching over a stable prefix keeps working.
 *
 * A tool result keeps its success/error distinction through the provider-native
 * `text` / `error-text` output variants. Those variants exist only here, inside the
 * adapter.
 */
export function translateOpenAICompatibleMessages(
  messages: readonly AIMessage[],
  nativeReplayByMessageIndex: ReadonlyMap<number, DeepSeekNativeReplayPayloadV1> = new Map(),
): TranslatedMessages {
  const systemMessages: string[] = [];
  const translated: ModelMessage[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    switch (message.role) {
      case "system":
        systemMessages.push(message.content);
        break;
      case "user":
        translated.push(toUserMessage(message));
        break;
      case "assistant":
        translated.push(toAssistantMessage(message, nativeReplayByMessageIndex.get(messageIndex)));
        break;
      case "tool":
        translated.push(toToolMessage(message));
        break;
    }
  }

  return {
    ...(systemMessages.length === 0 ? {} : { instructions: systemMessages.join("\n\n") }),
    messages: translated,
  };
}

function toUserMessage(message: AIUserMessage): UserModelMessage {
  if (typeof message.content === "string") return { role: "user", content: message.content };
  return {
    role: "user",
    content: message.content.map((part) => toUserContent(part)),
  };
}

function toUserContent(part: AIUserContent): Exclude<UserModelMessage["content"], string>[number] {
  if (part.type === "text") return { type: "text", text: part.text };
  return { type: "image", image: part.data, mediaType: part.mediaType };
}

function toAssistantMessage(
  message: AIAssistantMessage,
  replay?: DeepSeekNativeReplayPayloadV1,
): AssistantModelMessage {
  const rawToolArguments = new Map(replay?.toolCalls.map((call) => [call.id, call]) ?? []);
  const content: AssistantPart[] = [];
  if (replay?.reasoning.state === "PRESENT") {
    content.push({ type: "reasoning", text: replay.reasoning.content });
  }
  for (const part of message.content) {
    if (part.type === "text") {
      content.push(toAssistantContent(part));
      continue;
    }
    const raw = rawToolArguments.get(part.toolCallId);
    if (part.type === "tool-call-rejected") {
      // A rejected call is replayed with the exact argument bytes when the private artifact holds
      // them. Without it the in-memory message has no bytes at all, so the wire states "no complete
      // arguments" rather than substituting an object the model never produced.
      content.push({
        type: "tool-call" as const,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: {},
        providerOptions: {
          openaiCompatible: {
            function: { name: part.toolName, arguments: raw?.rawArguments ?? "" },
          },
        },
      });
      continue;
    }
    content.push(
      raw === undefined
        ? toAssistantContent(part)
        : {
            type: "tool-call" as const,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            providerOptions: {
              openaiCompatible: {
                function: { name: part.toolName, arguments: raw.rawArguments },
              },
            },
          },
    );
  }
  return {
    role: "assistant",
    content,
    ...(replay?.reasoning.state === "PRESENT"
      ? { providerOptions: { openaiCompatible: { reasoning_content: replay.reasoning.content } } }
      : {}),
  };
}

function toAssistantContent(part: AIAssistantContent): AssistantPart {
  if (part.type === "text") {
    return { type: "text" as const, text: part.text };
  }
  if (part.type === "tool-call-rejected") {
    // Reached only when no private artifact supplied the received bytes: the wire then states that
    // the call carried no complete arguments, which is true, instead of inventing an object.
    return {
      type: "tool-call" as const,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: {},
      providerOptions: {
        openaiCompatible: { function: { name: part.toolName, arguments: "" } },
      },
    };
  }
  return {
    type: "tool-call" as const,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
  };
}

function toToolMessage(message: AIToolResultMessage): ToolModelMessage {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((part) => {
            if (part.type === "image") {
              throw createAIError(
                "AI_CAPABILITY_UNSUPPORTED",
                "OpenAI-compatible adapters do not support images in Tool results.",
              );
            }
            return part.text;
          })
          .join("");
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        output: message.isError
          ? { type: "error-text" as const, value: content }
          : { type: "text" as const, value: content },
      },
    ],
  };
}
