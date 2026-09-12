import { toAIModelRef } from "./legacy-json.js";
import type { CapabilitySupport, LLMCapabilities } from "../capabilities.js";
import type {
  CapabilitySupport as AICapabilitySupport,
  ModelCapabilities,
  ModelDescriptor,
} from "@caelush/ai";
import type { ModelRef } from "@caelush/protocol";

/**
 * The legacy fallback window, used only when a legacy provider declares no explicit
 * limits.
 *
 * The frozen interface freeze allows exactly this: the legacy provider has never
 * owned a model window, and a compatibility transport still needs *some* descriptor.
 * It is deliberately marked `FALLBACK` so nothing can mistake it for model
 * authority, and the real authority convergence belongs to Phase 2C.
 */
export const LEGACY_FALLBACK_CONTEXT_WINDOW_TOKENS = 16_384;
export const LEGACY_FALLBACK_MAX_OUTPUT_TOKENS = 4_096;

/** Project the legacy capability record onto the frozen AI capability record. */
export function toModelCapabilities(capabilities: LLMCapabilities): ModelCapabilities {
  return {
    streaming: toCapabilitySupport(capabilities.textStreaming),
    toolCalling: toCapabilitySupport(capabilities.toolCalling),
    parallelToolCalls: toCapabilitySupport(capabilities.parallelToolCalls),
    structuredOutput: toCapabilitySupport(capabilities.structuredOutput),
    vision: toCapabilitySupport(capabilities.vision),
    // The legacy record carries no information about these three. UNKNOWN is the
    // honest projection: claiming SUPPORTED would fabricate a guarantee the legacy
    // configuration never made.
    reasoning: "UNKNOWN",
    reasoningSummary: toCapabilitySupport(capabilities.reasoningSummary),
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  };
}

/**
 * Build the compatibility descriptor for one legacy request.
 *
 * The descriptor exists only to satisfy the frozen adapter input contract for this
 * one provider turn. It is not model authority, it is never enumerated into a
 * catalog, and no other layer may read it to decide context limits.
 */
export function toCompatibilityDescriptor(
  ref: ModelRef,
  capabilities: LLMCapabilities,
): ModelDescriptor {
  const configuredContextWindow = capabilities.contextWindowTokens;
  const configuredMaxOutput = capabilities.maxOutputTokens;

  const contextWindowTokens = resolveContextWindow(configuredContextWindow, configuredMaxOutput);
  const maxOutputTokens = resolveMaxOutput(contextWindowTokens, configuredMaxOutput);

  return {
    ref: toAIModelRef(ref),
    api: "openai-compatible-chat",
    limits: { contextWindowTokens, maxOutputTokens },
    capabilities: toModelCapabilities(capabilities),
    // No reasoning profile and no cache profile: the legacy provider has neither, so
    // an explicit reasoning or cache request can never be silently satisfied.
    source:
      configuredContextWindow === undefined && configuredMaxOutput === undefined
        ? "FALLBACK"
        : "CONFIGURATION",
  };
}

function resolveContextWindow(
  configured: number | undefined,
  maxOutput: number | undefined,
): number {
  if (configured !== undefined) return configured;
  // Keep the invariant `maxOutputTokens <= contextWindowTokens` even when only the
  // output ceiling was configured.
  return Math.max(LEGACY_FALLBACK_CONTEXT_WINDOW_TOKENS, maxOutput ?? 0);
}

function resolveMaxOutput(contextWindowTokens: number, configured: number | undefined): number {
  if (configured !== undefined) return Math.min(configured, contextWindowTokens);
  return Math.min(LEGACY_FALLBACK_MAX_OUTPUT_TOKENS, contextWindowTokens);
}

function toCapabilitySupport(support: CapabilitySupport): AICapabilitySupport {
  return support;
}
