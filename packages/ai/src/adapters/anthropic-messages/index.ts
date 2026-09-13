/**
 * `@caelush/ai/adapters/anthropic-messages` — the native Anthropic Messages runtime.
 *
 * This subpath implements the frozen `ApiAdapter` over the native HTTP + SSE
 * protocol using `fetch` and a local SSE parser. It imports no provider SDK at all,
 * which is what makes the `ApiAdapter` abstraction meaningful: a dialect with
 * nothing in common with the OpenAI-compatible one is served by the same gateway,
 * the same registry and the same catalog without a single change to the frozen AI
 * core contracts.
 *
 * The public surface is deliberately tiny: a factory returning the frozen
 * `ApiAdapter`, plus the dialect id. Every translator, parser and normaliser stays
 * internal, so no provider-native type can reach a public contract.
 */
export { createAnthropicMessagesApiAdapter, ANTHROPIC_MESSAGES_API_ID } from "./adapter.js";
