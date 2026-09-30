import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelCatalogBuilder, type ModelDescriptor } from "@caelush/ai";
import { openCaelushStorage } from "@caelush/storage";
import { createRuntimeProviderCredentialAuthority } from "../src/providers/credential-authority.js";
import { ProviderPresetRegistry, type ProviderPreset } from "../src/providers/provider-presets.js";
import { RuntimeModelDirectoryService } from "../src/providers/model-directory.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((storage) => storage.close()));
});

describe("RuntimeModelDirectoryService", () => {
  it("enriches discovered known models and uses a conservative fallback for unknown models", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    await storage.providerCredentials.set("deepseek", "local-key");
    const preset: ProviderPreset = {
      id: "deepseek",
      displayName: "DeepSeek",
      endpoint: "https://deepseek.example/v1",
      api: "openai-compatible-chat",
      credentialReference: "CAELUSH_PROVIDER_API_KEY",
      discovery: {
        dialect: "OPENAI_MODELS",
        path: "models",
        credentialTransport: "BEARER",
      },
    };
    const known: ModelDescriptor = {
      ref: { provider: "deepseek", model: "known-model" },
      api: "openai-compatible-chat",
      displayName: "Known Model",
      limits: { contextWindowTokens: 64_000, maxOutputTokens: 8_192 },
      capabilities: {
        streaming: "SUPPORTED",
        toolCalling: "SUPPORTED",
        parallelToolCalls: "UNKNOWN",
        structuredOutput: "UNKNOWN",
        vision: "UNKNOWN",
        reasoning: "SUPPORTED",
        reasoningSummary: "UNKNOWN",
        promptCaching: "UNKNOWN",
        usageReporting: "UNKNOWN",
      },
      reasoning: {
        supportedLevels: ["OFF", "LOW", "HIGH"],
        defaultLevel: "HIGH",
        supportsSummary: "UNKNOWN",
      },
      source: "BUILTIN",
    };
    const catalog = createModelCatalogBuilder()
      .registerSource({
        id: "known-models",
        priority: 0,
        resolve: (ref) =>
          ref.provider === known.ref.provider && ref.model === known.ref.model ? known : undefined,
        list: () => [known],
      })
      .registerSource({
        id: "fallback-models",
        priority: 100,
        resolve: (ref) =>
          ref.provider === "deepseek"
            ? {
                ref,
                api: "openai-compatible-chat",
                limits: { contextWindowTokens: 16_000, maxOutputTokens: 4_096 },
                capabilities: {
                  streaming: "SUPPORTED",
                  toolCalling: "UNKNOWN",
                  parallelToolCalls: "UNKNOWN",
                  structuredOutput: "UNKNOWN",
                  vision: "UNKNOWN",
                  reasoning: "UNKNOWN",
                  reasoningSummary: "UNKNOWN",
                  promptCaching: "UNKNOWN",
                  usageReporting: "UNKNOWN",
                },
                source: "FALLBACK",
              }
            : undefined,
      })
      .build();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "known-model" }, { id: "unknown-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const authority = createRuntimeProviderCredentialAuthority({
      repository: storage.providerCredentials,
      environment: {},
    });
    const directory = new RuntimeModelDirectoryService({
      presets: new ProviderPresetRegistry([{ ...preset, fetch }]),
      credentials: authority,
      models: catalog,
    });

    const result = await directory.getDirectory("deepseek");
    expect(result.models.map((model) => model.id)).toEqual(["known-model", "unknown-model"]);
    expect(result.models[0]).toMatchObject({
      displayName: "Known Model",
      availability: "AVAILABLE",
      reasoning: {
        defaultLevel: "HIGH",
        options: [
          { level: "OFF", displayName: "Off" },
          { level: "LOW", displayName: "Low" },
          { level: "HIGH", displayName: "High" },
        ],
      },
    });
    expect(result.models[1]).toEqual({
      provider: "deepseek",
      id: "unknown-model",
      displayName: "unknown-model",
      availability: "AVAILABLE",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
