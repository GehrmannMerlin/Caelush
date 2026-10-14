import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheElectronRuntime } from "../../scripts/stage-electron-runtime.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-electron-cache-test-"));
  roots.push(root);
  const source = path.join(root, "source");
  const files = {
    "electron.exe": "binary-v1",
    "icudtl.dat": "icu",
    "snapshot_blob.bin": "snapshot",
    "v8_context_snapshot.bin": "context",
    version: "44.7.0",
    "resources/default_app.asar": "default-app",
    "locales/en-US.pak": "locale",
  };
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(source, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return { source, cache: path.join(root, "cache") };
}

describe("reusable development Electron runtime", () => {
  it("rebuilds an existing but empty cached runtime", async () => {
    const { source, cache } = await fixture();
    await mkdir(path.join(cache, "current", "electron"), { recursive: true });
    const repaired = await cacheElectronRuntime(source, cache, "44.7.0");
    expect(repaired.reused).toBe(false);
    await expect(readFile(repaired.executablePath, "utf8")).resolves.toBe("binary-v1");
  });

  it("reuses one verified runtime without copying it again on the next launch", async () => {
    const { source, cache } = await fixture();
    const first = await cacheElectronRuntime(source, cache, "44.7.0");
    const before = await stat(first.executablePath);
    await first.cleanup();
    const second = await cacheElectronRuntime(source, cache, "44.7.0");

    expect(second.executablePath).toBe(first.executablePath);
    expect(second.reused).toBe(true);
    expect(second.bytesCopied).toBe(0);
    expect((await stat(second.executablePath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(cache)).toEqual(["current"]);
    await second.cleanup();
    await expect(readFile(second.executablePath, "utf8")).resolves.toBe("binary-v1");
  });

  it("repairs a damaged cache and retains a single current runtime", async () => {
    const { source, cache } = await fixture();
    const first = await cacheElectronRuntime(source, cache, "44.7.0");
    await writeFile(first.executablePath, "damaged");
    const repaired = await cacheElectronRuntime(source, cache, "44.7.0");
    expect(repaired.reused).toBe(false);
    await expect(readFile(repaired.executablePath, "utf8")).resolves.toBe("binary-v1");
    expect(await readdir(cache)).toEqual(["current"]);
  });

  it("replaces a previous version in the same fixed location", async () => {
    const { source, cache } = await fixture();
    const first = await cacheElectronRuntime(source, cache, "44.7.0");
    await writeFile(path.join(source, "version"), "44.8.0");
    await writeFile(path.join(source, "electron.exe"), "binary-v2");
    const second = await cacheElectronRuntime(source, cache, "44.8.0");
    expect(second.version).toBe("44.8.0");
    expect(second.executablePath).toBe(first.executablePath);
    await expect(readFile(second.executablePath, "utf8")).resolves.toBe("binary-v2");
    expect(await readdir(cache)).toEqual(["current"]);
  });

  it("clears only the fixed interrupted preparation directory before retrying", async () => {
    const { source, cache } = await fixture();
    await mkdir(path.join(cache, "preparing", "partial"), { recursive: true });
    await writeFile(path.join(cache, "preparing", "partial", "leftover"), "partial");
    const prepared = await cacheElectronRuntime(source, cache, "44.7.0");
    expect(prepared.reused).toBe(false);
    expect(await readdir(cache)).toEqual(["current"]);
  });

  it("rejects a cache path that overlaps the source runtime", async () => {
    const { source } = await fixture();
    await expect(cacheElectronRuntime(source, source, "44.7.0")).rejects.toThrow(/overlap/i);
    await expect(readFile(path.join(source, "electron.exe"), "utf8")).resolves.toBe("binary-v1");
  });

  it("rejects an incomplete source even when its remaining files match the cache", async () => {
    const { source, cache } = await fixture();
    const first = await cacheElectronRuntime(source, cache, "44.7.0");
    await rm(path.join(source, "icudtl.dat"));
    await rm(path.join(first.directory, "icudtl.dat"));
    await expect(cacheElectronRuntime(source, cache, "44.7.0")).rejects.toThrow(
      /required Windows resource/i,
    );
  });
});
