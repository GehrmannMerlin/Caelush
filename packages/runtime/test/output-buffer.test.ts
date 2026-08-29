import { describe, expect, it } from "vitest";
import { HeadTailOutputBuffer } from "../src/index.js";

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
});
