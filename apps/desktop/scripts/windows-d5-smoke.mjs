import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const requestedTestRoot = process.env.CAELUSH_D6_TEST_ROOT;
const testRoot = requestedTestRoot
  ? path.resolve(requestedTestRoot)
  : await mkdtemp(path.join(tmpdir(), "caelush-d5-electron-"));
const ownsTestRoot = requestedTestRoot === undefined;
const harnessRoot = await mkdtemp(path.join(testRoot, "d5-harness-"));
const runtimeRoot = path.resolve(
  process.env.CAELUSH_D6_ELECTRON_RUNTIME_ROOT ?? path.join(testRoot, "runtime"),
);
const userDataRoot = path.join(testRoot, "electron-user-data");
const localAppDataRoot = path.join(testRoot, "local-app-data");
let runtime;

try {
  await Promise.all([
    mkdir(harnessRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(userDataRoot, { recursive: true }),
    mkdir(localAppDataRoot, { recursive: true }),
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
          channel: "dev",
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
  if (process.env.CAELUSH_D6_USE_ELECTRON_RUNTIME === "1") {
    const executableBytes = await readFile(installedExecutable);
    runtime = {
      executablePath: installedExecutable,
      executableSha256: createHash("sha256").update(executableBytes).digest("hex"),
      fileCount: 0,
      cleanup: async () => undefined,
    };
  } else {
    runtime = await stageElectronRuntime(
      path.dirname(installedExecutable),
      runtimeRoot,
      electronPackage.version,
    );
  }
  assert.match(runtime.executableSha256, /^[a-f0-9]{64}$/u);

  const child = spawn(runtime.executablePath, [`--user-data-dir=${userDataRoot}`, harnessRoot], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      CAELUSH_D5_TEST_ROOT: testRoot,
      CAELUSH_D5_DESKTOP_APP_ROOT:
        process.env.CAELUSH_D6_RESOURCE_ROOT === undefined
          ? appRoot
          : path.join(process.env.CAELUSH_D6_RESOURCE_ROOT, "app.asar"),
      ...(process.env.CAELUSH_D6_RESOURCE_ROOT === undefined
        ? {}
        : { CAELUSH_D6_RESOURCE_ROOT: process.env.CAELUSH_D6_RESOURCE_ROOT }),
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
    // `exit` fires before Node has closed the child pipes. The Electron harness appends its
    // durable marker during shutdown, so wait for `close` before reading that marker.
    const [code, signal] = await once(child, "close");
    const markerPath = path.join(testRoot, "d5-smoke.marker");
    const marker = await readFile(markerPath, "utf8").catch(() => "");
    if (code !== 0 || !marker.includes("D5_MAIN_RUNTIME_CHECKS=PASS")) {
      const rootEntries = await readdir(testRoot).catch(() => []);
      throw new Error(
        `D5 Windows Electron smoke failed (${code ?? signal}; markerBytes=${Buffer.byteLength(marker)}; rootEntries=${rootEntries.join(",")}).\n${marker.trim()}\n${childOutput.trim()}`,
      );
    }
    await appendFile(markerPath, "D5_WINDOWS_ELECTRON_SMOKE=PASS\n", "utf8");
    process.stdout.write(
      `Windows Electron D5 smoke passed (Electron ${electronPackage.version}, ${runtime.fileCount} runtime files, SHA-256 ${runtime.executableSha256}, exit code ${code}).\n${marker}D5_WINDOWS_ELECTRON_SMOKE=PASS\n`,
    );
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await runtime?.cleanup();
  if (ownsTestRoot) {
    await cleanupOwnedTestRoot();
  }
}

async function cleanupOwnedTestRoot() {
  try {
    await rm(testRoot, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    process.stderr.write(`D5_TEST_ARTIFACT_CLEANUP=BLOCKED_BY_OPEN_EDITOR ${testRoot}\n`);
  }
}
