import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { stageElectronRuntime } from "./stage-electron-runtime.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The D4-2 Electron fixture requires Windows x64.");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDirectory, "..");
const require = createRequire(import.meta.url);
const installedExecutable = require("electron");
const electronPackage = JSON.parse(
  await readFile(require.resolve("electron/package.json"), "utf8"),
);
const testRoot = await mkdtemp(path.join(tmpdir(), "caelush-d4-2-electron-"));
const harnessRoot = path.join(testRoot, "harness");
const runtimeRoot = path.join(testRoot, "runtime");
const userDataRoot = path.join(testRoot, "electron-user-data");
const localAppDataRoot = path.join(testRoot, "local-app-data");
let runtime;

try {
  await Promise.all([
    mkdir(harnessRoot),
    mkdir(runtimeRoot),
    mkdir(userDataRoot),
    mkdir(localAppDataRoot),
  ]);
  const mainBundle = path.join(harnessRoot, "main.cjs");
  await build({
    absWorkingDir: appRoot,
    entryPoints: ["test/windows-d4-2-main.ts"],
    outfile: mainBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  });
  await writeFile(
    path.join(harnessRoot, "package.json"),
    JSON.stringify({ name: "caelush-d4-2-fixture", version: "0.1.0", main: "main.cjs" }),
  );
  runtime = await stageElectronRuntime(
    path.dirname(installedExecutable),
    runtimeRoot,
    electronPackage.version,
  );
  assert.match(runtime.executableSha256, /^[a-f0-9]{64}$/u);

  const child = spawn(runtime.executablePath, [`--user-data-dir=${userDataRoot}`, harnessRoot], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      CAELUSH_D4_TEST_ROOT: testRoot,
      CAELUSH_D4_DESKTOP_APP_ROOT: appRoot,
      LOCALAPPDATA: localAppDataRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  const timeout = setTimeout(() => child.kill(), 180_000);
  try {
    const [code, signal] = await once(child, "close");
    const marker = await readFile(path.join(testRoot, "d4-2-smoke.marker"), "utf8").catch(() => "");
    if (code !== 0 || !marker.includes("D4_2_WINDOWS_ELECTRON_FIXTURE=PASS")) {
      throw new Error(`D4-2 Electron fixture failed (${code ?? signal}).\n${marker.trim()}`);
    }
    process.stdout.write(
      `Windows Electron D4-2 credential fixture passed (Electron ${electronPackage.version}, ${runtime.fileCount} runtime files, SHA-256 ${runtime.executableSha256}).\n`,
    );
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await runtime?.cleanup();
  await rm(testRoot, { recursive: true, force: true });
}
