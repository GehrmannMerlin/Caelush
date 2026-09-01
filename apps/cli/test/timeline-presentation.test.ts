import { describe, expect, it } from "vitest";
import {
  formatFileChange,
  formatFileMove,
  formatToolLabel,
  sanitizeTerminalText,
  truncateTimelineText,
  workspaceRelativePath,
} from "../src/application/timeline-presentation.js";

describe("CLI timeline presentation", () => {
  it("uses human labels and preserves unknown tool names", () => {
    expect(formatToolLabel("read_file")).toBe("Read file");
    expect(formatToolLabel("exec_command")).toBe("Run command");
    expect(formatToolLabel("future_tool")).toBe("future_tool");
  });

  it("renders file changes with explicit A/M/D/R markers and line counts", () => {
    expect(
      formatFileChange({
        path: "src/index.ts",
        changeType: "MODIFIED",
        additions: 4,
        deletions: 2,
      }),
    ).toBe("M src/index.ts (+4, -2)");
    expect(formatFileChange({ path: "old.ts", changeType: "MOVED" })).toBe("R old.ts");
    expect(formatFileMove("old.ts", "src/new.ts")).toBe("R old.ts → src/new.ts");
    expect(formatFileMove("C:\\secret.txt", "src/new.ts")).toBe("R (path omitted) → src/new.ts");
  });

  it("rejects absolute and parent-traversal paths from user-facing display", () => {
    expect(workspaceRelativePath("src/index.ts")).toBe("src/index.ts");
    expect(workspaceRelativePath("C:\\secret.txt")).toBeUndefined();
    expect(workspaceRelativePath("../secret.txt")).toBeUndefined();
    expect(workspaceRelativePath("/etc/passwd")).toBeUndefined();
  });

  it("removes terminal control sequences while retaining text, newlines, tabs and Unicode", () => {
    const raw = "ok\u001b]0;title\u0007\u001b[31m 😀\u001b[0m\r\nnext\tline\u0007";
    expect(sanitizeTerminalText(raw)).toBe("ok 😀\nnext\tline");
  });

  it("truncates by UTF-8 bytes with a visible marker and keeps head and tail", () => {
    const value = truncateTimelineText("头头头-keep-head-中中中-keep-tail-尾尾尾", 40);
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(40);
    expect(value).toContain("… output truncated …");
    expect(value).toContain("头");
    expect(value).toContain("尾");
  });
});
