import { describe, expect, it } from "vitest";
import {
  boundToolModelContent,
  DEFAULT_TOOL_OUTPUT_POLICY,
  validateToolOutputPolicy,
} from "../src/output-policy.js";

describe("tool output policy", () => {
  it("leaves content unchanged through the exact byte boundary", () => {
    const content = "hello";

    expect(boundToolModelContent(content, { maxModelContentBytes: 5, maxDetailsBytes: 10 })).toBe(
      content,
    );
  });

  it("truncates at UTF-8 boundaries and states that output was truncated", () => {
    const content = "ab中文🙂cd".repeat(3);
    const bounded = boundToolModelContent(content, {
      maxModelContentBytes: 30,
      maxDetailsBytes: 10,
    });

    expect(bounded).toContain("[output truncated]");
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(30);
    expect(() => encodeURIComponent(bounded)).not.toThrow();
  });

  it("returns a deterministic safe prefix when the marker cannot fit", () => {
    expect(boundToolModelContent("中文", { maxModelContentBytes: 3, maxDetailsBytes: 10 })).toBe(
      "中",
    );
    expect(boundToolModelContent("中文", { maxModelContentBytes: 1, maxDetailsBytes: 10 })).toBe(
      "",
    );
  });

  it("provides and validates the default policy", () => {
    expect(DEFAULT_TOOL_OUTPUT_POLICY).toEqual({
      maxModelContentBytes: 64 * 1024,
      maxDetailsBytes: 256 * 1024,
    });
    expect(() =>
      validateToolOutputPolicy({ maxModelContentBytes: 0, maxDetailsBytes: 10 }),
    ).toThrow(/positive integer/i);
    expect(() =>
      validateToolOutputPolicy({ maxModelContentBytes: 10, maxDetailsBytes: 0 }),
    ).toThrow(/positive integer/i);
  });
});
