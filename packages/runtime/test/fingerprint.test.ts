import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRuntimeFileSystem } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalRuntimeFileSystem.fingerprint", () => {
  it("hashes raw bytes, including BOM and newline differences", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-runtime-fingerprint-"));
    temporaryDirectories.push(directory);
    const lf = path.join(directory, "lf.txt");
    const crlf = path.join(directory, "crlf.txt");
    const bom = path.join(directory, "bom.txt");
    await writeFile(lf, Buffer.from("a\nb\n"));
    await writeFile(crlf, Buffer.from("a\r\nb\r\n"));
    await writeFile(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));

    const fileSystem = new LocalRuntimeFileSystem();
    const lfFingerprint = await fileSystem.fingerprint(lf);
    const crlfFingerprint = await fileSystem.fingerprint(crlf);
    const bomFingerprint = await fileSystem.fingerprint(bom);

    expect(lfFingerprint).toMatchObject({ kind: "FILE", sizeBytes: 4 });
    expect(crlfFingerprint).toMatchObject({ kind: "FILE", sizeBytes: 6 });
    expect(bomFingerprint).toMatchObject({ kind: "FILE", sizeBytes: 4 });
    expect(lfFingerprint.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(crlfFingerprint.sha256).not.toBe(lfFingerprint.sha256);
    expect(bomFingerprint.sha256).not.toBe(lfFingerprint.sha256);
  });

  it("classifies missing paths, directories, and symlinks without reading target content", async ({
    skip,
  }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-runtime-fingerprint-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "target.txt");
    const link = path.join(directory, "link.txt");
    await writeFile(target, "target", "utf8");
    try {
      await symlink(target, link);
    } catch (error) {
      skip(
        `symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const fileSystem = new LocalRuntimeFileSystem();
    await expect(fileSystem.fingerprint(path.join(directory, "missing.txt"))).resolves.toEqual({
      kind: "MISSING",
    });
    await expect(fileSystem.fingerprint(directory)).resolves.toEqual({ kind: "DIRECTORY" });
    await expect(fileSystem.fingerprint(link)).resolves.toEqual({ kind: "SYMLINK" });
  });
});
