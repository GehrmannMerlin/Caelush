import type { ResolvedTheme } from "@caelush/ui-theme";

export interface DesktopTerminalTheme {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly cursorAccent: string;
  readonly selectionBackground: string;
  readonly black: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly white: string;
  readonly brightBlack: string;
  readonly brightRed: string;
  readonly brightGreen: string;
  readonly brightYellow: string;
  readonly brightBlue: string;
  readonly brightMagenta: string;
  readonly brightCyan: string;
  readonly brightWhite: string;
}

const terminalThemes: Readonly<Record<ResolvedTheme, DesktopTerminalTheme>> = {
  light: {
    background: "#f7f8fa",
    foreground: "#1f2937",
    cursor: "#2563eb",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(37, 99, 235, 0.22)",
    black: "#1f2937",
    red: "#b42332",
    green: "#15803d",
    yellow: "#a16207",
    blue: "#2563eb",
    magenta: "#9333a6",
    cyan: "#0e7490",
    white: "#e5e7eb",
    brightBlack: "#64748b",
    brightRed: "#dc3545",
    brightGreen: "#16a34a",
    brightYellow: "#ca8a04",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#0891b2",
    brightWhite: "#ffffff",
  },
  dark: {
    background: "#181818",
    foreground: "#e9e9e9",
    cursor: "#7aa2ff",
    cursorAccent: "#181818",
    selectionBackground: "rgba(122, 162, 255, 0.28)",
    black: "#252525",
    red: "#ff7777",
    green: "#71cf91",
    yellow: "#e2b35c",
    blue: "#7aa2ff",
    magenta: "#d59aff",
    cyan: "#6bd3dc",
    white: "#d6d6d6",
    brightBlack: "#8a8a8a",
    brightRed: "#ff9b9b",
    brightGreen: "#91e6a9",
    brightYellow: "#f0ca78",
    brightBlue: "#9bb8ff",
    brightMagenta: "#e0b2ff",
    brightCyan: "#8ae3eb",
    brightWhite: "#ffffff",
  },
};

export function resolveDesktopTerminalTheme(theme: ResolvedTheme): DesktopTerminalTheme {
  return terminalThemes[theme];
}
