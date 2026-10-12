import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentSandboxRunner } from "../../../scripts/build-sandbox-runner.mjs";
import { prepareElectronRuntime } from "./stage-electron-runtime.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preparedSandboxRunner = await prepareDevelopmentSandboxRunner({ environment: process.env });
if (preparedSandboxRunner.status === "UNAVAILABLE") {
  process.stderr.write(
    "Caelush could not prepare the Windows security component; restricted permissions remain unavailable.\n",
  );
}
const electronRuntime = await prepareElectronRuntime();
let electron;

try {
  electron = spawn(electronRuntime.executablePath, [appRoot], {
    cwd: appRoot,
    env: preparedSandboxRunner.environment,
    stdio: "inherit",
    windowsHide: false,
  });
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
