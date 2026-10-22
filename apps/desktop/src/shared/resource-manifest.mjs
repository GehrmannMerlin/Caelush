import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

export const DESKTOP_RESOURCE_MANIFEST_FILENAME = "desktop-resource-manifest.json";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const electronFs =
  process.versions.electron === undefined
    ? undefined
    : createRequire(process.execPath)("original-fs");
const nodeFs = { lstat, readdir, realpath, stat, createReadStream };
const rawFs = electronFs
  ? {
      lstat: electronFs.promises?.lstat ?? promisify(electronFs.lstat),
      readdir: electronFs.promises?.readdir ?? promisify(electronFs.readdir),
      realpath: electronFs.promises?.realpath ?? promisify(electronFs.realpath),
      stat: electronFs.promises?.stat ?? promisify(electronFs.stat),
      createReadStream: electronFs.createReadStream,
    }
  : nodeFs;
const ALLOWED_FILE_TYPES = new Set([
  "ASSET",
  "DATA",
  "DAEMON_CODE",
  "DAEMON_METADATA",
  "EXECUTABLE",
  "NATIVE_ADDON",
  "PACKAGE_METADATA",
  "SANDBOX_RUNNER",
  "WEB_ASSET",
]);

/** Validate the JSON-safe resource identity before it reaches an installer or runtime. */
export function validateDesktopResourceManifest(input) {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "product",
      "productVersion",
      "channel",
      "platform",
      "architecture",
      "electronVersion",
      "daemonVersion",
      "apiVersion",
      "protocolVersion",
      "nodeVersion",
      "nodeExecutableSha256",
      "webAssetDigest",
      "desktopAssetDigest",
      "nativeModules",
      "sandboxRunner",
      "requiredCapabilities",
      "resourceFiles",
      "resourceSetDigest",
    ])
  ) {
    throw invalidManifest();
  }
  if (
    input.schemaVersion !== 1 ||
    input.product !== "Caelush" ||
    !isSemver(input.productVersion) ||
    !["dev", "beta", "stable"].includes(input.channel) ||
    input.platform !== "win32" ||
    input.architecture !== "x64" ||
    !isSemver(input.electronVersion) ||
    !isSemver(input.daemonVersion) ||
    input.apiVersion !== "v1" ||
    input.protocolVersion !== 1 ||
    !/^\d+\.\d+\.\d+$/u.test(input.nodeVersion) ||
    !isHash(input.nodeExecutableSha256) ||
    !isHash(input.webAssetDigest) ||
    !isHash(input.desktopAssetDigest) ||
    !Array.isArray(input.nativeModules) ||
    !isRecord(input.sandboxRunner) ||
    !Array.isArray(input.requiredCapabilities) ||
    !Array.isArray(input.resourceFiles) ||
    !isHash(input.resourceSetDigest)
  ) {
    throw invalidManifest();
  }

  const files = input.resourceFiles.map(validateResourceFile);
  const sortedFiles = [...files].sort(compareResourcePath);
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) => file.path !== sortedFiles[index].path) ||
    computeResourceSetDigest(files) !== input.resourceSetDigest
  ) {
    throw invalidManifest();
  }

  const runner = validateSandboxRunner(input.sandboxRunner);
  const runnerRecord = files.find((file) => file.path === runner.path);
  if (
    runnerRecord === undefined ||
    runnerRecord.sha256 !== runner.sha256 ||
    runnerRecord.fileType !== "SANDBOX_RUNNER"
  ) {
    throw invalidManifest();
  }

  const capabilities = input.requiredCapabilities.map((value) => boundedString(value, 64));
  if (new Set(capabilities).size !== capabilities.length) throw invalidManifest();
  const nativeModules = input.nativeModules.map((module) => validateNativeModule(module, files));
  if (
    new Set(nativeModules.map((module) => module.name)).size !== nativeModules.length ||
    nativeModules.length !== 1 ||
    nativeModules[0].name !== "node-pty" ||
    nativeModules[0].version !== "1.1.0" ||
    nativeModules[0].platform !== "win32" ||
    nativeModules[0].architecture !== "x64"
  ) {
    throw invalidManifest();
  }

  const nodeRecord = files.find((file) => file.path === "daemon/node.exe");
  if (
    nodeRecord === undefined ||
    nodeRecord.fileType !== "EXECUTABLE" ||
    nodeRecord.sha256 !== input.nodeExecutableSha256
  ) {
    throw invalidManifest();
  }
  const webFiles = files.filter((file) => file.path.startsWith("web/desktop/"));
  if (webFiles.length === 0 || computeResourceSetDigest(webFiles) !== input.webAssetDigest) {
    throw invalidManifest();
  }

  return Object.freeze({
    schemaVersion: 1,
    product: "Caelush",
    productVersion: input.productVersion,
    channel: input.channel,
    platform: "win32",
    architecture: "x64",
    electronVersion: input.electronVersion,
    daemonVersion: input.daemonVersion,
    apiVersion: "v1",
    protocolVersion: 1,
    nodeVersion: input.nodeVersion,
    nodeExecutableSha256: input.nodeExecutableSha256,
    webAssetDigest: input.webAssetDigest,
    desktopAssetDigest: input.desktopAssetDigest,
    nativeModules: Object.freeze(nativeModules),
    sandboxRunner: runner,
    requiredCapabilities: Object.freeze(capabilities),
    resourceFiles: Object.freeze(files),
    resourceSetDigest: input.resourceSetDigest,
  });
}

