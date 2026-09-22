export {
  assertAIContent,
  assertAIAssistantContent,
  isAIContent,
  isAIAssistantContent,
} from "./content.js";
export type {
  AIAssistantContent,
  AIAssistantTextContent,
  AIAssistantToolCallContent,
  AIContent,
  AITextContent,
  AIToolCallContent,
} from "./content.js";

export {
  assertAIProviderOpaqueState,
  providerStateMatches,
  AI_PROVIDER_OPAQUE_STATE_KEYS,
  AI_PROVIDER_OPAQUE_STATE_VERSION,
} from "./provider-state.js";
export type { AIProviderOpaqueState } from "./provider-state.js";

export { assertAIConversationMessage, assertAIMessage, assertAIMessages } from "./message.js";
export type {
  AIAssistantMessage,
  AIConversationMessage,
  AIMessage,
  AISystemMessage,
  AIToolResultMessage,
  AIUserMessage,
} from "./message.js";
