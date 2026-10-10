import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareElectronRuntime } from "./stage-electron-runtime.mjs";
import { resolveViteEntry } from "./resolve-vite-entry.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererOrigin = "http://127.0.0.1:5173";
const viteEntry = resolveViteEntry();
const env = { ...process.env, CAELUSH_DESKTOP_DEV_URL: rendererOrigin };
const vite = spawn(
  process.execPath,
  [viteEntry, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
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
      const response = await fetch(rendererOrigin, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (attempt === 119) throw new Error("Desktop Vite server did not become ready.");
  }

  electronRuntime = await prepareElectronRuntime();
  electron = spawn(electronRuntime.executablePath, [appRoot], {
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
