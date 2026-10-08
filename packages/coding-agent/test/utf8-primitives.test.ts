import { describe, expect, it } from "vitest";
import { splitUtf8ByBytes } from "../src/tools/utf8.js";

describe("Coding Agent UTF-8 splitter", () => {
  it("preserves the empty split behavior", () => {
    expect(splitUtf8ByBytes("", 8 * 1024)).toEqual([""]);
  });

  it("scans each code point once while splitting a 1 MiB source", () => {
    const value = "x".repeat(1024 * 1024);
    let processedCodePoints = 0;
    const chunks = splitUtf8ByBytes(value, 8 * 1024, () => {
      processedCodePoints += 1;
    });

    expect(processedCodePoints).toBe(value.length);
    expect(chunks).toHaveLength(128);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 8 * 1024)).toBe(true);
    expect(chunks.join("")).toBe(value);
  });
});
