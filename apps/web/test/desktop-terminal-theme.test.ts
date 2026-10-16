import { describe, expect, it } from "vitest";
import { resolveDesktopTerminalTheme } from "../src/components/desktop-terminal-theme.js";

describe("Desktop terminal appearance", () => {
  it("uses paired readable palettes for light and dark themes", () => {
    expect(resolveDesktopTerminalTheme("light")).toMatchObject({
      background: "#f7f8fa",
      foreground: "#1f2937",
      cursor: "#2563eb",
    });
    expect(resolveDesktopTerminalTheme("dark")).toMatchObject({
      background: "#181818",
      foreground: "#e9e9e9",
      cursor: "#7aa2ff",
      selectionBackground: "rgba(122, 162, 255, 0.28)",
    });
  });
});
