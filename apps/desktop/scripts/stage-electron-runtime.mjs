import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

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

export async function stageElectronRuntime(sourceDist, tempRoot = tmpdir(), expectedVersion) {
  const sourceRoot = path.resolve(sourceDist);
  const tempDirectory = path.resolve(tempRoot);
  const sourceVersion = (await readFile(path.join(sourceRoot, "version"), "utf8")).trim();
  if (!sourceVersion || (expectedVersion !== undefined && sourceVersion !== expectedVersion)) {
    throw new Error("The installed Electron runtime version does not match its package version.");
  }

  const sourceFiles = await collectRuntimeFiles(sourceRoot);
  const relativeFiles = new Set(sourceFiles.map((file) => file.relativePath));
  for (const requiredPath of REQUIRED_RUNTIME_FILES) {
    if (!relativeFiles.has(requiredPath)) {
      throw new Error("The installed Electron runtime is missing a required Windows resource.");
    }
  }

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

export async function prepareElectronRuntime() {
  const require = createRequire(import.meta.url);
  const installedExecutable = require("electron");
  if (process.platform !== "win32" || process.arch !== "x64") {
    return Object.freeze({ executablePath: installedExecutable, async cleanup() {} });
  }

  const packagePath = require.resolve("electron/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  return stageElectronRuntime(path.dirname(installedExecutable), tmpdir(), packageJson.version);
}

async function collectRuntimeFiles(root) {
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
  if (files.length === 0) throw new Error("The installed Electron runtime is empty.");
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
