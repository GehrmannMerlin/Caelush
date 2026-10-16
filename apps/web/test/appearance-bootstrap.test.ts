import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const bootstrapUrl = new URL("../public/assets/appearance-bootstrap.js", import.meta.url);

async function runBootstrap(options: {
  readonly desktopBridge?: unknown;
  readonly storedValue?: string | null;
  readonly systemDark?: boolean;
}) {
  const script = await readFile(bootstrapUrl, "utf8");
  const getItem = vi.fn(() => options.storedValue ?? null);
  const matchMedia = vi.fn(() => ({ matches: options.systemDark ?? false }));
  const documentElement = { dataset: {} as Record<string, string> };
  const themeMeta = { setAttribute: vi.fn() };
  const window: Record<string, unknown> = {
    localStorage: { getItem },
    matchMedia,
  };
  if (options.desktopBridge !== undefined) window.caelushDesktop = options.desktopBridge;

  runInNewContext(script, {
    window,
    document: { documentElement, querySelector: () => themeMeta },
  });

  return { documentElement, getItem, matchMedia, themeMeta };
}

describe("shared Web appearance bootstrap", () => {
  it("uses the native Desktop snapshot without consulting browser storage", async () => {
    const result = await runBootstrap({
      desktopBridge: {
        appearance: {
          capabilityVersion: 1,
          initialSnapshot: { preference: "dark", resolvedTheme: "dark", revision: 4 },
        },
      },
      storedValue: JSON.stringify({ version: 1, preference: "light" }),
    });

    expect(result.documentElement.dataset.caelushTheme).toBe("dark");
    expect(result.themeMeta.setAttribute).toHaveBeenCalledWith("content", "#181818");
    expect(result.getItem).not.toHaveBeenCalled();
    expect(result.matchMedia).not.toHaveBeenCalled();
  });

  it("continues to use the browser preference when running as Web", async () => {
    const result = await runBootstrap({
      storedValue: JSON.stringify({ version: 1, preference: "dark" }),
    });

    expect(result.documentElement.dataset.caelushTheme).toBe("dark");
    expect(result.getItem).toHaveBeenCalledWith("caelush.appearance.v1");
  });
});
