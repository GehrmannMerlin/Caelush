import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveDesktopBuildConfiguration } from "./desktop-build-config.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuration = resolveDesktopBuildConfiguration(process.env);
await mkdir(path.join(appRoot, "dist", "main"), { recursive: true });
await mkdir(path.join(appRoot, "dist", "preload"), { recursive: true });

const compiledConfiguration = configuration;
const define = { __CAELUSH_BUILD_CONFIG__: JSON.stringify(JSON.stringify(compiledConfiguration)) };

await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["electron"],
  sourcemap: true,
  define,
});

await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/preload/api.cts"],
  outfile: "dist/preload/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});

process.stdout.write(
  `Desktop Main built (purpose ${configuration.purpose}, channel ${configuration.channel}; offline keys: ${String(Object.keys(configuration.offlinePublicKeys).length)}).\n`,
);
