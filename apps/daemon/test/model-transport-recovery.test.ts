import {
  createProviderRegistryBuilder,
  type AIProviderBinding,
  type ProviderRegistry,
} from "@caelush/ai";
import { createModelTransportRecoveryPort } from "../src/providers/model-transport-recovery.js";
import { describe, expect, it } from "vitest";

function providers(): ProviderRegistry {
  const binding: AIProviderBinding = {
    id: "fixture",
    endpoint: "https://primary.example/v1",
    defaultApi: "openai-compatible-chat",
    allowUnknownModels: true,
    credentials: { resolve: async () => ({ apiKey: "test-only" }) },
    rateLimitDomain: "primary-pool",
    transportCandidates: [
      {
        id: "anthropic-backup",
        endpoint: "https://backup-anthropic.example/v1",
        api: "anthropic-messages",
      },
      {
        id: "backup",
        endpoint: "https://backup.example/v1",
        api: "openai-compatible-chat",
        rateLimitDomain: "backup-pool",
      },
      {
        id: "third",
        endpoint: "https://third.example/v1",
        api: "openai-compatible-chat",
      },
    ],
  };
  return createProviderRegistryBuilder().register(binding).build();
}

describe("model transport recovery host adapter", () => {
  it("selects only configured candidates and preserves provider/model identity", () => {
    const recovery = createModelTransportRecoveryPort(providers(), () => "openai-compatible-chat");
    const current = recovery.initial({ providerId: "fixture", modelId: "fixture-model" });
    const next = recovery.next({
      current,
      attemptedTransportIds: ["default"],
      errorCode: "LLM_NETWORK",
    });

    expect(current).toEqual({
      providerId: "fixture",
      modelId: "fixture-model",
      transportId: "default",
    });
    expect(next).toEqual({
      providerId: "fixture",
      modelId: "fixture-model",
      transportId: "backup",
    });
    expect(JSON.stringify(next)).not.toMatch(/endpoint|credential|header|https?:/iu);
  });

  it("changes transport for rate limits only across explicitly different domains", () => {
    const recovery = createModelTransportRecoveryPort(providers(), () => "openai-compatible-chat");
    const current = recovery.initial({ providerId: "fixture", modelId: "fixture-model" });

    expect(
      recovery.next({ current, attemptedTransportIds: ["default"], errorCode: "LLM_RATE_LIMIT" }),
    ).toMatchObject({ transportId: "backup" });
    expect(
      recovery.next({
        current: { ...current, transportId: "third" },
        attemptedTransportIds: ["default", "backup", "third"],
        errorCode: "LLM_RATE_LIMIT",
      }),
    ).toBeUndefined();
  });

  it("does not select a transport already used by the Run", () => {
    const recovery = createModelTransportRecoveryPort(providers(), () => "openai-compatible-chat");
    const current = recovery.initial({ providerId: "fixture", modelId: "fixture-model" });

    expect(
      recovery.next({
        current: { ...current, transportId: "backup" },
        attemptedTransportIds: ["default", "backup", "third"],
        errorCode: "LLM_TIMEOUT",
      }),
    ).toBeUndefined();
  });

  it("selects only a candidate using the current model descriptor's API dialect", () => {
    const recovery = createModelTransportRecoveryPort(providers(), () => "anthropic-messages");
    const current = recovery.initial({ providerId: "fixture", modelId: "fixture-model" });

    expect(
      recovery.next({
        current,
        attemptedTransportIds: ["default"],
        errorCode: "LLM_NETWORK",
      }),
    ).toEqual({ ...current, transportId: "anthropic-backup" });
  });
});
