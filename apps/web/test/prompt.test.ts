import { describe, expect, it } from "vitest";
import {
  MAX_WEB_PROMPT_BYTES,
  derivePromptTitle,
  validatePrompt,
} from "../src/application/prompt.js";

describe("Web prompt admission", () => {
  it("rejects empty and whitespace-only prompts", () => {
    expect(validatePrompt("  \n\t")).toMatchObject({
      ok: false,
      error: { code: "PROMPT_REQUIRED" },
    });
  });

  it("preserves trimmed multiline Unicode text and counts UTF-8 bytes", () => {
    const result = validatePrompt("  修复 😀\n第二行  ");

    expect(result).toEqual({ ok: true, value: "修复 😀\n第二行" });
  });

  it("accepts exactly the 32 KiB UTF-8 prompt bound", () => {
    const value = "😀".repeat(MAX_WEB_PROMPT_BYTES / 4);

    expect(validatePrompt(value)).toEqual({ ok: true, value });
  });

  it("rejects prompts above the UTF-8 byte bound", () => {
    const value = "😀".repeat(MAX_WEB_PROMPT_BYTES / 4 + 1);

    expect(validatePrompt(value)).toMatchObject({
      ok: false,
      error: { code: "PROMPT_TOO_LARGE" },
    });
  });

  it("derives a bounded title from the first prompt line without an LLM", () => {
    expect(derivePromptTitle("  第一行任务\n第二行")).toBe("第一行任务");
    expect(derivePromptTitle("x".repeat(200))).toHaveLength(80);
  });
});
