import { describe, expect, it } from "vitest";
import {
  splitUtf8ByBytes,
  utf8ByteLength,
  utf8PrefixByBytes,
  utf8SuffixByBytes,
} from "../src/utils/utf8.js";

describe("Agent UTF-8 primitives", () => {
  it("preserves the empty split behavior", () => {
    expect(splitUtf8ByBytes("", 8 * 1024)).toEqual([""]);
  });

  it("counts, prefixes, suffixes and splits mixed Unicode by byte boundaries", () => {
    const value = "a中😀z";

    expect(utf8ByteLength(value)).toBe(9);
    expect(utf8PrefixByBytes(value, 8)).toBe("a中😀");
    expect(utf8SuffixByBytes(value, 8)).toBe("中😀z");
    expect(splitUtf8ByBytes(value, 8)).toEqual(["a中😀", "z"]);
  });

  it("keeps an emoji intact when it crosses an exact 8 KiB boundary", () => {
    const value = `${"x".repeat(8 * 1024 - 1)}😀中中z`;
    const chunks = splitUtf8ByBytes(value, 8 * 1024);

    expect(chunks).toEqual(["x".repeat(8 * 1024 - 1), "😀中中z"]);
    expect(chunks.every((chunk) => utf8ByteLength(chunk) <= 8 * 1024)).toBe(true);
    expect(chunks.every((chunk) => chunk.isWellFormed())).toBe(true);
    expect(chunks.join("")).toBe(value);
  });

  it("processes each code point once while splitting a 1 MiB source", () => {
    const value = "x".repeat(1024 * 1024);
    let processedCodePoints = 0;
    const chunks = splitUtf8ByBytes(value, 8 * 1024, () => {
      processedCodePoints += 1;
    });

    expect(processedCodePoints).toBe(value.length);
    expect(chunks).toHaveLength(128);
    expect(chunks.every((chunk) => utf8ByteLength(chunk) <= 8 * 1024)).toBe(true);
    expect(chunks.join("")).toBe(value);
  });
});
