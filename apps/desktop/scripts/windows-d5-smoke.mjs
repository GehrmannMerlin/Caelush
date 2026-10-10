import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { stageElectronRuntime } from "./stage-electron-runtime.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The D5 Electron smoke requires Windows x64.");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDirectory, "..");
const require = createRequire(import.meta.url);
const installedExecutable = require("electron");
const electronPackage = JSON.parse(
  await readFile(require.resolve("electron/package.json"), "utf8"),
);
const testRoot = await mkdtemp(path.join(tmpdir(), "caelush-d5-electron-"));
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
    entryPoints: ["test/windows-d5-main.ts"],
    outfile: mainBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    define: {
      __CAELUSH_BUILD_CONFIG__: JSON.stringify(
        JSON.stringify({
          production: false,
          cloudOrigin: "http://127.0.0.1:8000",
          offlinePublicKeys: {},
          externalHttpsHosts: ["github.com", "www.caelush.com"],
        }),
      ),
    },
  });
  await writeFile(
    path.join(harnessRoot, "package.json"),
    JSON.stringify({ name: "caelush-d5-fixture", version: "0.1.0", main: "main.cjs" }),
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
      CAELUSH_D5_TEST_ROOT: testRoot,
      CAELUSH_D5_DESKTOP_APP_ROOT: appRoot,
      LOCALAPPDATA: localAppDataRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let childOutput = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      childOutput = `${childOutput}${String(chunk)}`.slice(-64 * 1024);
      (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
    });
  }
  const timeout = setTimeout(() => {
    if (child.pid !== undefined) {
      const taskkill = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "taskkill.exe",
      );
      try {
        execFileSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        child.kill();
      }
      process.stderr.write("D5 Windows Electron smoke exceeded its 240-second limit.\n");
    } else {
      child.kill();
    }
  }, 240_000);
  try {
    const [code, signal] = await once(child, "exit");
    child.stdout?.destroy();
    child.stderr?.destroy();
    const marker = await readFile(path.join(testRoot, "d5-smoke.marker"), "utf8").catch(() => "");
    if (code !== 0 || !marker.includes("D5_WINDOWS_ELECTRON_SMOKE=PASS")) {
      throw new Error(
        `D5 Windows Electron smoke failed (${code ?? signal}).\n${marker.trim()}\n${childOutput.trim()}`,
      );
    }
    process.stdout.write(
      `Windows Electron D5 smoke passed (Electron ${electronPackage.version}, ${runtime.fileCount} runtime files, SHA-256 ${runtime.executableSha256}).\n${marker}`,
    );
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await runtime?.cleanup();
  try {
    await rm(testRoot, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    process.stderr.write(`D5_TEST_ARTIFACT_CLEANUP=BLOCKED_BY_OPEN_EDITOR ${testRoot}\n`);
  }
}