export function assertDesktopResourceManifestCompatible(manifestInput, expected) {
  const manifest = validateDesktopResourceManifest(manifestInput);
  for (const key of [
    "productVersion",
    "channel",
    "platform",
    "architecture",
    "electronVersion",
    "daemonVersion",
    "apiVersion",
    "protocolVersion",
    "nodeVersion",
  ]) {
    if (expected[key] !== undefined && manifest[key] !== expected[key]) {
      const identity = key === "productVersion" ? "VERSION" : key.toUpperCase();
      throw new Error(`DESKTOP_RESOURCE_${identity}_MISMATCH`);
    }
  }
  return manifest;
}

export function computeResourceSetDigest(files) {
  const canonical = [...files]
    .sort(compareResourcePath)
    .map(({ path: resourcePath, size, sha256 }) => ({
      path: resourcePath,
      size,
      sha256,
    }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export async function createDirectoryDigest(directoryPath) {
  const files = await collectDirectoryFiles(directoryPath, {}, nodeFs);
  const records = await Promise.all(
    files.map(async (file) => ({
      path: file.path,
      size: file.size,
      sha256: await hashFile(file.absolutePath, nodeFs),
    })),
  );
  return { digest: computeResourceSetDigest(records), files: records };
}

/** Add the Electron archive after electron-builder has produced the real ASAR. */
export async function addDesktopArchiveResource(manifestInput, archivePath) {
  const manifest = validateDesktopResourceManifest(manifestInput);
  const archiveMetadata = await rawFs.stat(archivePath);
  if (!archiveMetadata.isFile()) throw invalidManifest();
  const resourceFiles = [
    ...manifest.resourceFiles.filter((file) => file.path !== "app.asar"),
    {
      path: "app.asar",
      fileType: "ASSET",
      size: archiveMetadata.size,
      sha256: await hashFile(archivePath, rawFs),
      runtimeIdentity: `Electron ${manifest.electronVersion} application archive`,
    },
  ].sort(compareResourcePath);
  return validateDesktopResourceManifest({
    ...manifest,
    resourceFiles,
    resourceSetDigest: computeResourceSetDigest(resourceFiles),
  });
}

/** Hash every declared file and reject missing, extra, linked, or changed resources. */
export async function verifyDesktopResourceFiles(manifestInput, resourceRoot) {
  const manifest = validateDesktopResourceManifest(manifestInput);
  const actualFiles = await collectDirectoryFiles(
    resourceRoot,
    {
      ignoredRootFiles: new Set([DESKTOP_RESOURCE_MANIFEST_FILENAME]),
    },
    rawFs,
  );
  const expectedByPath = new Map(manifest.resourceFiles.map((file) => [file.path, file]));
  const actualByPath = new Map(actualFiles.map((file) => [file.path, file]));

  for (const expected of manifest.resourceFiles) {
    const actual = actualByPath.get(expected.path);
    if (actual === undefined) {
      throw new Error(`DESKTOP_RESOURCE_FILE_MISSING:${expected.path}`);
    }
    if (
      actual.size !== expected.size ||
      (await hashFile(actual.absolutePath, rawFs)) !== expected.sha256
    ) {
      throw new Error("DESKTOP_RESOURCE_FILE_HASH_MISMATCH");
    }
  }
  if ([...actualByPath.keys()].some((resourcePath) => !expectedByPath.has(resourcePath))) {
    throw new Error("DESKTOP_RESOURCE_FILE_SET_MISMATCH");
  }
  if (computeResourceSetDigest(manifest.resourceFiles) !== manifest.resourceSetDigest) {
    throw new Error("DESKTOP_RESOURCE_MANIFEST_INVALID");
  }
  return Object.freeze({
    verifiedFiles: manifest.resourceFiles.length,
    resourceSetDigest: manifest.resourceSetDigest,
  });
}

export async function verifyDesktopAssetDigest(expectedDigest, desktopAssetRoot) {
  if (!isHash(expectedDigest)) throw new Error("DESKTOP_ASSET_MANIFEST_INVALID");
  const actual = await createDirectoryDigest(desktopAssetRoot);
  if (actual.digest !== expectedDigest) throw new Error("DESKTOP_ASSET_DIGEST_MISMATCH");
  return actual.digest;
}

async function collectDirectoryFiles(rootPath, options = {}, fileSystem = nodeFs) {
  const root = path.resolve(rootPath);
  const rootMetadata = await fileSystem.lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("DESKTOP_RESOURCE_ROOT_UNSAFE");
  }
  const canonicalRoot = await fileSystem.realpath(root);
  if (normalizePath(canonicalRoot) !== normalizePath(root)) {
    throw new Error("DESKTOP_RESOURCE_ROOT_UNSAFE");
  }
  const files = [];

  async function visit(directoryPath, relativeDirectory) {
    const entries = await fileSystem.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relativeDirectory.length === 0 && (options.ignoredRootFiles?.has(entry.name) ?? false)) {
        continue;
      }
      validateResourcePath(relativePath);
      const absolutePath = path.join(directoryPath, entry.name);
      const metadata = await fileSystem.lstat(absolutePath);
      if (metadata.isSymbolicLink()) throw new Error("DESKTOP_RESOURCE_REPARSE_POINT");
      if (metadata.isDirectory()) {
        const canonicalPath = await fileSystem.realpath(absolutePath);
        if (normalizePath(canonicalPath) !== normalizePath(absolutePath)) {
          throw new Error("DESKTOP_RESOURCE_REPARSE_POINT");
        }
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        const canonicalPath = await fileSystem.realpath(absolutePath);
        if (normalizePath(canonicalPath) !== normalizePath(absolutePath)) {
          throw new Error("DESKTOP_RESOURCE_REPARSE_POINT");
        }
        files.push({ path: relativePath, size: metadata.size, absolutePath });
      } else {
        throw new Error("DESKTOP_RESOURCE_FILE_TYPE_INVALID");
      }
    }
  }

  await visit(root, "");
  return files.sort(compareResourcePath);
}

