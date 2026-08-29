import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeBinaryFileError,
  RuntimeInvalidUtf8Error,
  readBoundedUtf8Text,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-runtime-reader-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("readBoundedUtf8Text", () => {
  it("returns paginated numbered lines without losing a final unterminated line", async () => {
    const directory = await fixture();
    const file = path.join(directory, "source.txt");
    await writeFile(file, "one\r\n你好\nemoji 😀", "utf8");

    await expect(
      readBoundedUtf8Text(file, { offset: 2, limit: 2, maxBytes: 50 * 1024 }),
    ).resolves.toMatchObject({
      lines: ["2: 你好", "3: emoji 😀"],
      lineStart: 2,
      truncated: false,
      utf8Bom: false,
    });
  });

  it("removes a UTF-8 BOM and reports empty files successfully", async () => {
    const directory = await fixture();
    const bomFile = path.join(directory, "bom.txt");
    const emptyFile = path.join(directory, "empty.txt");
    await writeFile(bomFile, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    await writeFile(emptyFile, "", "utf8");

    await expect(
      readBoundedUtf8Text(bomFile, { offset: 1, limit: 1, maxBytes: 1024 }),
    ).resolves.toMatchObject({
      lines: ["1: a"],
      utf8Bom: true,
    });
    await expect(
      readBoundedUtf8Text(emptyFile, { offset: 1, limit: 1, maxBytes: 1024 }),
    ).resolves.toMatchObject({
      lines: [],
      truncated: false,
    });
  });

  it("rejects binary and invalid UTF-8 content instead of replacing bytes", async () => {
    const directory = await fixture();
    const binary = path.join(directory, "binary.dat");
    const invalid = path.join(directory, "invalid.txt");
    await writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(invalid, Buffer.from([0x61, 0xff, 0x62]));

    await expect(
      readBoundedUtf8Text(binary, { offset: 1, limit: 1, maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(RuntimeBinaryFileError);
    await expect(
      readBoundedUtf8Text(invalid, { offset: 1, limit: 1, maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(RuntimeInvalidUtf8Error);
  });

  it("stops at the model byte budget and supplies a continuation offset", async () => {
    const directory = await fixture();
    const file = path.join(directory, "large.txt");
    await writeFile(file, `${"x".repeat(100)}\n${"y".repeat(100)}\n`, "utf8");

    await expect(
      readBoundedUtf8Text(file, { offset: 1, limit: 2000, maxBytes: 120 }),
    ).resolves.toMatchObject({
      truncated: true,
      nextOffset: 2,
    });
  });
});
