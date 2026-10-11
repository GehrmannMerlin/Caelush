import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { stageElectronRuntime } from "./stage-electron-runtime.mjs";
import {
  validateDesktopResourceManifest,
  verifyDesktopResourceFiles,
} from "../src/shared/resource-manifest.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("D6 Electron path probing requires Windows x64.");
}

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(APP_ROOT, "..", "..");
const OUTPUT_ROOT = path.resolve(process.env.CAELUSH_DESKTOP_OUTPUT_ROOT ?? "D:\\");
const RUN_ID = `${process.pid}-${randomUUID()}`;
const PROBE_ROOT = path.join(OUTPUT_ROOT, `.d6-electron-path-probe-${RUN_ID}`);
const DATA_ROOT = path.join(PROBE_ROOT, "data");
const WIN_UNPACKED = path.join(OUTPUT_ROOT, "win-unpacked");
const PLAIN_COPY = path.join("D:\\", `CaelushD6PathPlain-${RUN_ID}`);
const COMPLEX_COPY = path.join("D:\\", `Caelush D6 路径探针-${RUN_ID}`);
const D3_STAGE_ROOT = path.join("D:\\", `CaelushD6ElectronStage-${RUN_ID}`);
const pathProbeOnly = process.env.CAELUSH_D6_ELECTRON_PATH_PROBE_ONLY;
const require = createRequire(import.meta.url);
let nextCdpCommandId = 0;

if (pathProbeOnly !== undefined && pathProbeOnly !== "D3") {
  throw new Error("CAELUSH_D6_ELECTRON_PATH_PROBE_ONLY must be D3 when provided.");
}

assert.equal(path.parse(OUTPUT_ROOT).root.toLowerCase(), "d:\\");
assert.equal(isInside(OUTPUT_ROOT, REPOSITORY_ROOT), false);
assert.equal(isInside(PROBE_ROOT, REPOSITORY_ROOT), false);
for (const pathToCheck of [PROBE_ROOT, PLAIN_COPY, COMPLEX_COPY]) {
  assert.equal(path.parse(pathToCheck).root.toLowerCase(), "d:\\");
  assert.equal(
    await pathExists(pathToCheck),
    false,
    "An Electron path probe destination already exists.",
  );
}
await mkdir(PROBE_ROOT, { recursive: false });
await mkdir(DATA_ROOT, { recursive: false });

const packagedResources = path.join(WIN_UNPACKED, "resources");
const manifest = validateDesktopResourceManifest(
  JSON.parse(
    await readFile(path.join(packagedResources, "desktop-resource-manifest.json"), "utf8"),
  ),
);
assert.equal(manifest.productVersion, "0.1.0");
assert.equal(manifest.channel, "dev");
const originalResourceVerification = await verifyDesktopResourceFiles(manifest, packagedResources);
let stagedRuntime;
let completed = false;

