import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { stageElectronRuntime } from "./stage-electron-runtime.mjs";
import { createLocalUpdateIdentity } from "./local-update-fixture.mjs";
import {
  verifyDesktopResourceFiles,
  computeResourceSetDigest,
  createDirectoryDigest,
} from "../src/shared/resource-manifest.mjs";

assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
const repository = path.resolve(import.meta.dirname, "../../..");
const appRoot = path.join(repository, "apps", "desktop");
const root = path.resolve(process.env.CAELUSH_D72_BUILD_ROOT ?? `D:\\Caelush D7-2 ${Date.now()}`);
assert.equal(path.parse(root).root.toLowerCase(), "d:\\");
assert.ok(!root.toLowerCase().startsWith(repository.toLowerCase() + path.sep));
await mkdir(root, { recursive: false });
const require = createRequire(import.meta.url);
const electronStage = await stageElectronRuntime(path.dirname(require("electron")), root, "44.7.0");
// The Electron demo application is not part of Caelush's declared resource inventory.
const demoArchive = path.join(electronStage.directory, "resources", "default_app.asar");
assert.equal(path.dirname(demoArchive), path.join(electronStage.directory, "resources"));
await rm(demoArchive);
const source = path.resolve(
  process.env.CAELUSH_D72_D6_RESOURCES ?? "D:\\Caelush D6 Final 20261011-05\\resources",
);
const original = JSON.parse(
  await readFile(path.join(source, "desktop-resource-manifest.json"), "utf8"),
);
await verifyDesktopResourceFiles(original, source);
assert.equal(original.productVersion, "0.1.0");
const updateIdentity = await createLocalUpdateIdentity(path.join(root, "identity"));
const offline = generateKeyPairSync("ed25519");
const cloudPort = await reservePort();
const offlinePath = path.join(root, "offline-test-private.pem");
await writeFile(offlinePath, offline.privateKey.export({ format: "pem", type: "pkcs8" }), {
  flag: "wx",
  mode: 0o600,
});
const accountIdentity = {
  keyId: `d6_test_${randomUUID()}`,
  publicKey: offline.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64url"),
  privateKeyPath: offlinePath,
  cloudPort,
};
const env = {
  ...process.env,
  NODE_ENV: "production",
  CAELUSH_DESKTOP_BUILD_PURPOSE: "internal-test",
  CAELUSH_DESKTOP_CHANNEL: "dev",
  CAELUSH_CLOUD_ORIGIN: `http://127.0.0.1:${cloudPort}`,
  CAELUSH_CLOUD_ALLOWED_HOSTS: "127.0.0.1",
  CAELUSH_OFFLINE_TRUSTED_KEYS_JSON: JSON.stringify({
    [accountIdentity.keyId]: accountIdentity.publicKey,
  }),
  CAELUSH_UPDATE_TRUSTED_KEYS_JSON: JSON.stringify({
    [updateIdentity.keyId]: updateIdentity.rawPublicKey,
  }),
  CAELUSH_UPDATE_RELEASE_HOSTS: "localhost",
  CAELUSH_UPDATE_TEST_CA_PEM: updateIdentity.ca,
};
await run(
  path.join(repository, "node_modules", "typescript", "bin", "tsc"),
  ["-p", "tsconfig.main.json", "--noEmit"],
  appRoot,
  env,
);
await run(
  path.join(repository, "node_modules", "typescript", "bin", "tsc"),
  ["-p", "tsconfig.renderer.json", "--noEmit"],
  appRoot,
  env,
);
await run(path.join(appRoot, "scripts", "build-main.mjs"), [], appRoot, env);
await run(path.join(appRoot, "node_modules", "vite", "bin", "vite.js"), ["build"], appRoot, env);
await run(
  path.join(repository, "apps", "web", "node_modules", "vite", "bin", "vite.js"),
  ["build", "--mode", "desktop"],
  path.join(repository, "apps", "web"),
  env,
);
for (const version of ["0.1.0", "0.1.1"]) {
  const output = path.join(root, version);
  const stage = path.join(output, "resources");
  await mkdir(output);
  await cp(source, stage, { recursive: true, errorOnExist: true, force: false });
  const web = path.join(stage, "web", "desktop");
  assert.equal(path.dirname(web), path.join(stage, "web"));
  await rm(web, { recursive: true, force: true });
  await cp(path.join(repository, "apps", "web", "dist", "desktop"), web, { recursive: true });
  const daemonPackage = path.join(stage, "daemon", "runtime", "package.json");
  const daemon = JSON.parse(await readFile(daemonPackage, "utf8"));
  daemon.version = version;
  await writeFile(daemonPackage, JSON.stringify(daemon, null, 2) + "\n");
  const manifest = JSON.parse(JSON.stringify(original));
  manifest.productVersion = version;
  manifest.daemonVersion = version;
  manifest.desktopAssetDigest = (
    await createDirectoryDigest(path.join(appRoot, "dist", "renderer"))
  ).digest;
  manifest.resourceFiles = manifest.resourceFiles.filter(
    (file) => !file.path.startsWith("web/desktop/"),
  );
  for (const file of manifest.resourceFiles)
    if (file.path === "daemon/runtime/package.json") {
      file.size = (await stat(daemonPackage)).size;
      file.sha256 = await hash(daemonPackage);
    }
  for (const file of (await createDirectoryDigest(web)).files)
    manifest.resourceFiles.push({
      path: `web/desktop/${file.path}`,
      fileType: "WEB_ASSET",
      size: file.size,
      sha256: file.sha256,
      runtimeIdentity: `Caelush desktop Web asset ${version}`,
    });
  manifest.resourceFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  manifest.webAssetDigest = computeResourceSetDigest(
    manifest.resourceFiles.filter((file) => file.path.startsWith("web/desktop/")),
  );
  manifest.resourceSetDigest = computeResourceSetDigest(manifest.resourceFiles);
  await writeFile(
    path.join(stage, "desktop-resource-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await verifyDesktopResourceFiles(manifest, stage);
  const temp = path.join(output, ".nsis-temp");
  await mkdir(temp);
  await writeFile(
    path.join(output, ".d6-internal-test-identity.json"),
    JSON.stringify(accountIdentity),
  );
  await writeFile(
    path.join(output, ".d6-build-input-identity.json"),
    JSON.stringify({
      schemaVersion: 1,
      productVersion: version,
      buildMode: "internal-test-nsis",
      updateKeyId: updateIdentity.keyId,
    }),
  );
  await run(
    path.join(appRoot, "node_modules", "electron-builder", "cli.js"),
    [
      "--config",
      "electron-builder.config.cjs",
      "--win",
      "nsis",
      "--x64",
      `-c.extraMetadata.version=${version}`,
      `-c.electronDist=${electronStage.directory}`,
    ],
    appRoot,
    {
      ...env,
      CAELUSH_DESKTOP_OUTPUT_ROOT: output,
      CAELUSH_DESKTOP_RESOURCE_STAGE_ROOT: stage,
      TEMP: temp,
      TMP: temp,
    },
  );
  const packaged = path.join(output, "win-unpacked", "resources");
  const complete = JSON.parse(
    await readFile(path.join(packaged, "desktop-resource-manifest.json"), "utf8"),
  );
  await verifyDesktopResourceFiles(complete, packaged);
  assert.equal(complete.productVersion, version);
  const seedPath = path.join(output, ".d6-build-input-identity.json");
  const seed = JSON.parse(await readFile(seedPath, "utf8"));
  await writeFile(
    seedPath,
    JSON.stringify(
      {
        ...seed,
        resourceSetSha256: complete.resourceSetDigest,
        packagedResourceFileCount: complete.resourceFiles.length,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `D72_BUILT_VERSION=${version} RESOURCE_DIGEST=${complete.resourceSetDigest}\n`,
  );
}
await writeFile(
  path.join(root, "smoke-input.json"),
  JSON.stringify(
    {
      updateIdentity,
      accountIdentity,
      versionA: path.join(root, "0.1.0"),
      versionBInstaller: path.join(root, "0.1.1", "Caelush-0.1.1-dev-win-x64-Setup.exe"),
    },
    null,
    2,
  ),
);
process.stdout.write(`D72_BUILD_ROOT=${root}\n`);
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
async function run(script, args, cwd, environment) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, `${path.basename(script)} failed`);
}
async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}
