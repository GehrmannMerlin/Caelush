import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DpapiVault,
  VaultUnavailableError,
  type SafeStoragePort,
} from "../../src/main/credentials/vault.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), realpath: vi.fn(actual.realpath) };
});

const roots: string[] = [];
const key = "a".repeat(64);
const storage: SafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptStringAsync: async (value) => Buffer.from(`test-encrypted:${value}`).reverse(),
  decryptStringAsync: async (value) => {
    const clear = Buffer.from(value).reverse().toString("utf8");
    if (!clear.startsWith("test-encrypted:")) throw new Error("invalid ciphertext");
    return clear.slice("test-encrypted:".length);
  },
};

afterEach(async () => {
  vi.mocked(fs.rename).mockRestore();
  vi.mocked(fs.realpath).mockRestore();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("vault paths under redirected Windows AppData", () => {
  it("atomically replaces on the physical volume while restoring through the logical path", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "caelush-vault-paths-"));
    roots.push(root);
    const physical = path.join(await fs.realpath(root), "physical");
    const logical = path.join(root, "logical");
    await fs.mkdir(physical);
    await fs.symlink(physical, logical, "junction");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.realpath).mockImplementation(async (value, options) => {
      // A merged AppData directory can retain its logical identity while files
      // created inside it are redirected to the physical package store.
      if (String(value) === logical) return logical;
      return actual.realpath(value, options);
    });
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      // AppData virtualization can expose C: names backed by files on D:.
      // Windows rejects a move using those logical names, even within one folder.
      if (
        path.dirname(String(source)) !== physical ||
        path.dirname(String(destination)) !== physical
      ) {
        throw Object.assign(new Error("virtualized cross-volume rename"), { code: "EXDEV" });
      }
      await actual.rename(source, destination);
    });
    const file = path.join(logical, "credentials.dpapi");
    const vault = new DpapiVault(file, storage, "win32");
    await vault.initialize();
    await vault.set(key, { refreshToken: "first-secret" });
    await vault.set(key, { refreshToken: "rotated-secret" });
    expect((await fs.readFile(file)).includes(Buffer.from("rotated-secret"))).toBe(false);
    const restored = new DpapiVault(file, storage, "win32");
    await restored.initialize();
    expect(await restored.get(key)).toEqual({ refreshToken: "rotated-secret" });
    await restored.clear();
    await restored.initialize();
    expect(await restored.get(key)).toBeNull();
    expect(await fs.readdir(physical)).toEqual(["credentials.dpapi"]);
  });

  it("preserves the previous ciphertext and cleans temporary files when replacement is denied", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "caelush-vault-denied-"));
    roots.push(root);
    const file = path.join(root, "credentials.dpapi");
    const vault = new DpapiVault(file, storage, "win32");
    await vault.initialize();
    await vault.set(key, { refreshToken: "previous-secret" });
    const previous = await fs.readFile(file);
    vi.mocked(fs.rename).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(vault.set(key, { refreshToken: "new-secret" })).rejects.toThrow(
      VaultUnavailableError,
    );
    expect(await fs.readFile(file)).toEqual(previous);
    expect(await fs.readdir(root)).toEqual(["credentials.dpapi"]);
  });
});
