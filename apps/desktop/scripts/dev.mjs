import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentSandboxRunner } from "../../../scripts/build-sandbox-runner.mjs";
import { prepareElectronRuntime } from "./stage-electron-runtime.mjs";
import { resolveViteEntry } from "./resolve-vite-entry.mjs";
import {
  assertDesktopBuildReady,
  resolveDesktopDevelopmentConfiguration,
} from "./development-launch.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launch = resolveDesktopDevelopmentConfiguration(appRoot, process.argv.slice(2));
await assertDesktopBuildReady(appRoot, { liveRenderer: true });
const rendererPort = launch.rendererPort;
const rendererOrigin = `http://127.0.0.1:${rendererPort}`;
const viteEntry = resolveViteEntry();
await mkdir(launch.userDataDirectory, { recursive: true });
const electronArguments = [`--user-data-dir=${launch.userDataDirectory}`];
const preparedSandboxRunner = await prepareDevelopmentSandboxRunner({ environment: process.env });
if (preparedSandboxRunner.status === "UNAVAILABLE") {
  process.stderr.write(
    "Caelush could not prepare the Windows security component; restricted permissions remain unavailable.\n",
  );
}
const env = {
  ...preparedSandboxRunner.environment,
  CAELUSH_DESKTOP_DEV_URL: rendererOrigin,
  CAELUSH_DESKTOP_DEV_DATA_ROOT: launch.dataRoot,
};
const vite = spawn(
  process.execPath,
  [viteEntry, "--host", "127.0.0.1", "--port", String(rendererPort), "--strictPort"],
  {
    cwd: appRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  },
);
let electron;
let electronRuntime;
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  if (electron && electron.exitCode === null) electron.kill();
  if (vite.exitCode === null) vite.kill();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
vite.once("exit", (code) => {
  if (!stopping && code !== 0) {
    process.exitCode = code ?? 1;
    stop();
  }
});

try {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (vite.exitCode !== null)
      throw new Error("Desktop Vite server exited before it became ready.");
    try {
      const response = await globalThis.fetch(rendererOrigin, {
        signal: globalThis.AbortSignal.timeout(500),
      });
      if (response.ok) break;
    } catch {
      await setTimeout(250);
    }
    if (attempt === 119) throw new Error("Desktop Vite server did not become ready.");
  }

  electronRuntime = await prepareElectronRuntime({
    tempRoot: launch.runtimeCacheRoot,
  });
  electron = spawn(electronRuntime.executablePath, [...electronArguments, appRoot], {
    cwd: appRoot,
    env,
    stdio: "inherit",
    windowsHide: false,
  });

  electron.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 0);
  });
  await once(electron, "close").catch(() => undefined);
} finally {
  stop();
  if (electronRuntime !== undefined) await electronRuntime.cleanup();
}
