import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertOwnedOutputPath } from "./owned-output-path.mjs";

const REQUIRED_RUNTIME_FILES = [
  "electron.exe",
  "icudtl.dat",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "version",
  path.join("resources", "default_app.asar"),
  path.join("locales", "en-US.pak"),
];
const MAX_RUNTIME_FILES = 512;
const MAX_RUNTIME_BYTES = 1024 * 1024 * 1024;
const DEFAULT_STAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".stage",
  "electron-runtime",
);

export async function stageElectronRuntime(sourceDist, tempRoot = tmpdir(), expectedVersion) {
  const sourceRoot = path.resolve(sourceDist);
  const tempDirectory = path.resolve(tempRoot);
  const sourceVersion = (await readFile(path.join(sourceRoot, "version"), "utf8")).trim();
  if (!sourceVersion || (expectedVersion !== undefined && sourceVersion !== expectedVersion)) {
    throw new Error("The installed Electron runtime version does not match its package version.");
  }

  const sourceFiles = await collectRuntimeFiles(sourceRoot);
  assertRequiredResources(sourceFiles);

  const stageDirectory = await mkdtemp(path.join(tempDirectory, "caelush-electron-runtime-"));
  const runtimeDirectory = path.join(stageDirectory, "electron");
  try {
    for (const file of sourceFiles) {
      const destinationPath = path.resolve(runtimeDirectory, file.relativePath);
      assertInside(runtimeDirectory, destinationPath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(file.sourcePath, destinationPath);
      const stagedHash = await sha256(destinationPath);
      if (stagedHash !== file.sha256) {
        throw new Error("The staged Electron runtime failed its integrity check.");
      }
    }
  } catch (error) {
    await removeOwnedStage(tempDirectory, stageDirectory);
    throw error;
  }

  let cleaned = false;
  return Object.freeze({
    directory: runtimeDirectory,
    executablePath: path.join(runtimeDirectory, "electron.exe"),
    version: sourceVersion,
    fileCount: sourceFiles.length,
    bytesCopied: sourceFiles.reduce((sum, file) => sum + file.bytes, 0),
    executableSha256: sourceFiles.find((file) => file.relativePath === "electron.exe").sha256,
    async cleanup() {
      if (cleaned) return;
      await removeOwnedStage(tempDirectory, stageDirectory);
      cleaned = true;
    },
  });
}

export async function prepareElectronRuntime({ tempRoot = DEFAULT_STAGE_ROOT } = {}) {
  const require = createRequire(import.meta.url);
  const installedExecutable = require("electron");
  if (process.platform !== "win32" || process.arch !== "x64") {
    return Object.freeze({ executablePath: installedExecutable, async cleanup() {} });
  }

  const packagePath = require.resolve("electron/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  await mkdir(tempRoot, { recursive: true });
  return cacheElectronRuntime(path.dirname(installedExecutable), tempRoot, packageJson.version);
}

/** Keep a single verified development runtime; smoke-test staging remains disposable. */
export async function cacheElectronRuntime(sourceDist, cacheRoot, expectedVersion) {
  const source = await realpath(sourceDist);
  const root = path.resolve(cacheRoot);
  for (const [parent, child] of [
    [source, root],
    [root, source],
  ]) {
    const relative = path.relative(parent, child);
    if (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ) {
      throw new Error("The Electron cache must not overlap its source runtime.");
    }
  }
  const current = await assertOwnedOutputPath(root, path.join(root, "current"));
  const preparing = await assertOwnedOutputPath(root, path.join(root, "preparing"));
  await mkdir(root, { recursive: true });
  const unlock = await lockCache(root);
  try {
    const version = (await readFile(path.join(source, "version"), "utf8")).trim();
    if (!version || (expectedVersion !== undefined && version !== expectedVersion)) {
      throw new Error("The installed Electron runtime version does not match its package version.");
    }
    const sourceFiles = await collectRuntimeFiles(source);
    assertRequiredResources(sourceFiles);
    const runtime = path.join(current, "electron");
    let cachedFiles;
    try {
      cachedFiles = await collectRuntimeFiles(runtime, true);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (cachedFiles !== undefined && sameRuntime(sourceFiles, cachedFiles)) {
      await rm(preparing, { recursive: true, force: true });
      return cachedRuntimeDescriptor(runtime, version, sourceFiles, true);
    }

    await rm(preparing, { recursive: true, force: true });
    await mkdir(preparing);
    const staged = await stageElectronRuntime(source, preparing, expectedVersion);
    try {
      // Windows may refuse replacement while Electron is using these files.
      // Close Desktop before retrying a runtime upgrade or repair.
      await rm(current, { recursive: true, force: true });
      await mkdir(current);
      await rename(staged.directory, runtime);
    } finally {
      await staged.cleanup();
      await rm(preparing, { recursive: true, force: true });
    }
    return cachedRuntimeDescriptor(runtime, version, sourceFiles, false);
  } finally {
    await unlock();
  }
}

function assertRequiredResources(files) {
  const relativeFiles = new Set(files.map((file) => file.relativePath));
  for (const requiredPath of REQUIRED_RUNTIME_FILES) {
    if (!relativeFiles.has(requiredPath)) {
      throw new Error("The installed Electron runtime is missing a required Windows resource.");
    }
  }
}

function sameRuntime(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.relativePath === right[index].relativePath && file.sha256 === right[index].sha256,
    )
  );
}

function cachedRuntimeDescriptor(directory, version, files, reused) {
  return Object.freeze({
    directory,
    executablePath: path.join(directory, "electron.exe"),
    version,
    reused,
    fileCount: files.length,
    bytesCopied: reused ? 0 : files.reduce((sum, file) => sum + file.bytes, 0),
    executableSha256: files.find((file) => file.relativePath === "electron.exe")?.sha256,
    async cleanup() {},
  });
}

async function lockCache(root) {
  const lock = await assertOwnedOutputPath(root, path.join(root, "prepare.lock"));
  let handle;
  try {
    handle = await open(lock, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = Number((await readFile(lock, "utf8")).trim());
    if (!Number.isSafeInteger(owner) || owner <= 0) {
      throw new Error(
        "Electron cache preparation was interrupted; close Desktop and run clean:dev.",
        { cause: error },
      );
    }
    try {
      process.kill(owner, 0);
    } catch (ownerError) {
      if (ownerError.code !== "ESRCH") throw ownerError;
      await rm(lock);
      return lockCache(root);
    }
    throw new Error(
      "Another Desktop process is preparing the Electron cache; retry after it finishes.",
      { cause: error },
    );
  }
  await handle.writeFile(String(process.pid));
  await handle.close();
  return async () => rm(lock, { force: true });
}

async function collectRuntimeFiles(root, allowEmpty = false) {
  const files = [];
  let totalBytes = 0;

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const sourcePath = path.join(directory, entry.name);
      const metadata = await lstat(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw new Error("The installed Electron runtime contains an unsupported symbolic link.");
      }
      if (entry.isDirectory()) {
        await visit(sourcePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("The installed Electron runtime contains an unsupported file type.");
      }
      totalBytes += metadata.size;
      if (files.length >= MAX_RUNTIME_FILES || totalBytes > MAX_RUNTIME_BYTES) {
        throw new Error("The installed Electron runtime exceeds the staging bounds.");
      }
      files.push({
        relativePath,
        sourcePath,
        bytes: metadata.size,
        sha256: await sha256(sourcePath),
      });
    }
  }

  await visit(root, "");
  if (files.length === 0 && !allowEmpty)
    throw new Error("The installed Electron runtime is empty.");
  return files;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The staged Electron resource path escaped its runtime directory.");
  }
}

async function removeOwnedStage(tempRoot, stageRoot) {
  const relative = path.relative(path.resolve(tempRoot), path.resolve(stageRoot));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !path.basename(stageRoot).startsWith("caelush-electron-runtime-")
  ) {
    throw new Error("Refusing to remove a path outside the owned Electron staging directory.");
  }
  await rm(stageRoot, { recursive: true, force: true });
}
