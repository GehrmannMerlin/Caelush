import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startInternalCloudFixture } from "./windows-d6-fixtures.mjs";
import {
  assertDesktopResourceManifestCompatible,
  computeResourceSetDigest,
  createDirectoryDigest,
  validateDesktopResourceManifest,
  verifyDesktopResourceFiles,
  verifyDesktopAssetDigest,
} from "../src/shared/resource-manifest.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(APP_ROOT, "..", "..");
const RUN_ID = `${process.pid}-${randomUUID()}`;
const DESKTOP_OUTPUT = path.resolve(
  process.env.CAELUSH_DESKTOP_OUTPUT_ROOT ?? path.join("D:\\", `Caelush D6 Recovery ${RUN_ID}`),
);
const RESOURCE_STAGE = path.resolve(
  process.env.CAELUSH_DESKTOP_RESOURCE_STAGE_ROOT ?? path.join(DESKTOP_OUTPUT, "resources"),
);
const NODE_RUNTIME_SHA256 = "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de";
const EXPECTED_NODE_VERSION = "24.18.0";
const EXPECTED_PTY_VERSION = "1.1.0";
const INTERNAL_TEST_IDENTITY_PATH = path.join(DESKTOP_OUTPUT, ".d6-internal-test-identity.json");
const BUILD_IDENTITY_SEED_PATH = path.join(DESKTOP_OUTPUT, ".d6-build-input-identity.json");
const REQUIRED_CAPABILITIES = [
  "approvals",
  "cancellation",
  "desktopHostAuthV1",
  "desktopLocalProxyV1",
  "desktopProfileBindingV1",
  "runExecution",
  "runRecovery",
  "sessionTranscript",
  "sseReplay",
];

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("D6 Windows packaging requires Windows x64.");
}

const outputRoot = path.parse(DESKTOP_OUTPUT).root;
if (outputRoot.toLowerCase() !== path.parse(REPOSITORY_ROOT).root.toLowerCase()) {
  throw new Error("D6 installer output must stay on the repository drive.");
}

