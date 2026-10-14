import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { prepareDevelopmentSandboxRunner } from "../../../scripts/build-sandbox-runner.mjs";

export function prepareDesktopStartSandbox(options = {}) {
  return prepareDevelopmentSandboxRunner({ ...options, buildIfMissing: false });
}

export function resolveDesktopDevelopmentConfiguration(appRoot, args, environment = process.env) {
  let dataRoot = environment.CAELUSH_DESKTOP_DEV_DATA_ROOT;
  let explicitDirectory = dataRoot !== undefined;
  for (let index = 0; index < args.length; index += 2) {
    if (
      args[index] !== "--isolated-data-dir" ||
      args[index + 1] === undefined ||
      explicitDirectory
    ) {
      throw new Error("Usage: Desktop dev/start [--isolated-data-dir <absolute-path>]");
    }
    dataRoot = args[index + 1];
    explicitDirectory = true;
  }
  if (dataRoot !== undefined && (!path.isAbsolute(dataRoot) || dataRoot.trim().length === 0)) {
    throw new Error("The isolated data directory must be an absolute path.");
  }
  dataRoot = path.resolve(dataRoot ?? path.join(appRoot, ".stage", "development"));
  return Object.freeze({
    dataRoot,
    userDataDirectory: path.join(dataRoot, "electron-user-data"),
    runtimeCacheRoot: explicitDirectory
      ? path.join(dataRoot, "temp", "electron-runtime")
      : path.join(appRoot, ".stage", "electron-runtime"),
    rendererPort: 5174,
  });
}

export async function assertDesktopBuildReady(appRoot, { liveRenderer = false } = {}) {
  const files = [
    "dist/main/index.js",
    "dist/preload/index.cjs",
    ".stage/daemon/node.exe",
    ".stage/daemon/user-terminal-helper.mjs",
    "../daemon/dist/desktop-entry.js",
    ".stage/web/index.html",
    ...(liveRenderer ? [] : ["dist/renderer/index.html"]),
  ];
  for (const file of files) {
    try {
      if (!(await stat(path.resolve(appRoot, file))).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(
        `Desktop build artifact is missing: ${file}. Run pnpm --filter @caelush/desktop build first.`,
      );
    }
  }
}
