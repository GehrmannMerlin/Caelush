import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountVaultKey } from "../../src/main/credentials/device-identity.js";
import { DpapiVault, type SafeStoragePort } from "../../src/main/credentials/vault.js";
import { ProviderCredentialVault } from "../../src/main/credentials/provider-credential-vault.js";

const roots: string[] = [];
const userA = "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857";
const userB = "3657e5a0-275c-4ae6-950f-511646d3f647";
const profileA = `u_${"a".repeat(64)}`;
const profileB = `u_${"b".repeat(64)}`;

const testStorage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptStringAsync: async (value) =>
    Buffer.from(`test-enc:${Buffer.from(value).toString("base64")}`),
  decryptStringAsync: async (value) => {
    const encoded = Buffer.from(value).toString("utf8").slice("test-enc:".length);
    return Buffer.from(encoded, "base64").toString("utf8");
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeCredentialVault() {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-provider-vault-test-"));
  roots.push(root);
  const vault = new DpapiVault(path.join(root, "credentials.dpapi"), testStorage, "win32");
  await vault.initialize();
  return { vault, credentials: new ProviderCredentialVault(vault) };
}

describe("ProviderCredentialVault", () => {
  it("stores a LOCAL credential under its Cloud user, Profile, and provider identity", async () => {
    const { credentials } = await makeCredentialVault();

    await credentials.set(userA, profileA, "deepseek", "provider-key-a");

    await expect(credentials.describe(userA, profileA, "deepseek")).resolves.toMatchObject({
      providerId: "deepseek",
      configured: true,
      source: "LOCAL",
      writable: true,
    });
    await expect(credentials.resolve(userA, profileA, "deepseek")).resolves.toBe("provider-key-a");
    await expect(credentials.resolve(userB, profileA, "deepseek")).resolves.toBeUndefined();
    await expect(credentials.resolve(userA, profileB, "deepseek")).resolves.toBeUndefined();
    await expect(credentials.resolve(userA, profileA, "openai")).resolves.toBeUndefined();
  });

  it("replaces and unsets only the selected account's provider credential", async () => {
    const { credentials } = await makeCredentialVault();
    await credentials.set(userA, profileA, "deepseek", "old-key");
    await credentials.set(userB, profileA, "deepseek", "other-account-key");

    await credentials.set(userA, profileA, "deepseek", "replacement-key");
    await credentials.unset(userA, profileA, "deepseek");

    await expect(credentials.resolve(userA, profileA, "deepseek")).resolves.toBeUndefined();
    await expect(credentials.resolve(userB, profileA, "deepseek")).resolves.toBe(
      "other-account-key",
    );
  });

  it("preserves existing D3 account records in the shared encrypted Vault", async () => {
    const { vault, credentials } = await makeCredentialVault();
    const accountKey = accountVaultKey("user@example.invalid");
    const record = {
      schemaVersion: 1,
      normalizedEmail: "user@example.invalid",
      refreshToken: "d3-refresh-token-fixture",
      offlineGrant: { signature: "d3-grant-fixture" },
    };
    await vault.set(accountKey, record);

    await credentials.set(userA, profileA, "deepseek", "provider-key-a");

    await expect(vault.get(accountKey)).resolves.toEqual(record);
  });

  it("supports a realistic catalog of bounded Provider keys within the Vault size limit", async () => {
    const { credentials } = await makeCredentialVault();
    const key = "k".repeat(12_000);

    for (let index = 0; index < 80; index += 1) {
      await credentials.set(userA, profileA, `provider-${index}`, key);
    }

    await expect(credentials.resolve(userA, profileA, "provider-79")).resolves.toBe(key);
  });

  it("rejects malformed identities and API keys without exposing key material", async () => {
    const { credentials } = await makeCredentialVault();

    await expect(
      credentials.set("not-a-user-id", profileA, "deepseek", "secret-key"),
    ).rejects.toThrow();
    await expect(
      credentials.set(userA, "../../outside", "deepseek", "secret-key"),
    ).rejects.toThrow();
    await expect(credentials.set(userA, profileA, "../../outside", "secret-key")).rejects.toThrow();
    await expect(credentials.set(userA, profileA, "deepseek", " ")).rejects.toThrow();
    await expect(
      credentials.set(userA, profileA, "deepseek", "x".repeat(16_385)),
    ).rejects.toThrow();
  });
});
