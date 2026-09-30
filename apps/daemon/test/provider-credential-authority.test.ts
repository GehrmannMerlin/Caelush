import { afterEach, describe, expect, it } from "vitest";
import { isAIError } from "@caelush/ai";
import { openCaelushStorage } from "@caelush/storage";
import {
  createRuntimeProviderCredentialAuthority,
  createRuntimeProviderCredentialResolver,
  EnvironmentCredentialReadOnlyError,
} from "../src/providers/credential-authority.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((storage) => storage.close()));
});

describe("RuntimeProviderCredentialAuthority", () => {
  it("uses environment credentials first and observes local replacement on the next resolve", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    await storage.providerCredentials.set("openai", "local-key");

    const authority = createRuntimeProviderCredentialAuthority({
      repository: storage.providerCredentials,
      environment: {
        CAELUSH_PROVIDER_ID: "openai",
        CAELUSH_PROVIDER_API_KEY: "environment-key",
      },
    });

    expect(await authority.describe("openai")).toMatchObject({
      configured: true,
      source: "ENVIRONMENT",
      writable: false,
    });
    expect((await authority.resolve("openai", new AbortController().signal)).apiKey).toBe(
      "environment-key",
    );

    const localOnly = createRuntimeProviderCredentialAuthority({
      repository: storage.providerCredentials,
      environment: {},
    });
    const resolver = createRuntimeProviderCredentialResolver(localOnly, "openai");
    expect((await resolver.resolve(new AbortController().signal)).apiKey).toBe("local-key");
    await storage.providerCredentials.set("openai", "replacement-key");
    expect((await resolver.resolve(new AbortController().signal)).apiKey).toBe("replacement-key");
  });

  it("fails closed for a missing key and refuses environment-owned deletion", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const authority = createRuntimeProviderCredentialAuthority({
      repository: storage.providerCredentials,
      environment: {
        CAELUSH_PROVIDER_ID: "anthropic",
        CAELUSH_PROVIDER_API_KEY: "environment-key",
      },
    });

    await expect(authority.resolve("deepseek", new AbortController().signal)).rejects.toMatchObject(
      {
        code: "AI_AUTHENTICATION",
      },
    );
    await expect(authority.unset("anthropic")).rejects.toBeInstanceOf(
      EnvironmentCredentialReadOnlyError,
    );
    expect(isAIError(await authority.resolve("anthropic", new AbortController().signal))).toBe(
      false,
    );
  });
});
