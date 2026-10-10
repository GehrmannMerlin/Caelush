import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageElectronRuntime } from "../../scripts/stage-electron-runtime.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Electron runtime staging", () => {
  it("copies the complete runtime outside the package tree and verifies the staged files", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "caelush-electron-runtime-test-"));
    temporaryRoots.push(testRoot);
    const sourceDist = join(testRoot, "source", "dist");
    const testFiles = new Map([
      ["electron.exe", "test-binary"],
      ["icudtl.dat", "test-icu"],
      ["snapshot_blob.bin", "test-snapshot"],
      ["v8_context_snapshot.bin", "test-context"],
      ["version", "44.7.0"],
      ["resources/default_app.asar", "test-default-app"],
      ["locales/en-US.pak", "test-locale"],
    ]);

    for (const [relativePath, contents] of testFiles) {
      const sourcePath = join(sourceDist, relativePath);
      await mkdir(join(sourcePath, ".."), { recursive: true });
      await writeFile(sourcePath, contents);
    }

    const staged = await stageElectronRuntime(sourceDist, testRoot, "44.7.0");
    try {
      expect(staged.directory.startsWith(sourceDist)).toBe(false);
      expect(staged.executablePath).toBe(join(staged.directory, "electron.exe"));
      for (const [relativePath, contents] of testFiles) {
        await expect(readFile(join(staged.directory, relativePath), "utf8")).resolves.toBe(
          contents,
        );
      }
    } finally {
      await staged.cleanup();
    }
  });
});
