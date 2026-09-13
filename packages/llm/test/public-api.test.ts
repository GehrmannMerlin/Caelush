import * as llm from "@caelush/llm";
import { describe, expect, it } from "vitest";

const api = llm as Record<string, unknown>;

/**
 * The surviving public surface of `@caelush/llm`.
 *
 * Phase 2D retired the model-invocation surface, so this list is now exactly the
 * durable conversation compatibility the package still owns. Anything from the
 * retired list reappearing here is a re-introduced invocation authority.
 */
const requiredRuntimeExports = [
  "LLMAssistantContentSchema",
  "LLMAssistantMessageSchema",
  "LLMMessageSchema",
  "LLMSystemMessageSchema",
  "LLMToolResultMessageSchema",
  "LLMUserMessageSchema",
  "LLMUsageSchema",
  "FinishReasonSchema",
  "LLMToolCallSchema",
] as const;

/** Symbols that must never come back through this package. */
const retiredInvocationExports = [
  "LLMRequestSchema",
  "LLMToolChoiceSchema",
  "CapabilitySupportSchema",
  "LLMCapabilitiesSchema",
  "LLMTurnResultSchema",
  "LLMStreamEventSchema",
  "LLMError",
  "LLMProviderNotFoundError",
  "LLMInvalidResponseError",
  "ProviderIdSchema",
  "LLMProviderRegistry",
  "LLMGateway",
  "createOpenAICompatibleLLMProvider",
  "createSafeLLMWireDiagnostic",
] as const;

describe("LLM public API", () => {
  it("exports only the durable compatibility symbols from the package root", () => {
    for (const exportName of requiredRuntimeExports) {
      expect(api[exportName], exportName).toBeDefined();
    }
  });

  it("no longer exports any model-invocation symbol", () => {
    for (const exportName of retiredInvocationExports) {
      expect(api[exportName], exportName).toBeUndefined();
    }
  });
});
