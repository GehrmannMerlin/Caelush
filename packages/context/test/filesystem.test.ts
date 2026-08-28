import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalContextFileSystem } from "../src/filesystem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-context-fs-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("LocalContextFileSystem", () => {
  it("returns Caelush metadata and null for a missing path", async () => {
    const directory = await createFixture();
    const filePath = path.join(directory, "file.txt");
    await writeFile(filePath, "content", "utf8");
    const filesystem = new LocalContextFileSystem();

    await expect(filesystem.getMetadata(directory)).resolves.toEqual({ kind: "DIRECTORY" });
    await expect(filesystem.getMetadata(filePath)).resolves.toEqual({ kind: "FILE" });
    await expect(filesystem.getMetadata(path.join(directory, "missing"))).resolves.toBeNull();
  });

  it("reads a bounded UTF-8 prefix without splitting a character", async () => {
    const directory = await createFixture();
    const filePath = path.join(directory, "instructions.md");
    await writeFile(filePath, "ab你好cd", "utf8");
    const filesystem = new LocalContextFileSystem();

    await expect(filesystem.readTextFile(filePath, { maxBytes: 5 })).resolves.toEqual({
      text: "ab你",
      bytes: 5,
      truncated: true,
    });
  });

  it("returns directory entries in stable name order", async () => {
    const directory = await createFixture();
    await mkdir(path.join(directory, "nested"));
    await writeFile(path.join(directory, "z.txt"), "z", "utf8");
    await writeFile(path.join(directory, "a.txt"), "a", "utf8");
    const filesystem = new LocalContextFileSystem();

    await expect(filesystem.readDirectory(directory)).resolves.toEqual([
      { name: "a.txt", kind: "FILE" },
      { name: "nested", kind: "DIRECTORY" },
      { name: "z.txt", kind: "FILE" },
    ]);
  });

  it("exposes only read-only operations", () => {
    const filesystem = new LocalContextFileSystem();

    expect(filesystem).not.toHaveProperty("writeFile");
    expect(filesystem).not.toHaveProperty("mkdir");
    expect(filesystem).not.toHaveProperty("remove");
  });
});
