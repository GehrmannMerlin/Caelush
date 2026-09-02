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
