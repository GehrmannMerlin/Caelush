/**
 * `@caelush/ai/adapters/openai-compatible` — the canonical OpenAI-compatible
 * runtime.
 *
 * This subpath is the only place in the repository allowed to import a provider
 * SDK. The public surface is deliberately tiny: a factory returning the frozen
 * {@link ApiAdapter}, plus the dialect id.
 *
 * Nothing provider-native is exported. The translators, the SDK client, the stream
 * translation state and the native request options stay internal so an SDK type
 * cannot reach a public contract.
 */
export { createOpenAICompatibleApiAdapter, OPENAI_COMPATIBLE_API_ID } from "./adapter.js";
