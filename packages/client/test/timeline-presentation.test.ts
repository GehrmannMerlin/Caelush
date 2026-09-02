import { describe, expect, it } from "vitest";
import {
  sanitizeTerminalText,
  truncateTimelineText,
  workspaceRelativePath,
} from "../src/timeline/presentation.js";

describe("shared Timeline presentation", () => {
  it("bounds Unicode text by UTF-8 bytes without splitting emoji", () => {
    const value = truncateTimelineText("头头头-keep-head-😀😀😀-keep-tail-尾尾尾", 40);
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(40);
    expect(value).toContain("… output truncated …");
    expect(value).not.toContain("\uFFFD");
  });

  it.each([0, 1, 2, 10, 25, 26, 27, 28])("never exceeds a small byte limit: %i", (maxBytes) => {
    const value = truncateTimelineText("😀😀😀", maxBytes);
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(maxBytes);
    expect(value).not.toContain("\uFFFD");
  });

  it("handles multibyte cuts and exact boundaries without replacement characters", () => {
    const value = truncateTimelineText("😀😀", 5);
    expect(value).toBe("😀");
    expect(new TextEncoder().encode(value).byteLength).toBe(4);
    expect(truncateTimelineText("😀", 4)).toBe("😀");
    expect(truncateTimelineText("😀", 3)).toBe("");
  });

  it("handles emoji-only input at the byte bound", () => {
    const value = truncateTimelineText("😀😀", 8);
    expect(value).toBe("😀😀");
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(8);
  });

  it("sanitizes terminal control sequences without Node globals", () => {
    expect(sanitizeTerminalText("ok\u001b]0;secret\u0007\u001b[31m 😀\u001b[0m\r\nnext")).toBe(
      "ok 😀\nnext",
    );
  });

  it("rejects absolute and parent-traversal paths", () => {
    expect(workspaceRelativePath("src/index.ts")).toBe("src/index.ts");
    expect(workspaceRelativePath("C:\\secret.txt")).toBeUndefined();
    expect(workspaceRelativePath("../secret.txt")).toBeUndefined();
  });
});
