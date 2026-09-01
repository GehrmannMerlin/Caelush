export const INTERACTIVE_TTY_ERROR =
  'Interactive Caelush requires a terminal.\nUse `caelush --print "..."` for non-interactive execution.\n';

export function hasInteractiveTerminal(input: {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}): boolean {
  return input.stdinIsTTY && input.stdoutIsTTY;
}
