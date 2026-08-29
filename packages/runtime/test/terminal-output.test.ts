import { describe, expect, it } from "vitest";
import { TerminalOutputDecoder, sanitizeTerminalOutput } from "../src/index.js";

describe("terminal output", () => {
  it("decodes split UTF-8 and normalizes newlines", () => {
    const decoder = new TerminalOutputDecoder();
    const bytes = new TextEncoder().encode("中文😀\r\nready\r");
    expect(decoder.push(bytes.subarray(0, 5))).toBe("中");
    expect(decoder.push(bytes.subarray(5))).toBe("文😀\nready\n");
    expect(decoder.end()).toBe("");
  });

  it("removes terminal control sequences while preserving useful text", () => {
    expect(
      sanitizeTerminalOutput("ready\u001b[31m red\u001b[0m\u001b]0;title\u0007\u0001\nnext\t"),
    ).toBe("ready red\nnext\t");
  });

  it("does not leak control sequences split across output chunks", () => {
    const decoder = new TerminalOutputDecoder();
    expect(decoder.push(new TextEncoder().encode("ready\u001b[3"))).toBe("ready");
    expect(decoder.push(new TextEncoder().encode("1mred\u001b[0m"))).toBe("red");
    expect(decoder.end()).toBe("");
  });
});
