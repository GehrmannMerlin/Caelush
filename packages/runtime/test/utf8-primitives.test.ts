import { describe, expect, it } from "vitest";
import {
  splitUtf8ByBytes,
  utf8ByteLength,
  utf8PrefixByBytes,
  utf8SuffixByBytes,
} from "../src/exec/utf8.js";

describe("Runtime UTF-8 primitives", () => {
  it("preserves the empty split behavior", () => {
    expect(splitUtf8ByBytes("", 8 * 1024)).toEqual([""]);
  });

  it("keeps prefixes, suffixes and splits on Unicode code-point boundaries", () => {
    const value = "a中😀z";

    expect(utf8ByteLength(value)).toBe(9);
    expect(utf8PrefixByBytes(value, 8)).toBe("a中😀");
    expect(utf8SuffixByBytes(value, 8)).toBe("中😀z");
    expect(splitUtf8ByBytes(value, 8)).toEqual(["a中😀", "z"]);
  });

  it("scans a large split source once and preserves exact UTF-8 boundaries", () => {
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
