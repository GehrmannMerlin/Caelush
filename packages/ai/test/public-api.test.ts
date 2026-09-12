import { describe, expect, it } from "vitest";
import * as adapters from "@caelush/ai/adapters";
import * as ai from "@caelush/ai";
import * as errors from "@caelush/ai/errors";
import * as messages from "@caelush/ai/messages";
import * as models from "@caelush/ai/models";
import * as providers from "@caelush/ai/providers";
import * as request from "@caelush/ai/request";
import * as stream from "@caelush/ai/stream";

/** A module namespace as a plain record, for absence assertions. */
function surface(module: object): Record<string, unknown> {
  return module as Record<string, unknown>;
}

describe("@caelush/ai root surface", () => {
  it("exposes the composition entry point and the core contracts", () => {
    expect(typeof ai.createAISubsystem).toBe("function");
    expect(typeof ai.createAIGateway).toBe("function");
    expect(typeof ai.createLLMCallId).toBe("function");
    expect(typeof ai.sameModelIdentity).toBe("function");
    expect(typeof ai.createModelCatalogBuilder).toBe("function");
    expect(typeof ai.createProviderRegistryBuilder).toBe("function");
    expect(typeof ai.createApiAdapterRegistryBuilder).toBe("function");
    expect(typeof ai.createReasoningResolver).toBe("function");
    expect(typeof ai.createCacheResolver).toBe("function");
    expect(typeof ai.createStreamValidator).toBe("function");
    expect(typeof ai.createAIModelTurnAssembler).toBe("function");
    expect(typeof ai.createAbortScope).toBe("function");
    expect(typeof ai.createAIErrorSanitizer).toBe("function");
    expect(typeof ai.createAIError).toBe("function");
    expect(typeof ai.AIError).toBe("function");
    expect(typeof ai.validateAIModelRequest).toBe("function");
  });

  it("keeps the internal-only modules off the public root", () => {
    // Internal helpers must never become public contracts by accident.
    for (const internal of [
      "describeValue",
      "assertExactKeys",
      "assertNonEmptyString",
      "deepFreezeJson",
      "compareStrings",
      "ImmutableModelCatalog",
      "ImmutableProviderRegistry",
      "ImmutableApiAdapterRegistry",
      "createToolCallTracker",
      "snapshotDescriptor",
      "collectCatalogDescriptors",
      "describeProvider",
    ]) {
      expect(surface(ai)[internal], internal).toBeUndefined();
    }
  });
});

describe("@caelush/ai subpaths", () => {
  it("exposes the message contract only", () => {
    expect(typeof messages.assertAIMessage).toBe("function");
    expect(typeof messages.assertAIMessages).toBe("function");
    expect(typeof messages.assertAIAssistantContent).toBe("function");
    expect(surface(messages).createAISubsystem).toBeUndefined();
    expect(surface(messages).createAIGateway).toBeUndefined();
    expect(surface(messages).AIError).toBeUndefined();
    // The model-facing tool spec belongs to the tool contract, not the message one.
    expect(surface(messages).assertAIToolSpec).toBeUndefined();
  });

  it("exposes the model contract only", () => {
    expect(typeof models.createModelCatalogBuilder).toBe("function");
    expect(typeof models.assertModelDescriptor).toBe("function");
    expect(typeof models.sameModelIdentity).toBe("function");
    expect(surface(models).createAIGateway).toBeUndefined();
    expect(surface(models).createAISubsystem).toBeUndefined();
  });

  it("exposes the request contract only", () => {
    expect(typeof request.validateAIModelRequest).toBe("function");
    expect(typeof request.validateAIModelRequestShape).toBe("function");
    expect(typeof request.assertAIToolChoice).toBe("function");
    expect(surface(request).createAIGateway).toBeUndefined();
  });

  it("exposes the stream contract only", () => {
    expect(typeof stream.createStreamValidator).toBe("function");
    expect(typeof stream.createAIModelTurnAssembler).toBe("function");
    expect(typeof stream.createAbortScope).toBe("function");
    expect(surface(stream).createAIGateway).toBeUndefined();
  });

  it("exposes the error contract only", () => {
    expect(typeof errors.AIError).toBe("function");
    expect(typeof errors.createAIErrorSanitizer).toBe("function");
    expect(errors.AI_ERROR_CODES).toHaveLength(14);
    expect(surface(errors).createAIGateway).toBeUndefined();
  });

  it("exposes the provider contract only", () => {
    expect(typeof providers.createProviderRegistryBuilder).toBe("function");
    expect(typeof providers.assertProviderEndpoint).toBe("function");
    expect(surface(providers).createAIGateway).toBeUndefined();
  });

  it("exposes the adapter contract only", () => {
    expect(typeof adapters.createApiAdapterRegistryBuilder).toBe("function");
    expect(adapters.AI_ADAPTER_EVENT_TYPES).toEqual([
      "text.delta",
      "reasoning.summary.delta",
      "tool_call.start",
      "tool_call.delta",
      "tool_call.completed",
      "usage",
      "adapter.finish",
    ]);
    expect(surface(adapters).createAIGateway).toBeUndefined();
  });

  it("does not publish a reasoning or cache subpath", () => {
    // Phase 2A has no external consumer for these, so they stay reachable from the
    // root only. Widening the public surface without a consumer is exactly what the
    // migration contract forbids.
    expect(surface(ai).createReasoningResolver).toBeDefined();
    expect(surface(ai).createCacheResolver).toBeDefined();
  });
});
