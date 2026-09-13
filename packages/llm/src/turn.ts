/**
 * The narrow durable-turn schema surface of `@caelush/llm`.
 *
 * This subpath is NOT model invocation. It is the durable JSON contract that
 * `agent-continuation-schema.ts` stores, so removing it would change stored data.
 * The finish reason and usage schemas stay the durable source of truth until the
 * Message System owns that contract; `LLMTurnResultSchema` went with the retired
 * model-invocation aggregate it belonged to.
 */
export { FinishReasonSchema, LLMToolCallSchema } from "./tool-call.js";
export type { FinishReason, LLMToolCall } from "./tool-call.js";
export { LLMUsageSchema } from "./usage.js";
export type { LLMUsage } from "./usage.js";