try {
  await assertSafeDirectory(WIN_UNPACKED);
  const winUnpackedBytes = await directoryBytes(WIN_UNPACKED);
  const resourceBytes = await directoryBytes(packagedResources);
  const electronExecutable = require("electron");
  const electronPackage = JSON.parse(
    await readFile(require.resolve("electron/package.json"), "utf8"),
  );
  const electronDistRoot = path.dirname(electronExecutable);
  const electronRuntimeBytes = await directoryBytes(electronDistRoot);
  const disk = await statfs("D:\\");
  const availableBytes = disk.bavail * disk.bsize;
  const requiredBytes = winUnpackedBytes + electronRuntimeBytes + resourceBytes + 512 * 1024 * 1024;
  assert.ok(
    availableBytes >= requiredBytes,
    `D: has insufficient free space for isolated Electron path probes (${availableBytes} available, ${requiredBytes} required).`,
  );

  if (pathProbeOnly === undefined) {
    await probeLaunch(
      {
        name: "WIN_UNPACKED",
        executable: path.join(WIN_UNPACKED, "Caelush.exe"),
        cwd: WIN_UNPACKED,
      },
      path.join(DATA_ROOT, "WIN_UNPACKED", "user-data"),
      path.join(DATA_ROOT, "WIN_UNPACKED"),
      manifest.resourceSetDigest,
    );
    await cp(WIN_UNPACKED, PLAIN_COPY, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    });
    await probeLaunch(
      {
        name: "D_ROOT_PLAIN",
        executable: path.join(PLAIN_COPY, "Caelush.exe"),
        cwd: PLAIN_COPY,
      },
      path.join(DATA_ROOT, "D_ROOT_PLAIN", "user-data"),
      path.join(DATA_ROOT, "D_ROOT_PLAIN"),
      manifest.resourceSetDigest,
    );
    await renameOwnedProbeDirectory(PLAIN_COPY, COMPLEX_COPY);
    await probeLaunch(
      {
        name: "D_ROOT_CHINESE_SPACES",
        executable: path.join(COMPLEX_COPY, "Caelush.exe"),
        cwd: COMPLEX_COPY,
      },
      path.join(DATA_ROOT, "D_ROOT_CHINESE_SPACES", "user-data"),
      path.join(DATA_ROOT, "D_ROOT_CHINESE_SPACES"),
      manifest.resourceSetDigest,
    );
  }

  assert.equal(await pathExists(D3_STAGE_ROOT), false);
  await mkdir(D3_STAGE_ROOT, { recursive: false });
  stagedRuntime = await stageElectronRuntime(
    electronDistRoot,
    D3_STAGE_ROOT,
    electronPackage.version,
  );
  const stagedResources = path.join(stagedRuntime.directory, "resources");
  await rm(path.join(stagedResources, "default_app.asar"), { force: true });
  for (const entry of await readdir(packagedResources, { withFileTypes: true })) {
    const source = path.join(packagedResources, entry.name);
    const destination = path.join(stagedResources, entry.name);
    assert.equal(
      await pathExists(destination),
      false,
      "The Electron stage has a conflicting application resource.",
    );
    if (entry.isDirectory()) {
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      });
    } else {
      const metadata = await lstat(source);
      assert.equal(metadata.isFile(), true);
      await cp(source, destination, { errorOnExist: true, force: false });
    }
  }
  const stagedVerification = await verifyDesktopResourceFiles(manifest, stagedResources);
  assert.equal(
    stagedVerification.resourceSetDigest,
    originalResourceVerification.resourceSetDigest,
  );
  const stagedPackagedExecutable = path.join(stagedRuntime.directory, "Caelush.exe");
  await copyFile(path.join(WIN_UNPACKED, "Caelush.exe"), stagedPackagedExecutable);
  assert.equal(
    await hashFile(stagedPackagedExecutable),
    await hashFile(path.join(WIN_UNPACKED, "Caelush.exe")),
  );
  await probeLaunch(
    {
      name: "D3_STAGED_ELECTRON_RUNTIME",
      executable: stagedPackagedExecutable,
      cwd: stagedRuntime.directory,
    },
    path.join(DATA_ROOT, "D3_STAGED_ELECTRON_RUNTIME", "user-data"),
    path.join(DATA_ROOT, "D3_STAGED_ELECTRON_RUNTIME"),
    manifest.resourceSetDigest,
  );
  completed = true;
  process.stdout.write(
    `D6_ELECTRON_PATH_PROBE=PASS RESOURCE_SHA256=${manifest.resourceSetDigest}\n`,
  );
} finally {
  await cleanupStagedRuntime(stagedRuntime);
  if (completed) {
    await removeOwnedPath(PLAIN_COPY, path.parse(PLAIN_COPY).root, path.basename(PLAIN_COPY));
    await removeOwnedPath(COMPLEX_COPY, path.parse(COMPLEX_COPY).root, path.basename(COMPLEX_COPY));
    await removeOwnedPath(PROBE_ROOT, OUTPUT_ROOT, path.basename(PROBE_ROOT));
    await removeOwnedPath(D3_STAGE_ROOT, "D:\\", path.basename(D3_STAGE_ROOT));
  }
}

