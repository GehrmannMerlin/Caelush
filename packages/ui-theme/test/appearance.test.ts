import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appearanceUrl = new URL("../src/appearance.ts", import.meta.url);

async function loadAppearanceModule() {
  expect(existsSync(appearanceUrl)).toBe(true);
  return import(appearanceUrl.href);
}

describe("appearance contracts", () => {
  it("accepts only the three supported preferences and defaults invalid values to light", async () => {
    const { parseThemePreference } = await loadAppearanceModule();

    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("future-theme")).toBe("light");
    expect(parseThemePreference(null)).toBe("light");
  });

  it("resolves system preference from the current operating-system theme", async () => {
    const { resolveThemePreference } = await loadAppearanceModule();

    expect(resolveThemePreference("light", "dark")).toBe("light");
    expect(resolveThemePreference("dark", "light")).toBe("dark");
    expect(resolveThemePreference("system", "light")).toBe("light");
    expect(resolveThemePreference("system", "dark")).toBe("dark");
  });

  it("keeps appearance snapshots limited to preference, resolved theme, and revision", () => {
    const snapshot = { preference: "system", resolvedTheme: "dark", revision: 4 } as const;

    expect(Object.keys(snapshot).sort()).toEqual(["preference", "resolvedTheme", "revision"]);
  });
});
