import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareElectronRuntime } from "./stage-electron-runtime.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronRuntime = await prepareElectronRuntime();
let electron;

try {
  electron = spawn(electronRuntime.executablePath, [appRoot], {
    cwd: appRoot,
    env: process.env,
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