async function probeLaunch(probeCase, userDataRoot, environmentRoot, expectedResourceDigest) {
  for (const name of ["appdata", "localappdata", "temp", "profile"]) {
    await mkdir(path.join(environmentRoot, name), { recursive: true });
  }
  const port = await reserveTcpPort();
  const child = spawn(
    probeCase.executable,
    [`--user-data-dir=${userDataRoot}`, `--remote-debugging-port=${port}`],
    {
      cwd: probeCase.cwd,
      env: {
        ...process.env,
        APPDATA: path.join(environmentRoot, "appdata"),
        LOCALAPPDATA: path.join(environmentRoot, "localappdata"),
        TEMP: path.join(environmentRoot, "temp"),
        TMP: path.join(environmentRoot, "temp"),
        USERPROFILE: path.join(environmentRoot, "profile"),
        HOME: path.join(environmentRoot, "profile"),
        CAELUSH_D6_DIAGNOSTICS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-64 * 1024);
    });
  }

  try {
    const requiredStages = [
      "MAIN_MODULE",
      "APP_WHEN_READY",
      "MANIFEST_VERIFIED",
      "APP_PROTOCOL_REGISTERED",
      "BROWSER_WINDOW_CREATED",
      "RENDERER_LOAD_FINISHED",
      "ACCOUNT_INITIALIZATION_COMPLETED",
    ];
    await waitFor(
      () =>
        requiredStages.every((stage) =>
          readMainStages(output).some((record) => record.stage === stage),
        ),
      `production Main startup diagnostics (${probeCase.name})`,
      90_000,
    );
    const stages = readMainStages(output);
    for (const stage of requiredStages) {
      assert.ok(
        stages.some((record) => record.stage === stage),
        `Missing ${stage} in ${probeCase.name}.`,
      );
    }
    const target = await waitFor(
      async () => {
        if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode}).`);
        const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
        if (response === null || !response.ok) return null;
        const targets = await response.json().catch(() => null);
        return Array.isArray(targets)
          ? (targets.find(
              (item) =>
                item.type === "page" &&
                item.url === "caelush-login://app/" &&
                String(item.title ?? "").length > 0 &&
                item.webSocketDebuggerUrl,
            ) ?? null)
          : null;
      },
      `loaded Caelush login renderer (${probeCase.name})`,
      30_000,
    );
    const whenReady = stages.find((record) => record.stage === "APP_WHEN_READY");
    assert.equal(normalizePath(whenReady.userDataPath), normalizePath(userDataRoot));
    const manifestStage = stages.find((record) => record.stage === "MANIFEST_VERIFIED");
    assert.ok(manifestStage.verifiedFileCount > 0);
    const mainModuleStage = stages.find((record) => record.stage === "MAIN_MODULE");
    process.stdout.write(
      `D6_ELECTRON_MAIN_MODE=${probeCase.name} PACKAGED=${mainModuleStage.packaged} MAIN=${mainModuleStage.executablePath} RESOURCES=${mainModuleStage.resourcesPath}\n`,
    );
    process.stdout.write(
      `D6_ELECTRON_DEVTOOLS_TARGET=${probeCase.name} ID=${target.id} TYPE=${target.type} URL=${target.url} TITLE=${String(target.title ?? "").slice(0, 120)}\n`,
    );
    const renderer = await inspectRenderer(target.webSocketDebuggerUrl);
    assert.ok(renderer.url.startsWith("caelush-login://app/"));
    assert.ok(renderer.bodyText.length > 0);
    assert.equal(renderer.hasDesktopBridge, true);

    const socket = await openWebSocket(target.webSocketDebuggerUrl);
    try {
      const closeResult = await cdpRequest(socket, "Runtime.evaluate", {
        expression: "window.caelushDesktop.window.close().then(()=>true)",
        returnByValue: true,
        awaitPromise: true,
      });
      assert.equal(closeResult.exceptionDetails, undefined);
    } finally {
      socket.close();
    }
    const exitCode = await waitForExit(child, 45_000);
    assert.equal(exitCode, 0, `Electron exited with ${exitCode} from ${probeCase.name}.`);
    const closeStage = readMainStages(output).find(
      (record) => record.stage === "DAEMON_GRACEFUL_CLOSE_COMPLETED",
    );
    assert.ok(closeStage, `Main did not finish its close path in ${probeCase.name}.`);
    assert.equal(closeStage.daemonExitCode, null);

    const executableSha256 = await hashFile(probeCase.executable);
    assert.match(executableSha256, /^[a-f0-9]{64}$/u);
    assert.equal(expectedResourceDigest, manifest.resourceSetDigest);
    process.stdout.write(
      `D6_ELECTRON_PATH_CASE=${probeCase.name} LAUNCH=${probeCase.executable} CWD=${probeCase.cwd} ELECTRON_EXE_SHA256=${executableSha256} RESOURCE_SHA256=${expectedResourceDigest} MAIN_STAGES=${readMainStages(
        output,
      )
        .map((record) => record.stage)
        .join(",")} EXIT_CODE=${exitCode}\n`,
    );
  } catch (error) {
    if (child.exitCode === null) await terminateProcessTree(child.pid);
    const stages = readMainStages(output);
    const classification = !stages.some((record) => record.stage === "MAIN_MODULE")
      ? "NATIVE_CRASH_BEFORE_MAIN"
      : stages.some((record) => record.stage === "MANIFEST_REJECT")
        ? "MANIFEST_REJECT"
        : stages.some((record) => record.stage === "RENDERER_LOAD_FAILED")
          ? "RENDERER_LOAD_FAILURE"
          : stages.some((record) => record.stage === "RENDERER_LOAD_FINISHED")
            ? "RENDERER_POST_LOAD_INSPECTION_FAILURE"
            : "MAIN_INITIALIZATION_FAILURE";
    process.stderr.write(
      `D6_ELECTRON_PATH_CASE=${probeCase.name} FAILURE_CLASS=${classification} LAUNCH=${probeCase.executable} CWD=${probeCase.cwd} STAGES=${stages.map((record) => record.stage).join(",")}\n`,
    );
    throw new Error(
      `Electron path probe failed (${probeCase.name}): ${safeError(error)}\n${output}`,
      { cause: error },
    );
  }
}

async function inspectRenderer(webSocketUrl) {
  const socket = await openWebSocket(webSocketUrl);
  try {
    await cdpRequest(socket, "Runtime.enable", {}, 30_000);
    await cdpRequest(socket, "Page.enable", {}, 30_000);
    process.stdout.write("D6_ELECTRON_DEVTOOLS_RUNTIME_PAGE_ENABLE=PASS\n");
    const result = await cdpRequest(
      socket,
      "Runtime.evaluate",
      {
        expression:
          "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,bodyText:document.body?.innerText?.slice(0,2000)??'',hasDesktopBridge:typeof window.caelushDesktop==='object'})",
        returnByValue: true,
      },
      30_000,
    );
    assert.equal(result.exceptionDetails, undefined);
    return JSON.parse(result.result.value);
  } finally {
    socket.close();
  }
}

async function renameOwnedProbeDirectory(source, destination) {
  assert.equal(path.resolve(source), PLAIN_COPY);
  assert.equal(path.resolve(destination), COMPLEX_COPY);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const metadata = await lstat(source);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.isDirectory(), true);
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || Date.now() >= deadline)
        throw error;
      process.stdout.write(`D6_ELECTRON_PATH_RENAME_RETRY=${error.code}\n`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function openWebSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DevTools WebSocket open timed out.")), 10_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("DevTools WebSocket failed."));
      },
      { once: true },
    );
  });
  return socket;
}

async function cdpRequest(socket, method, params) {
  const id = ++nextCdpCommandId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(
        new Error(`DevTools command timed out: ${method} (received ${receivedMessages} messages).`),
      );
    }, 10_000);
    let receivedMessages = 0;
    const onMessage = (event) => {
      void readMessage(event.data);
    };
    const readMessage = async (data) => {
      let messageText;
      if (typeof data === "string") messageText = data;
      else if (Buffer.isBuffer(data)) messageText = data.toString("utf8");
      else if (data instanceof ArrayBuffer) messageText = Buffer.from(data).toString("utf8");
      else if (ArrayBuffer.isView(data)) {
        messageText = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
      } else if (data instanceof Blob) messageText = await data.text();
      else messageText = String(data);
      let message;
      try {
        message = JSON.parse(messageText);
      } catch {
        if (receivedMessages < 8) {
          process.stdout.write(
            `D6_ELECTRON_CDP_MESSAGE=${method} DATA_TYPE=${typeof data} PARSE=INVALID\n`,
          );
        }
        return;
      }
      receivedMessages += 1;
      if (receivedMessages <= 8) {
        process.stdout.write(
          `D6_ELECTRON_CDP_MESSAGE=${method} RESPONSE_ID=${message.id ?? "NONE"} ID_TYPE=${typeof message.id} EVENT=${message.method ?? "NONE"} KEYS=${Object.keys(message).sort().join(",")}\n`,
        );
      }
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (message.error !== undefined) reject(new Error(`DevTools rejected ${method}.`));
      else resolve(message.result);
    };
    socket.addEventListener("message", onMessage);
    process.stdout.write(`D6_ELECTRON_CDP_SEND=${method} ID=${id}\n`);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function waitFor(condition, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null && child.stdout?.closed === true && child.stderr?.closed === true) {
    return child.exitCode;
  }
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === null) reject(new Error(`Electron exited from ${signal}.`));
          else resolve(code);
        });
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Electron did not exit.")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupStagedRuntime(runtime) {
  if (runtime === undefined) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await runtime.cleanup();
      return;
    } catch (error) {
      if (!isWindowsBusyError(error) || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function isWindowsBusyError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EBUSY" || error.code === "EPERM")
  );
}

async function reserveTcpPort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function terminateProcessTree(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return;
  const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  try {
    const result = spawnSync(taskkill, ["/PID", String(processId), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.error !== undefined) throw result.error;
  } catch {
    // The process can exit between the timeout and taskkill.
  }
}

async function assertSafeDirectory(directory) {
  const metadata = await lstat(directory);
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const childMetadata = await lstat(entryPath);
    assert.equal(
      childMetadata.isSymbolicLink(),
      false,
      `Reparse point in packaged Electron tree: ${entryPath}`,
    );
    if (childMetadata.isDirectory()) await assertSafeDirectory(entryPath);
    else assert.equal(childMetadata.isFile(), true);
  }
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const metadata = await lstat(target);
    assert.equal(metadata.isSymbolicLink(), false);
    if (metadata.isDirectory()) total += await directoryBytes(target);
    else if (metadata.isFile()) total += metadata.size;
    else throw new Error("Unsupported file in Electron path probe source.");
  }
  return total;
}

async function removeOwnedPath(target, parent, expectedName) {
  assert.equal(
    path.dirname(path.resolve(target)).toLowerCase(),
    path.resolve(parent).toLowerCase(),
  );
  assert.equal(path.basename(target), expectedName);
  await rm(target, { recursive: true, force: true });
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function normalizePath(value) {
  return path.win32
    .resolve(value)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function readMainStages(output) {
  const records = [];
  for (const line of output.split(/\r?\n/u)) {
    const marker = /D6_MAIN_STAGE=(\{.*\})/u.exec(line);
    if (!marker) continue;
    try {
      const value = JSON.parse(marker[1]);
      if (typeof value.stage === "string") records.push(value);
    } catch {
      records.push({ stage: "INVALID_STAGE_RECORD" });
    }
  }
  return records;
}

function safeError(error) {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 1200);
}
