import { describe, expect, it } from "vitest";
import { INTERACTIVE_TTY_ERROR, hasInteractiveTerminal } from "../src/tty.js";

describe("interactive terminal gate", () => {
  it("requires both stdin and stdout to be terminals", () => {
    expect(hasInteractiveTerminal({ stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
    expect(hasInteractiveTerminal({ stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
    expect(hasInteractiveTerminal({ stdinIsTTY: true, stdoutIsTTY: false })).toBe(false);
    expect(INTERACTIVE_TTY_ERROR).toBe(
      'Interactive Caelush requires a terminal.\nUse `caelush --print "..."` for non-interactive execution.\n',
    );
  });
});
