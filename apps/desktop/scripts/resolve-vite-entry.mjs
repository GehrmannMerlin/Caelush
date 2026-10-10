import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

export function resolveViteEntry() {
  const vitePackageRoot = dirname(require.resolve("vite/package.json"));
  const viteEntry = resolve(vitePackageRoot, "bin", "vite.js");
  if (!existsSync(viteEntry)) {
    throw new Error("The Desktop workspace Vite CLI could not be found.");
  }
  return viteEntry;
}
