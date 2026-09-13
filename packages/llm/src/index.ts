/**
 * The compatibility facade of `@caelush/llm`.
 *
 * Phase 2D retired this package's model-invocation surface: the gateway, provider
 * contract, provider registry, request schema, capabilities, normalised stream
 * events, abort scope, stream validator, wire diagnostic, error hierarchy and the
 * OpenAI-compatible provider facade are gone, and `@caelush/ai` owns model
 * invocation exclusively.
 *
 * What remains is durable conversation compatibility, and only that:
 *
 * ```text
 * ./messages   the persisted conversation message codec, including the durable
 *              `rawArtifactRef` recovery pointer
 * ./turn       the persisted finish-reason and usage schemas
 * ```
 *
 * The root entry re-exports both so a host has one stable import for the remaining
 * surface. The package is no longer a model invocation authority, and it no longer
 * depends on `@caelush/ai`.
 */
export {
  LLMAssistantContentSchema,
  LLMAssistantMessageSchema,
  LLMMessageSchema,
  LLMSystemMessageSchema,
  LLMToolResultMessageSchema,
  LLMUserMessageSchema,
} from "./messages.js";
export type {
  LLMAssistantContent,
  LLMAssistantMessage,
  LLMMessage,
  LLMSystemMessage,
  LLMToolResultMessage,
  LLMUserMessage,
} from "./messages.js";
export { FinishReasonSchema, LLMToolCallSchema } from "./tool-call.js";
export type { FinishReason, LLMToolCall } from "./tool-call.js";
export { LLMUsageSchema } from "./usage.js";
export type { LLMUsage } from "./usage.js";
