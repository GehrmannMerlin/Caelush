import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveViteEntry } from "../../scripts/resolve-vite-entry.mjs";

const require = createRequire(import.meta.url);

describe("Desktop Vite entry resolution", () => {
  it("resolves the CLI beside the Desktop workspace's Vite package", () => {
    const vitePackageJson = require.resolve("vite/package.json");
    const expectedEntry = resolve(dirname(vitePackageJson), "bin", "vite.js");
    const rootHoistedEntry = resolve(process.cwd(), "../../node_modules/vite/bin/vite.js");

    expect(resolveViteEntry()).toBe(expectedEntry);
    expect(resolveViteEntry()).not.toBe(rootHoistedEntry);
  });
});
