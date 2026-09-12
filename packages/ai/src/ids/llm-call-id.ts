import { v7 } from "uuid";

/**
 * AI-domain model invocation identity.
 *
 * The frozen V2 interface keeps the `LLMCallId` field semantics of the legacy
 * `@caelush/llm` contract: one provider turn, one gateway-owned call id, in the
 * compatible `llm_<UUIDv7>` format.
 *
 * The Protocol package holds a same-named *wire* identity. Because
 * `@caelush/ai` may not depend on `@caelush/protocol`, the AI runtime owns its
 * own copy of the type here, and Phase 2C will introduce the explicit
 * projection at the Daemon / Protocol boundary. Phase 2A changes no Protocol id.
 */
export type LLMCallId = string & { readonly __llmCallIdBrand: "LLMCallId" };

/** The frozen `llm_<UUIDv7>` identity shape. */
export const LLM_CALL_ID_PATTERN =
  /^llm_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Runtime validation for a model invocation identity. */
export function isLLMCallId(value: string): boolean {
  return LLM_CALL_ID_PATTERN.test(value);
}

/**
 * Create a new model invocation identity.
 *
 * The gateway owns the lifecycle: it mints the id during preflight. Providers
 * and adapters must forward it, never generate their own.
 */
export function createLLMCallId(): LLMCallId {
  return `llm_${v7()}` as LLMCallId;
}

/**
 * The gateway-owned call id source.
 *
 * Injected so tests can produce deterministic identities without weakening the
 * production format.
 */
export interface LLMCallIdFactory {
  create(): LLMCallId;
}

/** The production call id factory. */
export const defaultLLMCallIdFactory: LLMCallIdFactory = {
  create: createLLMCallId,
};
