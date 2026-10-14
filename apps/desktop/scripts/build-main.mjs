import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadDesktopBuildEnvironment,
  resolveDesktopBuildConfiguration,
} from "./desktop-build-config.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = await loadDesktopBuildEnvironment(appRoot, process.env);
const configuration = resolveDesktopBuildConfiguration(environment);
const mainOutput = path.join(appRoot, "dist", "main");
const preloadOutput = path.join(appRoot, "dist", "preload");
await rm(mainOutput, { recursive: true, force: true });
await rm(preloadOutput, { recursive: true, force: true });
await mkdir(mainOutput, { recursive: true });
await mkdir(preloadOutput, { recursive: true });

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
  minify: configuration.purpose !== "development",
  sourcemap:
    configuration.purpose === "development" ||
    environment.CAELUSH_DESKTOP_INCLUDE_SOURCEMAPS === "true",
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
  `Desktop Main built (purpose ${configuration.purpose}, channel ${configuration.channel}, Cloud ${configuration.cloudOrigin}; offline keys: ${String(Object.keys(configuration.offlinePublicKeys).length)}).\n`,
);
