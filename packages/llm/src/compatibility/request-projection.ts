import type { ToolDefinition } from "@caelush/protocol";
import { toAIModelRef } from "./legacy-json.js";
import type { AIMessage, AIModelRequest, AIToolChoice, AIToolSpec } from "@caelush/ai";
import type { LLMMessage } from "../messages.js";
import type { LLMRequest, LLMToolChoice } from "../request.js";

/**
 * Project a legacy request onto the frozen AI request contract.
 *
 * This is the whole of the legacy request adaptation. It performs no provider work:
 * message shaping, tool shaping and settings shaping only.
 */
export function toAIModelRequest(request: LLMRequest): AIModelRequest {
  const settings = toSettings(request);

  return {
    model: toAIModelRef(request.model),
    messages: request.messages.map(toAIMessage),
    ...(request.tools === undefined ? {} : { tools: request.tools.map(toAIToolSpec) }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: toAIToolChoice(request.toolChoice) }),
    ...(settings === undefined ? {} : { settings }),
  };
}

/**
 * Project one legacy message.
 *
 * The legacy tool-result message carries an extra `rawArtifactRef` pointer that is a
 * durable-recovery concern for the Context runtime, not provider input. Its own
 * contract says provider adapters omit it, so the projection drops it here rather
 * than sending a host pointer to a provider.
 */
export function toAIMessage(message: LLMMessage): AIMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return { role: "assistant", content: [...message.content] };
    case "tool":
      return {
        role: "tool",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
        isError: message.isError,
      };
  }
}

/**
 * Project a legacy `ToolDefinition` onto the model-facing tool spec.
 *
 * Only `name`, `description` and `inputSchema` are taken. `outputSchema`,
 * `riskLevel`, `requiredCapabilities`, `runtimeRequirements` and any handler are
 * Caelush runtime metadata: they are dropped here, at the legacy boundary, so the AI
 * adapter never sees them and they cannot reach a provider request.
 */
export function toAIToolSpec(definition: ToolDefinition): AIToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}

/** Project the legacy tool choice onto the frozen AI tool choice. */
export function toAIToolChoice(choice: LLMToolChoice): AIToolChoice {
  switch (choice.type) {
    case "AUTO":
      return { type: "AUTO" };
    case "NONE":
      return { type: "NONE" };
    case "REQUIRED":
      return { type: "REQUIRED" };
    case "TOOL":
      return { type: "TOOL", toolName: choice.toolName };
  }
}

function toSettings(
  request: LLMRequest,
): { maxOutputTokens?: number; temperature?: number } | undefined {
  const settings: { maxOutputTokens?: number; temperature?: number } = {};
  if (request.maxOutputTokens !== undefined) settings.maxOutputTokens = request.maxOutputTokens;
  if (request.temperature !== undefined) settings.temperature = request.temperature;
  return Object.keys(settings).length === 0 ? undefined : settings;
}
