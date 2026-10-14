import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareElectronRuntime } from "./stage-electron-runtime.mjs";
import {
  assertDesktopBuildReady,
  prepareDesktopStartSandbox,
  resolveDesktopDevelopmentConfiguration,
} from "./development-launch.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launch = resolveDesktopDevelopmentConfiguration(appRoot, process.argv.slice(2));
await assertDesktopBuildReady(appRoot);
await mkdir(launch.userDataDirectory, { recursive: true });
const preparedSandboxRunner = await prepareDesktopStartSandbox({ environment: process.env });
if (preparedSandboxRunner.status === "UNAVAILABLE") {
  process.stderr.write(
    "Caelush could not prepare the Windows security component; restricted permissions remain unavailable.\n",
  );
}
const electronRuntime = await prepareElectronRuntime({ tempRoot: launch.runtimeCacheRoot });
let electron;

try {
  electron = spawn(
    electronRuntime.executablePath,
    [`--user-data-dir=${launch.userDataDirectory}`, appRoot],
    {
      cwd: appRoot,
      env: {
        ...preparedSandboxRunner.environment,
        CAELUSH_DESKTOP_DEV_URL: "",
        CAELUSH_DESKTOP_DEV_DATA_ROOT: launch.dataRoot,
      },
      stdio: "inherit",
      windowsHide: false,
    },
  );
  electron.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 0);
  });
  await once(electron, "close").catch(() => undefined);
} finally {
  if (electron && electron.exitCode === null) {
    const closed = once(electron, "close").catch(() => undefined);
    electron.kill();
    await closed;
  }
  await electronRuntime.cleanup();
}
