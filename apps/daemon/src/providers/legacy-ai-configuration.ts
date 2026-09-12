import {
  createOpenAICompatibleApiAdapter,
  OPENAI_COMPATIBLE_API_ID,
} from "@caelush/ai/adapters/openai-compatible";
import type {
  AIProviderBinding,
  EnumerableModelDescriptorSourcePort,
  ModelDescriptor,
  ModelDescriptorSourcePort,
} from "@caelush/ai";
import type { DaemonModelProviderConfig } from "./model-canonicalizer.js";

/**
 * The transitional legacy-AI configuration adapter.
 *
 * A legacy provider configuration — environment variables, or a host DTO — becomes
 * AI-native composition input: one `AIProviderBinding` per provider, plus model
 * descriptor sources. The user-visible environment format does not change; only the
 * internal ownership does.
 */

/**
 * The conservative legacy fallback, used only when an old deployment configured no
 * model profile for a model it was already allowed to run.
 *
 * It is deliberately small and never a guess: the legacy provider never owned a model
 * window, and inventing a large one would silently claim capacity the operator never
 * configured. Phase 2C does not converge this with real model metadata; that is a
 * later concern.
 */
export const LEGACY_FALLBACK_CONTEXT_WINDOW_TOKENS = 16_000;
export const LEGACY_FALLBACK_MAX_OUTPUT_TOKENS = 4_096;

/** Project one legacy provider configuration onto an AI provider binding. */
export function toAIProviderBinding(config: DaemonModelProviderConfig): AIProviderBinding {
  return {
    id: config.provider,
    endpoint: config.baseUrl,
    defaultApi: OPENAI_COMPATIBLE_API_ID,
    ...(config.allowedModels === undefined ? {} : { allowedModels: config.allowedModels }),
    // The legacy contract allowed any model id of a configured provider unless an
    // allowlist restricted it, so a legacy deployment keeps exactly that behaviour.
    allowUnknownModels: true,
    credentials: {
      resolve: () => Promise.resolve(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    },
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.queryParams === undefined ? {} : { queryParams: config.queryParams }),
    ...(config.fetch === undefined ? {} : { transport: { fetch: config.fetch } }),
  };
}

/**
 * Build the model descriptor sources for one legacy provider.
 *
 * - `CONFIGURATION` describes every model the operator explicitly configured through
 *   the model-profile environment value. Capabilities the legacy profile does not
 *   state stay `UNKNOWN` rather than being claimed as `SUPPORTED`.
 * - `FALLBACK` describes anything else the provider is allowed to run, with the
 *   conservative legacy window and `source: "FALLBACK"`, which is what makes the AI
 *   gateway accept it only because the binding sets `allowUnknownModels`.
 */
export function toModelDescriptorSources(
  config: DaemonModelProviderConfig,
): readonly ModelDescriptorSourcePort[] {
  const configured = toConfiguredSource(config);
  return configured === undefined ? [fallbackSource(config)] : [configured, fallbackSource(config)];
}

function toConfiguredSource(
  config: DaemonModelProviderConfig,
): EnumerableModelDescriptorSourcePort | undefined {
  const profiles = config.modelProfiles;
  if (profiles === undefined || Object.keys(profiles).length === 0) return undefined;

  const descriptors = Object.entries(profiles).map(([model, profile]): ModelDescriptor =>
    descriptorFor(config.provider, model, profile),
  );

  return {
    id: `${config.provider}-configuration`,
    priority: 0,
    resolve: (ref) =>
      ref.provider === config.provider
        ? descriptors.find((descriptor) => descriptor.ref.model === ref.model)
        : undefined,
    list: () => descriptors,
  };
}

function fallbackSource(config: DaemonModelProviderConfig): ModelDescriptorSourcePort {
  return {
    id: `${config.provider}-legacy-fallback`,
    priority: 100,
    resolve: (ref) =>
      ref.provider === config.provider
        ? descriptorFor(config.provider, ref.model, undefined)
        : undefined,
  };
}

function descriptorFor(
  provider: string,
  model: string,
  profile: DaemonModelProviderConfig["modelProfiles"] extends
    Readonly<Record<string, infer T>> | undefined
    ? T | undefined
    : never,
): ModelDescriptor {
  const contextWindowTokens = profile?.contextWindowTokens ?? LEGACY_FALLBACK_CONTEXT_WINDOW_TOKENS;
  const configuredMaxOutput = profile?.maxOutputTokens;
  const maxOutputTokens =
    configuredMaxOutput === undefined
      ? Math.min(LEGACY_FALLBACK_MAX_OUTPUT_TOKENS, contextWindowTokens)
      : Math.min(configuredMaxOutput, contextWindowTokens);

  return {
    ref: { provider, model },
    api: OPENAI_COMPATIBLE_API_ID,
    limits: { contextWindowTokens, maxOutputTokens },
    capabilities: {
      streaming: "SUPPORTED",
      // The legacy configuration says nothing about these, so they stay UNKNOWN: a
      // descriptor must never manufacture a capability guarantee.
      toolCalling: "UNKNOWN",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoning: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
      promptCaching: profile?.supportsPromptCaching === true ? "SUPPORTED" : "UNKNOWN",
      usageReporting: profile?.supportsUsageReporting === true ? "SUPPORTED" : "UNKNOWN",
    },
    source: profile === undefined ? "FALLBACK" : "CONFIGURATION",
  };
}

/** The single OpenAI-compatible adapter every legacy provider shares. */
export function createDaemonApiAdapters() {
  return [createOpenAICompatibleApiAdapter()] as const;
}
