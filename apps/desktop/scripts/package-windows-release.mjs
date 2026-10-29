import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertDesktopReleaseOutputRootSafe,
  loadDesktopReleaseConfiguration,
} from "./desktop-release-config.mjs";
import {
  verifyDesktopResourceFiles,
  validateDesktopResourceManifest,
} from "../src/shared/resource-manifest.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(APP_ROOT, "..", "..");
const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export function parseReleaseArguments(args) {
  if (args.length === 0) throw new Error("RELEASE_CONFIG_PATH_REQUIRED");
  if (args.length !== 2 || args[0] !== "--config" || args[1].trim().length === 0) {
    throw new Error("RELEASE_ARGUMENTS_INVALID");
  }
  return path.resolve(args[1]);
}

export function waitForChildClose(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export async function runWindowsReleasePackage(configPath) {
  const releaseConfiguration = await loadDesktopReleaseConfiguration(configPath, process.env);
  assertSupportedBuildHost();
  assertToolchainVersions();
  assertCleanSourceCheckout();
  await assertProductVersionMirrors();

  const rootManifest = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  const desktopManifest = JSON.parse(await readFile(path.join(APP_ROOT, "package.json"), "utf8"));
  if (rootManifest.version !== "1.0.0" || desktopManifest.version !== rootManifest.version) {
    throw new Error("RELEASE_PRODUCT_VERSION_MUST_BE_1_0_0");
  }

  await assertDesktopReleaseOutputRootSafe(releaseConfiguration.outputRoot);
  await mkdir(releaseConfiguration.outputRoot, { recursive: true });
  await assertDesktopReleaseOutputRootSafe(releaseConfiguration.outputRoot);

  const versionRoot = path.join(releaseConfiguration.outputRoot, rootManifest.version);
  await assertDesktopReleaseOutputRootSafe(versionRoot);
  await mkdir(versionRoot, { recursive: true });
  await assertDesktopReleaseOutputRootSafe(versionRoot);

  const sourceCommit = gitOutput(["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error("RELEASE_SOURCE_COMMIT_INVALID");
  const buildId = `${sourceCommit.slice(0, 12)}-${new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z")}-${randomUUID().slice(0, 8)}`;
  const buildRoot = path.join(versionRoot, buildId);
  try {
    await lstat(buildRoot);
    throw new Error("RELEASE_BUILD_ROOT_ALREADY_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(buildRoot, { recursive: false });
  const workRoot = path.join(buildRoot, "work");
  const resourceRoot = path.join(workRoot, "resources");
  const tempRoot = path.join(workRoot, "temp");
  const publishRoot = path.join(buildRoot, "publish");
  const evidenceRoot = path.join(buildRoot, "evidence");
  await Promise.all([
    mkdir(publishRoot),
    mkdir(evidenceRoot),
    mkdir(tempRoot, { recursive: true }),
  ]);

  const buildEnvironment = {
    ...releaseConfiguration.environment,
    CAELUSH_DESKTOP_OUTPUT_ROOT: workRoot,
    CAELUSH_DESKTOP_RESOURCE_STAGE_ROOT: resourceRoot,
    CARGO_TARGET_DIR: path.join(workRoot, "cargo-target"),
    TEMP: tempRoot,
    TMP: tempRoot,
  };
  const buildLogPath = path.join(evidenceRoot, "build.log");
  await runPackagingPipeline(buildEnvironment, buildLogPath);

  const packedResources = path.join(workRoot, "win-unpacked", "resources");
  const resourceManifestPath = path.join(packedResources, "desktop-resource-manifest.json");
  const resourceManifestBytes = await readFile(resourceManifestPath);
  const resourceManifest = validateDesktopResourceManifest(JSON.parse(resourceManifestBytes));
  const resourceVerification = await verifyDesktopResourceFiles(resourceManifest, packedResources);
  assert.equal(resourceManifest.productVersion, rootManifest.version);
  assert.equal(resourceManifest.channel, "stable");
  assert.equal(resourceManifest.platform, "win32");
  assert.equal(resourceManifest.architecture, "x64");

  const buildLog = await readFile(buildLogPath, "utf8");
  assert.ok(
    buildLog.includes(
      "D6_SANDBOX_RUNNER_DISCOVERY_TRANSPORT_ERROR_RESTRICTED_EXECUTION_TAMPER=PASS",
    ),
  );
  assert.ok(buildLog.includes("D6_NODE_PTY_CONPTY_LOAD=PASS"));

  const builtInstallerPath = path.join(
    workRoot,
    `Caelush-${rootManifest.version}-win-x64-Setup.exe`,
  );
  const installerMetadata = await stat(builtInstallerPath);
  if (!installerMetadata.isFile() || installerMetadata.size < 5 * 1024 * 1024) {
    throw new Error("RELEASE_INSTALLER_MISSING_OR_INVALID");
  }
  const publishedInstallerPath = path.join(publishRoot, "Caelush-Setup.exe");
  await copyFile(builtInstallerPath, publishedInstallerPath, constants.COPYFILE_EXCL);
  const publishedInstallerMetadata = await stat(publishedInstallerPath);
  const installerSha512 = await hashFile(publishedInstallerPath, "sha512");
  assert.equal(publishedInstallerMetadata.size, installerMetadata.size);
  await writeFile(
    path.join(publishRoot, "SHA512SUMS.txt"),
    `${installerSha512}  Caelush-Setup.exe\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    path.join(publishRoot, "release-notes.txt"),
    `Caelush ${rootManifest.version}\nWindows 64-bit installer\nFirst public stable release\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const buildInfo = {
    schemaVersion: 1,
    product: "Caelush",
    productVersion: rootManifest.version,
    channel: "stable",
    purpose: "production",
    platform: "win32",
    architecture: "x64",
    sourceCommit,
    buildId,
    builtAt: new Date().toISOString(),
    toolchain: {
      node: process.version,
      pnpm: "11.21.0",
      electron: resourceManifest.electronVersion,
      electronBuilder: "26.17.0",
      daemonNode: resourceManifest.nodeVersion,
    },
    distributionTrustProfile: "PRIVATE_UNSIGNED",
    configurationFingerprint: releaseConfiguration.configurationFingerprint,
    offlineGrantKeyIds: Object.keys(
      JSON.parse(buildEnvironment.CAELUSH_OFFLINE_TRUSTED_KEYS_JSON),
    ).sort(),
    updateKeyIds: Object.keys(JSON.parse(buildEnvironment.CAELUSH_UPDATE_TRUSTED_KEYS_JSON)).sort(),
    resourceManifestSha256: createHash("sha256").update(resourceManifestBytes).digest("hex"),
    resourceSetSha256: resourceVerification.resourceSetDigest,
    resourceFileCount: resourceVerification.verifiedFiles,
    installer: {
      filename: "Caelush-Setup.exe",
      sizeBytes: publishedInstallerMetadata.size,
      sha512: installerSha512,
    },
  };
  await writeFile(
    path.join(evidenceRoot, "build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  await writeFile(
    path.join(evidenceRoot, "verification-report.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        productionStableBuild: "PASS",
        packedResourceManifest: "PASS",
        sandboxRunnerProbe: "PASS",
        packagedNodePtyProbe: "PASS",
        sourceMapsIncluded: false,
        installerSmokeOnCleanVm: "NOT_RUN",
        installerSigning: "PRIVATE_UNSIGNED",
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  process.stdout.write(`RELEASE_BUILD_ROOT=${buildRoot}\n`);
  process.stdout.write(`RELEASE_INSTALLER=${publishedInstallerPath}\n`);
  process.stdout.write(`RELEASE_INSTALLER_BYTES=${publishedInstallerMetadata.size}\n`);
  process.stdout.write(`RELEASE_INSTALLER_SHA512=${installerSha512}\n`);
}

function assertSupportedBuildHost() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("RELEASE_WINDOWS_X64_HOST_REQUIRED");
  }
}

function assertToolchainVersions() {
  if (process.version !== "v24.18.0") throw new Error("RELEASE_NODE_24_18_REQUIRED");
  const pnpmCli = process.env.npm_execpath;
  const result = pnpmCli
    ? spawnSync(process.execPath, [pnpmCli, "--version"], { encoding: "utf8", windowsHide: true })
    : spawnSync("pnpm.cmd", ["--version"], {
        encoding: "utf8",
        windowsHide: true,
        shell: true,
      });
  if (result.error !== undefined || result.status !== 0 || result.stdout.trim() !== "11.21.0") {
    throw new Error("RELEASE_PNPM_11_21_REQUIRED");
  }
}

function assertCleanSourceCheckout() {
  if (gitOutput(["status", "--short", "--untracked-files=all"]).trim().length > 0) {
    throw new Error("RELEASE_SOURCE_CHECKOUT_MUST_BE_CLEAN");
  }
}

async function assertProductVersionMirrors() {
  const result = spawnSync(
    process.execPath,
    [path.join(REPOSITORY_ROOT, "scripts", "check-product-version.mjs")],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("RELEASE_PRODUCT_VERSION_MIRRORS_INVALID");
  }
}

async function runPackagingPipeline(environment, logPath) {
  const log = createWriteStream(logPath, { flags: "wx" });
  const child = spawn(
    process.execPath,
    [path.join(APP_ROOT, "scripts", "package-windows.mjs"), "--production-release"],
    {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (chunk) => {
    log.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    log.write(chunk);
    process.stderr.write(chunk);
  });
  try {
    const result = await waitForChildClose(child);
    if (result.code !== 0) {
      throw new Error(`RELEASE_PIPELINE_FAILED:${String(result.code ?? result.signal)}`);
    }
  } finally {
    log.end();
    await finished(log);
  }
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0)
    throw new Error("RELEASE_GIT_CHECK_FAILED");
  return result.stdout;
}

async function hashFile(filePath, algorithm) {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

if (isDirectExecution) {
  try {
    const configPath = parseReleaseArguments(process.argv.slice(2));
    await runWindowsReleasePackage(configPath);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "RELEASE_PACKAGING_FAILED"}\n`,
    );
    process.exitCode = 1;
  }
}
