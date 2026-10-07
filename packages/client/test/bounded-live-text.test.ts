import { describe, expect, it } from "vitest";
import {
  appendBoundedLiveText,
  createEmptyBoundedLiveText,
  utf8ByteLength,
  utf8PrefixByBytes,
  type BoundedLiveTextOperations,
} from "../src/bounded-live-text.js";

const maxTextBytes = 16 * 1024;

describe("bounded live UTF-8 text", () => {
  it("keeps multiple ASCII appends below the byte limit", () => {
    let state = createEmptyBoundedLiveText();
    state = appendBoundedLiveText(state, "a".repeat(4_000), maxTextBytes);
    state = appendBoundedLiveText(state, "b".repeat(5_000), maxTextBytes);
    state = appendBoundedLiveText(state, "c".repeat(3_000), maxTextBytes);

    expect(state.text).toBe("a".repeat(4_000) + "b".repeat(5_000) + "c".repeat(3_000));
    expect(state.retainedBytes).toBe(12_000);
    expect(state.truncated).toBe(false);
    expect(state.omittedBytes).toBe(0);
  });

  it("preserves the final character at the exact byte boundary", () => {
    let state = appendBoundedLiveText(
      createEmptyBoundedLiveText(),
      "a".repeat(maxTextBytes - 4),
      maxTextBytes,
    );
    state = appendBoundedLiveText(state, "last", maxTextBytes);

    expect(state.text).toBe("a".repeat(maxTextBytes - 4) + "last");
    expect(state.retainedBytes).toBe(maxTextBytes);
    expect(state.truncated).toBe(false);
    expect(state.omittedBytes).toBe(0);
  });

  it("retains only the safe prefix when an ASCII chunk crosses the limit", () => {
    let state = appendBoundedLiveText(
      createEmptyBoundedLiveText(),
      "a".repeat(maxTextBytes - 10),
      maxTextBytes,
    );
    state = appendBoundedLiveText(state, "b".repeat(100), maxTextBytes);

    expect(state.text).toBe("a".repeat(maxTextBytes - 10) + "b".repeat(10));
    expect(state.retainedBytes).toBe(maxTextBytes);
    expect(state.truncated).toBe(true);
    expect(state.omittedBytes).toBe(90);
  });

  it("never cuts a Chinese code point at the UTF-8 boundary", () => {
    let state = appendBoundedLiveText(
      createEmptyBoundedLiveText(),
      "a".repeat(maxTextBytes - 2),
      maxTextBytes,
    );
    state = appendBoundedLiveText(state, "中z", maxTextBytes);

    expect(state.text).toBe("a".repeat(maxTextBytes - 2));
    expect(state.retainedBytes).toBe(maxTextBytes - 2);
    expect(state.truncated).toBe(true);
    expect(state.omittedBytes).toBe(4);
    expect(utf8ByteLength(state.text)).toBeLessThanOrEqual(maxTextBytes);
  });

  it("never retains half of an emoji surrogate pair", () => {
    let state = appendBoundedLiveText(
      createEmptyBoundedLiveText(),
      "a".repeat(maxTextBytes - 3),
      maxTextBytes,
    );
    state = appendBoundedLiveText(state, "😀", maxTextBytes);

    expect(state.text).toBe("a".repeat(maxTextBytes - 3));
    expect(state.retainedBytes).toBe(maxTextBytes - 3);
    expect(state.truncated).toBe(true);
    expect(state.omittedBytes).toBe(4);
    expect(state.text).not.toContain("\uD83D");
    expect(state.text).not.toContain("\uDE00");
  });

  it("keeps a mixed ASCII, Chinese, and emoji prefix within the byte limit", () => {
    const state = appendBoundedLiveText(createEmptyBoundedLiveText(), "a中😀z", 8);

    expect(state.text).toBe("a中😀");
    expect(utf8ByteLength(state.text)).toBe(8);
    expect(state.retainedBytes).toBe(8);
    expect(state.truncated).toBe(true);
    expect(state.omittedBytes).toBe(1);
    expect(utf8ByteLength("a中😀z")).toBe(new TextEncoder().encode("a中😀z").byteLength);
    expect(utf8PrefixByBytes("a中😀z", 8)).toBe("a中😀");
  });

  it("does work proportional to 1,000 new chunks after a 16 KiB buffer is truncated", () => {
    let scannedCodeUnits = 0;
    let prefixCodeUnits = 0;
    const operations: BoundedLiveTextOperations = {
      utf8ByteLength(value) {
        scannedCodeUnits += value.length;
        return utf8ByteLength(value);
      },
      utf8PrefixByBytes(value, byteLimit) {
        prefixCodeUnits += value.length;
        return utf8PrefixByBytes(value, byteLimit);
      },
    };

    let state = appendBoundedLiveText(
      createEmptyBoundedLiveText(),
      "x".repeat(maxTextBytes),
      maxTextBytes,
      operations,
    );
    state = appendBoundedLiveText(state, "y", maxTextBytes, operations);
    expect(state.truncated).toBe(true);
    const retainedText = state.text;

    scannedCodeUnits = 0;
    prefixCodeUnits = 0;
    const deltas = 1_000;
    const delta = "ab";
    for (let index = 0; index < deltas; index += 1) {
      state = appendBoundedLiveText(state, delta, maxTextBytes, operations);
      expect(state.text).toBe(retainedText);
    }

    expect(state.retainedBytes).toBe(maxTextBytes);
    expect(state.omittedBytes).toBe(1 + deltas * delta.length);
    expect(scannedCodeUnits).toBe(deltas * delta.length);
    expect(prefixCodeUnits).toBe(0);
  });
});
