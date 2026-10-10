import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  DpapiVault,
  VaultUnavailableError,
  type SafeStoragePort,
} from "../../src/main/credentials/vault.js";

const roots: string[] = [];
const accountA = "a".repeat(64);
const accountB = "b".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-vault-test-"));
  roots.push(root);
  return root;
}

const testStorage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "basic_text",
  encryptStringAsync: async (value) =>
    Buffer.concat([Buffer.from("test-enc:"), Buffer.from(value).reverse()]),
  decryptStringAsync: async (value) => {
    const data = Buffer.from(value);
    if (!data.subarray(0, 9).equals(Buffer.from("test-enc:"))) throw new Error("bad ciphertext");
    return data.subarray(9).reverse().toString("utf8");
  },
};

describe("Windows DPAPI file vault adapter", () => {
  it("encrypts credential records and restores them after constructing a new adapter", async () => {
    const file = path.join(await makeRoot(), "vault.bin");
    const vault = new DpapiVault(file, testStorage);
    await vault.initialize();
    await vault.set(accountA, { refreshToken: "refresh-secret-value", deviceId: "device-a" });

    const bytes = await readFile(file);
    expect(bytes.includes(Buffer.from("refresh-secret-value"))).toBe(false);
    const restored = new DpapiVault(file, testStorage);
    await restored.initialize();
    expect(await restored.get(accountA)).toEqual({
      refreshToken: "refresh-secret-value",
      deviceId: "device-a",
    });
    expect(await restored.get(accountB)).toBeNull();
  });

  it("verifies Windows encryption by round trip without querying the Linux backend API", async () => {
    const file = path.join(await makeRoot(), "vault.bin");
    const backendQuery = vi.fn(() => {
      throw new Error("The selected backend API is Linux-only.");
    });
    const vault = new DpapiVault(
      file,
      {
        ...testStorage,
        getSelectedStorageBackend: backendQuery,
      },
      "win32",
    );

    await vault.initialize();
    await vault.set(accountA, { refreshToken: "short-lived-test-refresh-token" });

    expect(backendQuery).not.toHaveBeenCalled();
    expect(await vault.get(accountA)).toEqual({ refreshToken: "short-lived-test-refresh-token" });
  });

  it("fails closed if the Windows encryption round trip is unavailable", async () => {
    const file = path.join(await makeRoot(), "vault.bin");
    const storage: SafeStoragePort = {
      ...testStorage,
      decryptStringAsync: async () => "not-the-encrypted-challenge",
    };

    await expect(new DpapiVault(file, storage, "win32").initialize()).rejects.toThrow(
      VaultUnavailableError,
    );
  });

  it("deletes one account without changing another and detects damaged ciphertext", async () => {
    const file = path.join(await makeRoot(), "vault.bin");
    const vault = new DpapiVault(file, testStorage);
    await vault.initialize();
    await vault.set(accountA, { value: "a" });
    await vault.set(accountB, { value: "b" });
    await vault.delete(accountA);
    expect(await vault.get(accountA)).toBeNull();
    expect(await vault.get(accountB)).toEqual({ value: "b" });

    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, "corrupt"));
    await expect(new DpapiVault(file, testStorage).initialize()).rejects.toThrow(
      VaultUnavailableError,
    );
  });

  it("fails closed when Windows DPAPI storage is unavailable", async () => {
    const unavailable: SafeStoragePort = {
      ...testStorage,
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => "basic_text",
    };
    await expect(
      new DpapiVault(path.join(await makeRoot(), "vault.bin"), unavailable).initialize(),
    ).rejects.toThrow(VaultUnavailableError);
  });
});
