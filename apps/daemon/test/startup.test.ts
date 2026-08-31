import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultDatabasePath } from "../src/main.js";
import { assertLoopbackDaemonHost, readProviderConfiguration } from "../src/config.js";

describe("daemon command startup", () => {
  it("derives the default database path cross-platform", () => {
    expect(getDefaultDatabasePath()).toBe(join(homedir(), ".caelush", "caelush.db"));
  });

  it("can be imported without opening a listener", async () => {
    const module = await import("../src/main.js");
    expect(module.main).toBeTypeOf("function");
  });

  it("translates provider environment values into runtime-only startup configuration", () => {
    expect(
      readProviderConfiguration({
        CAELUSH_PROVIDER_ID: "openai-compatible",
        CAELUSH_PROVIDER_BASE_URL: "https://provider.example/v1",
        CAELUSH_PROVIDER_API_KEY: "secret",
        CAELUSH_PROVIDER_ALLOWED_MODELS: "model-a, model-b",
        CAELUSH_DEFAULT_PROVIDER: "openai-compatible",
        CAELUSH_DEFAULT_MODEL: "model-a",
      }),
    ).toEqual({
      providers: [
        {
          provider: "openai-compatible",
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          allowedModels: ["model-a", "model-b"],
        },
      ],
      defaultModel: { provider: "openai-compatible", model: "model-a" },
    });
  });

  it("rejects non-loopback production binding and partial provider configuration", () => {
    expect(() => assertLoopbackDaemonHost("0.0.0.0")).toThrow("loopback host");
    expect(() => assertLoopbackDaemonHost("[::1]")).not.toThrow();
    expect(() => readProviderConfiguration({ CAELUSH_PROVIDER_ID: "configured" })).toThrow(
      "required together",
    );
    expect(() => readProviderConfiguration({ CAELUSH_DEFAULT_PROVIDER: "configured" })).toThrow(
      "required together",
    );
  });
});
