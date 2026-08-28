import type { ModelMessage } from "ai";
import type {
  LLMAssistantContent,
  LLMAssistantMessage,
  LLMMessage,
  LLMToolResultMessage,
} from "../../messages.js";

type AssistantModelMessage = Extract<ModelMessage, { role: "assistant" }>;
type ToolModelMessage = Extract<ModelMessage, { role: "tool" }>;

export function toAISDKMessages(messages: readonly LLMMessage[]): ModelMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: message.content };
      case "assistant":
        return toAssistantMessage(message);
      case "tool":
        return toToolMessage(message);
    }
  });
}

function toAssistantMessage(message: LLMAssistantMessage): AssistantModelMessage {
  return {
    role: "assistant",
    content: message.content.map(toAssistantContent),
  };
}

function toAssistantContent(part: LLMAssistantContent) {
  if (part.type === "text") {
    return { type: "text" as const, text: part.text };
  }
  return {
    type: "tool-call" as const,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
  };
}

function toToolMessage(message: LLMToolResultMessage): ToolModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        output: message.isError
          ? { type: "error-text", value: message.content }
          : { type: "text", value: message.content },
      },
    ],
  };
}
