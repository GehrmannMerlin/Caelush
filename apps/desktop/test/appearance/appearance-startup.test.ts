import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const desktopRoot = new URL("../../", import.meta.url);

async function readDesktopFile(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, desktopRoot), "utf8");
}

describe("Desktop appearance startup", () => {
  it("loads the synchronous appearance bootstrap before the renderer module", async () => {
    const html = await readDesktopFile("index.html");
    const bootstrapScriptIndex = html.indexOf('src="/appearance-bootstrap.js"');
    const bootstrapStyleIndex = html.indexOf('href="/appearance-bootstrap.css"');
    const rendererModuleIndex = html.indexOf('type="module" src="/src/renderer/main.tsx"');

    expect(bootstrapScriptIndex).toBeGreaterThan(-1);
    expect(bootstrapStyleIndex).toBeGreaterThan(-1);
    expect(bootstrapScriptIndex).toBeLessThan(rendererModuleIndex);
    expect(bootstrapStyleIndex).toBeLessThan(rendererModuleIndex);
  });

  it("uses the Desktop main-process snapshot without reading browser storage", async () => {
    const script = await readDesktopFile("resources/appearance-bootstrap.js");
    const getItem = vi.fn(() => null);
    const documentElement = { dataset: {} as Record<string, string> };
    const themeMeta = { setAttribute: vi.fn() };
    const window = {
      caelushDesktop: {
        appearance: {
          capabilityVersion: 1,
          initialSnapshot: { preference: "dark", resolvedTheme: "dark", revision: 7 },
        },
      },
      localStorage: { getItem },
      matchMedia: vi.fn(() => ({ matches: false })),
    };

    runInNewContext(script, {
      window,
      document: {
        documentElement,
        querySelector: () => themeMeta,
      },
    });

    expect(documentElement.dataset.caelushTheme).toBe("dark");
    expect(themeMeta.setAttribute).toHaveBeenCalledWith("content", "#181818");
    expect(getItem).not.toHaveBeenCalled();
    expect(window.matchMedia).not.toHaveBeenCalled();
  });

  it("provides a native dark canvas before application styles load", async () => {
    const css = await readDesktopFile("resources/appearance-bootstrap.css");

    expect(css).toContain(':root[data-caelush-theme="dark"]');
    expect(css).toContain("color-scheme: dark");
    expect(css).toContain("#181818");
    expect(css).toContain(':root[data-caelush-theme="light"]');
    expect(css).toContain("color-scheme: light");
  });
});