async function hashFile(filePath, fileSystem = nodeFs) {
  const hash = createHash("sha256");
  for await (const chunk of fileSystem.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function validateResourceFile(input) {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["path", "fileType", "size", "sha256", "runtimeIdentity"])
  ) {
    throw invalidManifest();
  }
  const resourcePath = validateResourcePath(input.path);
  if (
    typeof input.fileType !== "string" ||
    !ALLOWED_FILE_TYPES.has(input.fileType) ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    !isHash(input.sha256)
  ) {
    throw invalidManifest();
  }
  return Object.freeze({
    path: resourcePath,
    fileType: input.fileType,
    size: input.size,
    sha256: input.sha256,
    runtimeIdentity: boundedString(input.runtimeIdentity, 256),
  });
}

function validateNativeModule(input, resourceFiles) {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "name",
      "version",
      "platform",
      "architecture",
      "nodeAbi",
      "napiVersion",
      "files",
    ]) ||
    !Array.isArray(input.files)
  ) {
    throw invalidManifest();
  }
  const files = input.files.map((file) => {
    if (!isRecord(file) || !hasExactKeys(file, ["path", "sha256"]) || !isHash(file.sha256)) {
      throw invalidManifest();
    }
    const resourcePath = validateResourcePath(file.path);
    const resource = resourceFiles.find((entry) => entry.path === resourcePath);
    if (
      resource === undefined ||
      resource.sha256 !== file.sha256 ||
      resource.fileType !== "NATIVE_ADDON"
    ) {
      throw invalidManifest();
    }
    return Object.freeze({ path: resourcePath, sha256: file.sha256 });
  });
  if (files.length === 0 || new Set(files.map((file) => file.path)).size !== files.length) {
    throw invalidManifest();
  }
  return Object.freeze({
    name: boundedString(input.name, 128),
    version: isSemver(input.version) ? input.version : invalidManifest(),
    platform: input.platform === "win32" ? "win32" : invalidManifest(),
    architecture: input.architecture === "x64" ? "x64" : invalidManifest(),
    nodeAbi: boundedString(input.nodeAbi, 32),
    napiVersion: boundedString(input.napiVersion, 32),
    files: Object.freeze(files),
  });
}

function validateSandboxRunner(input) {
  if (
    !hasExactKeys(input, [
      "path",
      "controlProtocolVersion",
      "platform",
      "architecture",
      "sha256",
      "providers",
    ]) ||
    input.controlProtocolVersion !== 1 ||
    input.platform !== "windows" ||
    input.architecture !== "x64" ||
    !isHash(input.sha256) ||
    !Array.isArray(input.providers) ||
    input.providers.length !== 1 ||
    input.providers[0] !== "windows-acl-restricted-token"
  ) {
    throw invalidManifest();
  }
  const runnerPath = validateResourcePath(input.path);
  if (!runnerPath.startsWith("sandbox-runner/")) throw invalidManifest();
  return Object.freeze({
    path: runnerPath,
    controlProtocolVersion: 1,
    platform: "windows",
    architecture: "x64",
    sha256: input.sha256,
    providers: Object.freeze(["windows-acl-restricted-token"]),
  });
}

function validateResourcePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    /[<>|?*]/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f)
  ) {
    throw invalidManifest();
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment !== segment.trim() ||
        segment.endsWith(".") ||
        !/^[A-Za-z0-9@._ -]+$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
    )
  ) {
    throw invalidManifest();
  }
  return value;
}

function boundedString(value, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalidManifest();
  }
  return value;
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isSemver(value) {
  return typeof value === "string" && SEMVER_PATTERN.test(value);
}

function compareResourcePath(left, right) {
  return compareText(left.path, right.path);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value) {
  return path
    .resolve(value)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

function invalidManifest() {
  return new Error("DESKTOP_RESOURCE_MANIFEST_INVALID");
}