const mode = process.argv.includes("--dir") ? "dir" : "nsis";
if (path.parse(DESKTOP_OUTPUT).root.toLowerCase() !== "d:\\") {
  throw new Error("D6 installer and build inputs must stay on D:.");
}
if (isPathInside(DESKTOP_OUTPUT, REPOSITORY_ROOT)) {
  throw new Error("D6 build inputs and outputs must stay outside the LOW-integrity source tree.");
}
if (await pathExists(DESKTOP_OUTPUT)) {
  throw new Error(`D6 output path already exists; choose a new D: path: ${DESKTOP_OUTPUT}`);
}
await mkdir(DESKTOP_OUTPUT, { recursive: false });
await assertNoLowIntegrityLabel(DESKTOP_OUTPUT);
process.env.CAELUSH_DESKTOP_OUTPUT_ROOT = DESKTOP_OUTPUT;
process.env.CAELUSH_DESKTOP_RESOURCE_STAGE_ROOT = RESOURCE_STAGE;
const internalTestIdentity = await prepareInternalTestIdentity();
const cloudFixture = await startInternalCloudFixture(internalTestIdentity);
try {
  if (process.env.CAELUSH_DESKTOP_REUSE_RESOURCES_FROM === undefined) {
    await buildDependencies();
    await buildDesktopWeb();
    await typecheckDesktop();
    await buildElectronMain();
    await buildElectronRenderer();
    await stageVerifiedResources();
  } else {
    await typecheckDesktop();
    await buildElectronMain();
    await reuseVerifiedResources(process.env.CAELUSH_DESKTOP_REUSE_RESOURCES_FROM);
  }
  await verifyRunnerDiscoveryAndTransport();
  await verifyPackagedNodePty();
  const stagedIdentity = await createBuildIdentitySeed(mode);
  await runElectronBuilder(mode);
  const buildIdentitySeed = await finalizeBuildIdentitySeed(stagedIdentity);
  await writeFile(
    BUILD_IDENTITY_SEED_PATH,
    `${JSON.stringify(buildIdentitySeed, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`D6_PACKAGE_MODE=${mode.toUpperCase()}\n`);
  process.stdout.write(`D6_BUILD_ROOT_D_DRIVE=${DESKTOP_OUTPUT}\n`);
  process.stdout.write(`D6_RESOURCE_ROOT_D_DRIVE=${RESOURCE_STAGE}\n`);
  if (mode === "nsis") {
    const installerPath = path.join(DESKTOP_OUTPUT, "Caelush-0.1.0-dev-win-x64-Setup.exe");
    await runNode(path.join(APP_ROOT, "scripts", "windows-d6-electron-path-probe.mjs"), {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        CAELUSH_DESKTOP_OUTPUT_ROOT: DESKTOP_OUTPUT,
      },
    });
    const smokeScript = path.join(APP_ROOT, "scripts", "windows-d6-smoke.mjs");
    await runNode(smokeScript, {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        CAELUSH_DESKTOP_OUTPUT_ROOT: DESKTOP_OUTPUT,
        CAELUSH_DESKTOP_RESOURCE_STAGE_ROOT: RESOURCE_STAGE,
        CAELUSH_D6_INSTALLER_PATH: installerPath,
        CAELUSH_D6_CLOUD_FIXTURE_PARENT: "1",
      },
    });
  }
} finally {
  await cloudFixture.close();
}

async function prepareInternalTestIdentity() {
  const cloudPort = await reserveLoopbackPort();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = `d6_test_${randomUUID()}`;
  const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const privateKeyPath = path.join(DESKTOP_OUTPUT, `.d6-internal-test-private-${keyId}.pem`);
  assertExactChild(privateKeyPath, DESKTOP_OUTPUT, path.basename(privateKeyPath));
  const identity = Object.freeze({
    keyId,
    publicKey: rawPublicKey.toString("base64url"),
    privateKeyPath,
    cloudPort,
  });
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(INTERNAL_TEST_IDENTITY_PATH, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return identity;
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("D6_INTERNAL_TEST_CLOUD_PORT_UNAVAILABLE");
  }
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function createBuildIdentitySeed(buildMode) {
  const baseGitSha = gitOutput(["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/u.test(baseGitSha)) throw new Error("D6_BASE_GIT_SHA_INVALID");
  const trackedDiff = gitOutput(["diff", "--binary", "HEAD"]);
  const untrackedPaths = gitOutput(["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/\\/gu, "/"))
    .filter(
      (entry) =>
        !/(^|\/)(node_modules|dist|target|\.stage|\.build-resources|release-artifacts)(\/|$)/u.test(
          entry,
        ),
    )
    .sort(compareText);
  const untrackedDigestLines = [];
  for (const relativePath of untrackedPaths) {
    const absolutePath = path.resolve(REPOSITORY_ROOT, relativePath);
    await assertFileInsideWorkspace(absolutePath, REPOSITORY_ROOT);
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    untrackedDigestLines.push(`${relativePath}\0${metadata.size}\0${await hashFile(absolutePath)}`);
  }
  const dirtyBuildInputDigest = createHash("sha256")
    .update(trackedDiff)
    .update("\0UNTRACKED\0")
    .update(untrackedDigestLines.join("\n"))
    .digest("hex");
  const electronBuilderConfigDigest = await hashFile(
    path.join(APP_ROOT, "electron-builder.config.cjs"),
  );
  const desktopPackage = JSON.parse(await readFile(path.join(APP_ROOT, "package.json"), "utf8"));
  const resourceManifest = JSON.parse(
    await readFile(path.join(RESOURCE_STAGE, "desktop-resource-manifest.json"), "utf8"),
  );
  return Object.freeze({
    schemaVersion: 1,
    baseGitSha,
    dirtyBuildInputDigest,
    electronBuilderConfigDigest,
    productVersion: desktopPackage.version,
    buildMode: `internal-test-${buildMode}`,
    resourceSetSha256: null,
    stagedResourceSetSha256: resourceManifest.resourceSetDigest,
    installRoot: null,
  });
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`D6_BUILD_IDENTITY_GIT_FAILED:${args[0]}`);
  }
  return result.stdout;
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

function isPathInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function assertNoLowIntegrityLabel(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("D6_OUTPUT_DIRECTORY_INVALID");
  }
  const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  const result = spawnSync(icacls, [directory, "/L"], {
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("D6_OUTPUT_ACL_QUERY_FAILED");
  }
  if (/Mandatory Label\\Low Mandatory Level:[^\r\n]*\(NW\)/iu.test(result.stdout)) {
    throw new Error("D6_OUTPUT_HAS_LOW_INTEGRITY_NO_WRITE_LABEL");
  }
}

async function buildDependencies() {
  await runPnpm(["--filter", "@caelush/daemon...", "run", "build"]);
}

async function buildDesktopWeb() {
  await runPnpm(["--filter", "@caelush/web", "run", "build:desktop"]);
}

async function typecheckDesktop() {
  await runPnpm(["--filter", "@caelush/desktop", "run", "typecheck"]);
}

async function buildElectronMain() {
  await runNode(path.join(APP_ROOT, "scripts", "build-main.mjs"), {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      CAELUSH_DESKTOP_CHANNEL: "dev",
      CAELUSH_DESKTOP_BUILD_PURPOSE: "internal-test",
      CAELUSH_CLOUD_ORIGIN: `http://127.0.0.1:${internalTestIdentity.cloudPort}`,
      CAELUSH_CLOUD_ALLOWED_HOSTS: "127.0.0.1",
      CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: JSON.stringify({
        [internalTestIdentity.keyId]: internalTestIdentity.publicKey,
      }),
    },
  });
}

