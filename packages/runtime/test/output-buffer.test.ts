import { describe, expect, it, vi } from "vitest";
import { HeadTailOutputBuffer } from "../src/index.js";

function withUtf8ScanGuard(maxScannedUnits: number, action: () => void): number {
  const originalByteLength = Buffer.byteLength.bind(Buffer);
  const originalCharCodeAt = String.prototype.charCodeAt;
  let scannedUnits = 0;
  const byteLengthImplementation = function (
    value: string | ArrayBuffer | ArrayBufferView,
    encoding?: BufferEncoding,
  ): number {
    scannedUnits += typeof value === "string" ? value.length : value.byteLength;
    if (scannedUnits > maxScannedUnits) {
      throw new Error("UTF-8 byte accounting rescanned retained output");
    }
    return originalByteLength(value, encoding);
  };
  const byteLengthSpy = vi
    .spyOn(Buffer, "byteLength")
    .mockImplementation(byteLengthImplementation as typeof Buffer.byteLength);
  const charCodeSpy = vi.spyOn(String.prototype, "charCodeAt").mockImplementation(function (
    this: string,
    index: number,
  ) {
    scannedUnits += 1;
    if (scannedUnits > maxScannedUnits) {
      throw new Error("UTF-8 helper rescanned retained output");
    }
    return originalCharCodeAt.call(this, index);
  });
  try {
    action();
    return scannedUnits;
  } finally {
    byteLengthSpy.mockRestore();
    charCodeSpy.mockRestore();
  }
}

describe("HeadTailOutputBuffer", () => {
  it("preserves all output below its byte bound and drains unread output", () => {
    const buffer = new HeadTailOutputBuffer(32, 16);
    buffer.append("hello 世界");
    expect(buffer.snapshot()).toMatchObject({ text: "hello 世界", omittedBytes: 0 });
    expect(buffer.drain().text).toBe("hello 世界");
    expect(buffer.drain().text).toBe("");
  });

  it("does not cut an under-limit value at the head partition", () => {
    const buffer = new HeadTailOutputBuffer(32, 8);
    buffer.append("0123456789");
    expect(buffer.snapshot().text).toBe("0123456789");
  });

  it("accounts for a surrogate pair split across appends before truncation", () => {
    const buffer = new HeadTailOutputBuffer(4, 2);
    buffer.append("\ud83d");
    buffer.append("\ude00");

    expect(buffer.snapshot()).toEqual({ text: "😀", totalBytes: 4, omittedBytes: 0 });
  });

  it("keeps a split surrogate pair intact at the tail after truncation", () => {
    const buffer = new HeadTailOutputBuffer(8, 4);
    buffer.append("abcdef");
    buffer.append("\ud83d");
    buffer.append("\ude00");

    const snapshot = buffer.snapshot();
    expect(snapshot.text.startsWith("abcd")).toBe(true);
    expect(snapshot.text.endsWith("😀")).toBe(true);
    expect(snapshot.text.isWellFormed()).toBe(true);
    expect(snapshot).toMatchObject({ totalBytes: 10, omittedBytes: 2 });
  });

  it("preserves head and tail with explicit omitted bytes", () => {
    const buffer = new HeadTailOutputBuffer(16, 5);
    buffer.append("0123456789abcdefghijklmnop");
    const snapshot = buffer.snapshot();
    expect(snapshot.text.startsWith("01234")).toBe(true);
    expect(snapshot.text.endsWith("lmnop")).toBe(true);
    expect(snapshot.text).toContain("bytes omitted");
    expect(snapshot.omittedBytes).toBeGreaterThan(0);
    expect(snapshot.totalBytes).toBe(26);
  });

  it("keeps 1 MiB after exactly 1,024 1 KiB appends without rescanning retained text", () => {
    const buffer = new HeadTailOutputBuffer(1024 * 1024, 512 * 1024);
    const chunk = "x".repeat(1024);
    const scanned = withUtf8ScanGuard(4 * 1024 * 1024, () => {
      for (let index = 0; index < 1024; index += 1) buffer.append(chunk);
    });

    const snapshot = buffer.snapshot();
    expect(scanned).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(snapshot).toEqual({
      text: chunk.repeat(1024),
      totalBytes: 1024 * 1024,
      omittedBytes: 0,
    });
  });

  it("keeps a fixed head and newest tail while omitted bytes grow monotonically", () => {
    const buffer = new HeadTailOutputBuffer(64, 32);
    const initial = "h".repeat(64);
    buffer.append(initial);
    let previousOmitted = 0;

    for (let index = 0; index < 2_000; index += 1) {
      buffer.append(String(index).repeat(16));
      const snapshot = buffer.snapshot();
      expect(snapshot.text.startsWith("h".repeat(32))).toBe(true);
      expect(snapshot.omittedBytes).toBeGreaterThanOrEqual(previousOmitted);
      expect(snapshot.omittedBytes).toBe(snapshot.totalBytes - 64);
      previousOmitted = snapshot.omittedBytes;
    }

    expect(buffer.snapshot().text.endsWith("1999".repeat(8))).toBe(true);
  });

  it("does not split Chinese or emoji code points across the head and tail", () => {
    const buffer = new HeadTailOutputBuffer(12, 6);
    const source = "甲🙂乙🙂丙🙂";
    buffer.append(source);
    const snapshot = buffer.snapshot();

    expect(snapshot.text.startsWith("甲")).toBe(true);
    expect(snapshot.text.endsWith("🙂")).toBe(true);
    expect(snapshot.text.isWellFormed()).toBe(true);
    expect(snapshot.totalBytes).toBe(Buffer.byteLength(source, "utf8"));
    expect(snapshot.omittedBytes).toBe(snapshot.totalBytes - Buffer.byteLength("甲🙂", "utf8"));
  });

  it("does not rescan a retained 512 KiB tail across 10,000 tiny appends", () => {
    const buffer = new HeadTailOutputBuffer(1024 * 1024, 512 * 1024);
    const kib = "x".repeat(1024);
    for (let index = 0; index < 1024; index += 1) buffer.append(kib);
    buffer.append("z");

    const chunk = "q".repeat(64);
    const inputUnits = chunk.length * 10_000;
    const scanned = withUtf8ScanGuard(inputUnits * 8, () => {
      for (let index = 0; index < 10_000; index += 1) buffer.append(chunk);
    });

    const snapshot = buffer.snapshot();
    expect(scanned).toBeLessThanOrEqual(inputUnits * 8);
    expect(snapshot.text.startsWith("x".repeat(512 * 1024))).toBe(true);
    expect(snapshot.text.endsWith(chunk.repeat((512 * 1024) / chunk.length))).toBe(true);
    expect(snapshot.totalBytes).toBe(1024 * 1024 + 1 + inputUnits);
    expect(snapshot.omittedBytes).toBe(snapshot.totalBytes - 1024 * 1024);
  });

  it("keeps snapshots read-only and clears all accounting after drain", () => {
    const buffer = new HeadTailOutputBuffer(16, 8);
    buffer.append("0123456789abcdefghijkl");
    const first = buffer.snapshot();
    const second = buffer.snapshot();

    expect(second).toEqual(first);
    expect(buffer.drain()).toEqual(first);
    expect(buffer.snapshot()).toEqual({ text: "", totalBytes: 0, omittedBytes: 0 });
    buffer.append("new");
    expect(buffer.snapshot()).toEqual({ text: "new", totalBytes: 3, omittedBytes: 0 });
  });
});
