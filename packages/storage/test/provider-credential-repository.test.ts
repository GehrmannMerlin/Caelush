import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

const stores: Array<Awaited<ReturnType<typeof openCaelushStorage>>> = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((storage) => storage.close()));
});

describe("ProviderCredentialRepository", () => {
  it("sets, describes, resolves, replaces and unsets a local credential without exposing its secret", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);

    expect(await storage.providerCredentials.describe("openai")).toEqual({
      providerId: "openai",
      configured: false,
      source: "NONE",
      writable: true,
    });

    const first = await storage.providerCredentials.set("openai", "sk-first-secret");
    expect(first).toMatchObject({
      providerId: "openai",
      configured: true,
      source: "LOCAL",
      writable: true,
    });
    expect(first).not.toHaveProperty("secretValue");
    expect(JSON.stringify(first)).not.toContain("sk-first-secret");
    expect(await storage.providerCredentials.resolve("openai")).toBe("sk-first-secret");

    const second = await storage.providerCredentials.set("openai", "sk-second-secret");
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt ?? 0);
    expect(await storage.providerCredentials.resolve("openai")).toBe("sk-second-secret");
    expect(JSON.stringify(await storage.providerCredentials.describe("openai"))).not.toContain(
      "sk-second-secret",
    );

    await storage.providerCredentials.unset("openai");
    expect(await storage.providerCredentials.resolve("openai")).toBeUndefined();
    expect(await storage.providerCredentials.describe("openai")).toEqual({
      providerId: "openai",
      configured: false,
      source: "NONE",
      writable: true,
    });
  });

  it("rejects empty credentials without persisting them", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);

    await expect(storage.providerCredentials.set("openai", "   ")).rejects.toThrow(
      "API key must not be empty",
    );
    expect(await storage.providerCredentials.resolve("openai")).toBeUndefined();
  });
});