async function buildElectronRenderer() {
  await runPnpm(["--filter", "@caelush/desktop", "exec", "vite", "build"]);
}

async function stageVerifiedResources() {
  assertExactChild(RESOURCE_STAGE, DESKTOP_OUTPUT, "resources");
  await mkdir(RESOURCE_STAGE, { recursive: true });
  await assertNoLowIntegrityLabel(RESOURCE_STAGE);

  const daemonResources = path.join(RESOURCE_STAGE, "daemon");
  const daemonPackage = path.join(daemonResources, "runtime");
  const webRoot = path.join(RESOURCE_STAGE, "web", "desktop");
  const sandboxRoot = path.join(RESOURCE_STAGE, "sandbox-runner");
  const nodeSource = path.join(APP_ROOT, ".stage", "daemon", "node.exe");
  const helperSource = path.join(APP_ROOT, ".stage", "daemon", "user-terminal-helper.mjs");
  const ptySource = path.join(APP_ROOT, ".stage", "daemon", "node_modules", "node-pty");
  const webSource = path.join(REPOSITORY_ROOT, "apps", "web", "dist", "desktop");
  const runnerSource = path.join(REPOSITORY_ROOT, "release-artifacts", "sandbox");

  await mkdir(path.dirname(daemonPackage), { recursive: true });
  await runPnpm([
    "--filter",
    "@caelush/daemon",
    "deploy",
    "--prod",
    "--legacy",
    "--config.node-linker=hoisted",
    daemonPackage,
  ]);
  const virtualStore = path.join(daemonPackage, "node_modules", ".pnpm");
  assertExactChild(virtualStore, path.join(daemonPackage, "node_modules"), ".pnpm");
  await rm(virtualStore, { recursive: true, force: true });
  await removeGitkeepMarkers(RESOURCE_STAGE);
  await mkdir(daemonResources, { recursive: true });
  await mkdir(path.join(daemonResources, "node_modules"), { recursive: true });
  await copyFile(nodeSource, path.join(daemonResources, "node.exe"));
  await copyFile(helperSource, path.join(daemonResources, "user-terminal-helper.mjs"));
  await cp(ptySource, path.join(daemonResources, "node_modules", "node-pty"), {
    recursive: true,
    dereference: true,
    force: true,
  });
  await cp(webSource, webRoot, { recursive: true, dereference: true });
  await mkdir(sandboxRoot, { recursive: true });
  await copyFile(
    path.join(runnerSource, "caelush-sandbox-runner.exe"),
    path.join(sandboxRoot, "caelush-sandbox-runner.exe"),
  );
  await copyFile(path.join(runnerSource, "manifest.json"), path.join(sandboxRoot, "manifest.json"));

  await assertFileInsideWorkspace(nodeSource, APP_ROOT);
  const nodeDigest = await hashFile(nodeSource);
  assert.equal(nodeDigest, NODE_RUNTIME_SHA256, "The cached Node runtime hash changed.");
  const nodeIdentity = inspectRuntime(path.join(daemonResources, "node.exe"));
  assert.deepEqual(nodeIdentity, {
    version: EXPECTED_NODE_VERSION,
    modules: "137",
    napi: "10",
    platform: "win32",
    arch: "x64",
  });

  const ptyMetadata = JSON.parse(
    await readFile(path.join(daemonResources, "node_modules", "node-pty", "package.json"), "utf8"),
  );
  assert.equal(ptyMetadata.name, "node-pty");
  assert.equal(ptyMetadata.version, EXPECTED_PTY_VERSION);

  const daemonMetadata = JSON.parse(
    await readFile(path.join(daemonPackage, "package.json"), "utf8"),
  );
  const desktopMetadata = JSON.parse(await readFile(path.join(APP_ROOT, "package.json"), "utf8"));
  const electronMetadata = await readElectronMetadata();
  const nativeFiles = [];
  const resourceFiles = await collectStagedResources(RESOURCE_STAGE);
  for (const file of resourceFiles) {
    if (file.path.startsWith("daemon/node_modules/node-pty/") && file.path.endsWith(".node")) {
      nativeFiles.push({ path: file.path, sha256: file.sha256 });
    }
  }
  assert.ok(nativeFiles.length > 0, "The node-pty ConPTY native addon is missing.");
  const runnerPath = path.join(RESOURCE_STAGE, "sandbox-runner", "caelush-sandbox-runner.exe");
  const runnerMetadata = JSON.parse(
    await readFile(path.join(sandboxRoot, "manifest.json"), "utf8"),
  );
  await verifySandboxRunnerPackage(runnerPath, runnerMetadata);
  assertPeX64(runnerPath);

  const runnerRecord = resourceFiles.find(
    (file) => file.path === "sandbox-runner/caelush-sandbox-runner.exe",
  );
  assert.ok(runnerRecord);
  const webFiles = resourceFiles.filter((file) => file.path.startsWith("web/desktop/"));
  const desktopDigest = await createDirectoryDigest(path.join(APP_ROOT, "dist", "renderer"));
  const manifest = validateDesktopResourceManifest({
    schemaVersion: 1,
    product: "Caelush",
    productVersion: desktopMetadata.version,
    channel: "dev",
    platform: "win32",
    architecture: "x64",
    electronVersion: electronMetadata.version,
    daemonVersion: daemonMetadata.version,
    apiVersion: "v1",
    protocolVersion: 1,
    nodeVersion: EXPECTED_NODE_VERSION,
    nodeExecutableSha256: nodeDigest,
    webAssetDigest: computeResourceSetDigest(webFiles),
    desktopAssetDigest: desktopDigest.digest,
    nativeModules: [
      {
        name: "node-pty",
        version: EXPECTED_PTY_VERSION,
        platform: "win32",
        architecture: "x64",
        nodeAbi: nodeIdentity.modules,
        napiVersion: nodeIdentity.napi,
        files: nativeFiles,
      },
    ],
    sandboxRunner: {
      path: "sandbox-runner/caelush-sandbox-runner.exe",
      controlProtocolVersion: runnerMetadata.controlProtocolVersion,
      platform: "windows",
      architecture: "x64",
      sha256: runnerMetadata.sha256,
      providers: runnerMetadata.providers,
    },
    requiredCapabilities: REQUIRED_CAPABILITIES,
    resourceFiles,
    resourceSetDigest: computeResourceSetDigest(resourceFiles),
  });
  await writeFile(
    path.join(RESOURCE_STAGE, "desktop-resource-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await verifyDesktopResourceFiles(manifest, RESOURCE_STAGE);
  process.stdout.write(
    `D6_RESOURCES_STAGED=${resourceFiles.length} NODE=${nodeIdentity.version} PTY=${ptyMetadata.version} DAEMON=${daemonMetadata.version} RUNNER_SHA256=${runnerRecord.sha256}\n`,
  );
}

/** An explicit Main-only recovery build can reuse an already verified external runtime stage. */
async function reuseVerifiedResources(sourceDirectory) {
  const source = path.resolve(sourceDirectory);
  assert.equal(path.parse(source).root.toLowerCase(), "d:\\");
  assert.equal(isPathInside(source, REPOSITORY_ROOT), false);
  assert.equal(isPathInside(source, DESKTOP_OUTPUT), false);
  await assertNoLowIntegrityLabel(source);
  assertExactChild(RESOURCE_STAGE, DESKTOP_OUTPUT, "resources");
  const desktopPackage = JSON.parse(await readFile(path.join(APP_ROOT, "package.json"), "utf8"));
  const electronPackage = await readElectronMetadata();
  const manifest = assertDesktopResourceManifestCompatible(
    JSON.parse(await readFile(path.join(source, "desktop-resource-manifest.json"), "utf8")),
    {
      productVersion: desktopPackage.version,
      daemonVersion: desktopPackage.version,
      channel: "dev",
      electronVersion: electronPackage.version,
      nodeVersion: EXPECTED_NODE_VERSION,
      nodeExecutableSha256: NODE_RUNTIME_SHA256,
    },
  );
  assert.equal(
    manifest.resourceFiles.some((file) => file.path === "app.asar"),
    false,
    "Only the external runtime stage can be reused; Main must be packaged again.",
  );
  await verifyDesktopResourceFiles(manifest, source);
  await verifyDesktopAssetDigest(
    manifest.desktopAssetDigest,
    path.join(APP_ROOT, "dist", "renderer"),
  );
  await cp(source, RESOURCE_STAGE, { recursive: true, force: false, errorOnExist: true });
  await verifyDesktopResourceFiles(manifest, RESOURCE_STAGE);
  process.stdout.write(`D6_MAIN_ONLY_RESOURCE_STAGE_REUSED=${manifest.resourceSetDigest}\n`);
}

async function verifyRunnerDiscoveryAndTransport() {
  const daemonPackage = path.join(RESOURCE_STAGE, "daemon", "runtime");
  const daemonHost = path.join(daemonPackage, "dist", "sandbox-runner-host.js");
  const daemon = await import(pathToFileURL(daemonHost).href);
  const resolved = await daemon.resolveSandboxRunnerArtifact({
    environment: {},
    daemonEntryPath: path.join(daemonPackage, "dist", "desktop-entry.js"),
    platform: "win32",
    arch: "x64",
  });
  assert.equal(resolved.available, true, "The packaged Daemon could not resolve its Runner.");
  if (!resolved.available) throw new Error("D6_SANDBOX_RUNNER_UNAVAILABLE");
  await runNode(path.join(APP_ROOT, "scripts", "windows-d6-runner-probe.mjs"), {
    cwd: APP_ROOT,
    env: process.env,
    args: [resolved.artifact.runnerPath],
  });
  await assertRunnerTamperRejected(resolved.artifact.runnerPath);
  process.stdout.write(
    "D6_SANDBOX_RUNNER_DISCOVERY_TRANSPORT_ERROR_RESTRICTED_EXECUTION_TAMPER=PASS\n",
  );
}

async function verifyPackagedNodePty() {
  const nodePath = path.join(RESOURCE_STAGE, "daemon", "node.exe");
  const probe = [
    'const pty=require("node-pty");',
    'const child=pty.spawn("powershell.exe",["-NoLogo","-NoProfile","-Command","Write-Output D6_NODE_PTY_LOAD_PASS"],{name:"xterm",cols:80,rows:24,cwd:process.cwd(),env:process.env});',
    'let output="";',
    'child.on("data",data=>{output+=data});',
    'child.on("exit",code=>process.exit(code===0&&output.includes("D6_NODE_PTY_LOAD_PASS")?0:1));',
  ].join("");
  const result = spawnSync(nodePath, ["-e", probe], {
    cwd: path.join(RESOURCE_STAGE, "daemon"),
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`The staged node-pty ConPTY module could not execute (${result.status}).`);
  }
  process.stdout.write("D6_NODE_PTY_CONPTY_LOAD=PASS\n");
}

async function runElectronBuilder(buildMode) {
  await mkdir(DESKTOP_OUTPUT, { recursive: true });
  const builderTempRoot = path.join(DESKTOP_OUTPUT, ".nsis-temp");
  await mkdir(builderTempRoot, { recursive: true });
  const args = ["--config", "electron-builder.config.cjs", "--win"];
  if (buildMode === "nsis") args.push("nsis");
  args.push("--x64");
  if (buildMode === "dir") args.push("--dir");
  await runNode(path.join(APP_ROOT, "node_modules", "electron-builder", "cli.js"), {
    cwd: APP_ROOT,
    args,
    env: {
      ...process.env,
      TEMP: builderTempRoot,
      TMP: builderTempRoot,
    },
  });
}

async function finalizeBuildIdentitySeed(seed) {
  const packagedResources = path.join(DESKTOP_OUTPUT, "win-unpacked", "resources");
  await assertNoLowIntegrityLabel(packagedResources);
  const manifest = validateDesktopResourceManifest(
    JSON.parse(
      await readFile(path.join(packagedResources, "desktop-resource-manifest.json"), "utf8"),
    ),
  );
  const verification = await verifyDesktopResourceFiles(manifest, packagedResources);
  assert.equal(verification.resourceSetDigest, manifest.resourceSetDigest);
  return Object.freeze({
    ...seed,
    resourceSetSha256: verification.resourceSetDigest,
    packagedResourceFileCount: verification.verifiedFiles,
  });
}

async function collectStagedResources(root) {
  const canonicalRoot = await realpath(root);
  const files = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertSafeRelativePath(relativePath);
      const filePath = path.join(directory, entry.name);
      const metadata = await lstat(filePath);
      assert.equal(metadata.isSymbolicLink(), false, `A reparse point was staged: ${relativePath}`);
      const canonicalPath = await realpath(filePath);
      assertPathInside(canonicalPath, canonicalRoot);
      if (metadata.isDirectory()) await visit(filePath, relativePath);
      else if (metadata.isFile()) {
        files.push({
          path: relativePath,
          fileType: fileTypeFor(relativePath),
          size: metadata.size,
          sha256: await hashFile(filePath),
          runtimeIdentity: runtimeIdentityFor(relativePath),
        });
      } else {
        throw new Error(`Unsupported staged resource type: ${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return files.sort((left, right) => compareText(left.path, right.path));
}

async function removeGitkeepMarkers(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    const metadata = await lstat(filePath);
    assert.equal(metadata.isSymbolicLink(), false, "A reparse point was staged.");
    if (metadata.isDirectory()) {
      await removeGitkeepMarkers(filePath);
    } else if (entry.name === ".gitkeep") {
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.size, 0, "A non-empty .gitkeep resource is unexpected.");
      await rm(filePath);
    }
  }
}

function fileTypeFor(resourcePath) {
  if (resourcePath === "daemon/node.exe") return "EXECUTABLE";
  if (resourcePath.endsWith(".node")) return "NATIVE_ADDON";
  if (resourcePath === "sandbox-runner/caelush-sandbox-runner.exe") return "SANDBOX_RUNNER";
  if (resourcePath.startsWith("web/desktop/")) return "WEB_ASSET";
  if (resourcePath.endsWith("package.json")) return "PACKAGE_METADATA";
  if (/\.(?:js|mjs|cjs)$/u.test(resourcePath)) return "DAEMON_CODE";
  if (resourcePath.startsWith("sandbox-runner/")) return "DAEMON_METADATA";
  return "DATA";
}

function runtimeIdentityFor(resourcePath) {
  if (resourcePath === "daemon/node.exe") return "Node.js 24.18.0 win32-x64; modules=137; N-API=10";
  if (resourcePath.endsWith(".node")) return "node-pty 1.1.0 win32-x64 N-API native addon";
  if (resourcePath === "sandbox-runner/caelush-sandbox-runner.exe") {
    return "Caelush Windows x64 Sandbox Runner; control protocol v1";
  }
  if (resourcePath === "sandbox-runner/manifest.json") {
    return "Caelush Windows x64 Sandbox Runner sidecar manifest";
  }
  if (resourcePath === "daemon/user-terminal-helper.mjs")
    return "Caelush USER_TERMINAL Node helper";
  if (resourcePath.startsWith("web/desktop/")) return "Caelush desktop Web asset";
  if (resourcePath.endsWith("package.json")) return "Production Node package metadata";
  if (resourcePath.startsWith("daemon/runtime/")) {
    return "Caelush production Daemon 0.1.0 module";
  }
  return "Caelush Daemon production dependency closure";
}

async function verifySandboxRunnerPackage(runnerPath, manifest) {
  const { verifySandboxRunnerPackage: verify } = await import(
    pathToFileURL(path.join(REPOSITORY_ROOT, "scripts", "build-sandbox-runner.mjs")).href
  );
  await verify({ runnerPath, manifest });
}

async function assertRunnerTamperRejected(runnerPath) {
  const scratchRoot = path.join(DESKTOP_OUTPUT, `.d6-runner-tamper-${process.pid}`);
  assertExactChild(scratchRoot, DESKTOP_OUTPUT, path.basename(scratchRoot));
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(scratchRoot, { recursive: true });
  const copyPath = path.join(scratchRoot, "caelush-sandbox-runner.exe");
  const manifestPath = path.join(RESOURCE_STAGE, "sandbox-runner", "manifest.json");
  try {
    await copyFile(runnerPath, copyPath);
    const bytes = await readFile(copyPath);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(copyPath, bytes);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await assert.rejects(verifySandboxRunnerPackage(copyPath, manifest));
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

function inspectRuntime(nodePath) {
  const result = spawnSync(
    nodePath,
    [
      "-p",
      "JSON.stringify({version:process.versions.node,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch})",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("The cached Node runtime could not execute.");
  }
  const identity = JSON.parse(result.stdout.trim());
  return {
    version: identity.version,
    modules: String(identity.modules),
    napi: String(identity.napi),
    platform: identity.platform,
    arch: identity.arch,
  };
}

async function readElectronMetadata() {
  const require = createRequire(import.meta.url);
  const electronPackagePath = require.resolve("electron/package.json");
  return JSON.parse(await readFile(electronPackagePath, "utf8"));
}

function assertPeX64(executablePath) {
  const bytes = requireBuffer(executablePath);
  assert.equal(bytes.toString("ascii", 0, 2), "MZ");
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString("ascii", peOffset, peOffset + 4), "PE\0\0");
  assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664, "Windows PE is not x64.");
}

function requireBuffer(filePath) {
  return readFileSync(filePath);
}

async function hashFile(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function assertSafeRelativePath(resourcePath) {
  assert.equal(resourcePath.startsWith("/"), false);
  assert.equal(resourcePath.includes("\\"), false);
  assert.equal(resourcePath.includes(":"), false);
  assert.ok(
    resourcePath
      .split("/")
      .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  );
}

function assertPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error("Staged resource resolved outside its controlled build root.");
}

function assertExactChild(target, parent, expectedName) {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  if (
    path.dirname(resolvedTarget).toLowerCase() !== resolvedParent.toLowerCase() ||
    path.basename(resolvedTarget) !== expectedName
  ) {
    throw new Error("Refusing to mutate an unexpected D6 build path.");
  }
}

async function assertFileInsideWorkspace(filePath, root) {
  const metadata = await stat(filePath);
  assert.equal(metadata.isFile(), true);
  const resolved = await realpath(filePath);
  assertPathInside(resolved, await realpath(root));
}

async function runPnpm(args) {
  const pnpmCli = process.env.npm_execpath;
  const pnpmArguments = ["--config.verify-deps-before-run=warn", ...args];
  const result = pnpmCli
    ? spawnSync(process.execPath, [pnpmCli, ...pnpmArguments], {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
      })
    : spawnSync("pnpm.cmd", pnpmArguments, {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
        shell: true,
      });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed (${result.status}).`);
}

async function runNode(scriptPath, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...(options.args ?? [])], {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: options.env ?? process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(`${path.basename(scriptPath)} failed (${result.status}).`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
