import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  accountVaultKey,
  getOrCreateDeviceIdentity,
} from "../../src/main/credentials/device-identity.js";
import { DpapiVault, type SafeStoragePort } from "../../src/main/credentials/vault.js";

const roots: string[] = [];
const storage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`),
  decryptStringAsync: async (value) =>
    Buffer.from(value).toString("utf8").slice("encrypted:".length),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local device identity", () => {
  it("reuses the same account keypair while keeping account identities isolated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-device-test-"));
    roots.push(root);
    const vault = new DpapiVault(path.join(root, "vault.bin"), storage);
    await vault.initialize();
    const first = await getOrCreateDeviceIdentity(vault, "Person@example.test");
    const repeated = await getOrCreateDeviceIdentity(vault, "person@example.test");
    const anotherAccount = await getOrCreateDeviceIdentity(vault, "other@example.test");

    expect(first.accountKey).toBe(accountVaultKey("person@example.test"));
    expect(first.accountKey).not.toContain("person");
    expect(repeated.identity.publicKeyBase64Url).toBe(first.identity.publicKeyBase64Url);
    expect(anotherAccount.identity.publicKeyBase64Url).not.toBe(first.identity.publicKeyBase64Url);
  });
});
