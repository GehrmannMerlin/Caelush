import { describe, expect, it } from "vitest";
import {
  formatFileChange,
  formatRunTerminal,
  formatToolLabel,
  processStatusLabel,
  runStatusLabel,
  sanitizeTerminalText,
  truncateTimelineText,
  workspaceRelativePath,
} from "../src/timeline/presentation.js";

describe("shared Timeline presentation", () => {
  it("preserves established CLI labels and file summaries", () => {
    expect(formatToolLabel("read_file")).toBe("Read file");
    expect(formatToolLabel("exec_command")).toBe("Run command");
    expect(runStatusLabel("PENDING")).toBe("Preparing");
    expect(runStatusLabel("RUNNING")).toBe("Working");
    expect(runStatusLabel("WAITING_APPROVAL")).toBe("Approval required");
    expect(runStatusLabel("VERIFYING")).toBe("Verifying");
    expect(runStatusLabel("CANCELLED")).toBe("Cancelled");
    expect(processStatusLabel("RUNNING")).toBe("running");
    expect(processStatusLabel("EXITED")).toBe("exited");
    expect(
      formatFileChange({ path: "src/a.ts", changeType: "MODIFIED", additions: 2, deletions: 1 }),
    ).toBe("M src/a.ts (+2, -1)");
    expect(formatRunTerminal("FAILED")).toBe("Run ended with status Failed.");
  });

  it("keeps the marker within the UTF-8 byte bound and preserves the tail", () => {
    const value = truncateTimelineText("head-".repeat(20) + "TAIL", 40);
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(40);
    expect(value).toContain("TAIL");
    expect(value).not.toContain("�");
  });
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
