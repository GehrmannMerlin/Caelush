import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lightUrl = new URL("../src/styles/light.css", import.meta.url);
const darkUrl = new URL("../src/styles/dark.css", import.meta.url);

function readPalette(url: URL): string {
  return existsSync(url) ? readFileSync(url, "utf8") : "";
}

function semanticTokenNames(css: string): string[] {
  return [...css.matchAll(/(--caelush-[a-z0-9-]+)\s*:/g)].map((match) => match[1]!).sort();
}

describe("appearance palettes", () => {
  it("ships separately scoped light and dark palette files", () => {
    expect(existsSync(lightUrl)).toBe(true);
    expect(existsSync(darkUrl)).toBe(true);
    expect(readPalette(lightUrl)).toContain(':root[data-caelush-theme="light"]');
    expect(readPalette(darkUrl)).toContain(':root[data-caelush-theme="dark"]');
  });

  it("defines the same complete semantic token set for both modes", () => {
    const light = semanticTokenNames(readPalette(lightUrl));
    const dark = semanticTokenNames(readPalette(darkUrl));

    expect(light.length).toBeGreaterThan(0);
    expect(dark).toEqual(light);
  });

  it("pins the confirmed dark surfaces and blue link color", () => {
    const dark = readPalette(darkUrl);

    expect(dark).toContain("--caelush-page: #181818");
    expect(dark).toContain("--caelush-sidebar: #1b1b1b");
    expect(dark).toContain("--caelush-input: #363636");
    expect(dark).toContain("--caelush-card: #2a2a2a");
    expect(dark).toContain("--caelush-link: #7aa2ff");
  });
});
