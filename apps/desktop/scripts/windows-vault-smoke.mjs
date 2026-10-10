import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
  throw new Error("The Windows DPAPI smoke test requires Windows x64.");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDirectory, "..");
const require = createRequire(import.meta.url);
const installedExecutable = require("electron");
const electronPackage = JSON.parse(
  await readFile(require.resolve("electron/package.json"), "utf8"),
);
const testRoot = await mkdtemp(path.join(tmpdir(), "caelush-dpapi-smoke-"));
const runtimeRoot = path.join(testRoot, "runtime");
const harnessRoot = path.join(testRoot, "harness");
const userDataRoot = path.join(testRoot, "user-data");
let runtime;

try {
  await Promise.all([mkdir(runtimeRoot), mkdir(harnessRoot), mkdir(userDataRoot)]);
  const vaultBundlePath = path.join(harnessRoot, "vault.cjs");
  await build({
    absWorkingDir: appRoot,
    entryPoints: ["src/main/credentials/vault.ts"],
    outfile: vaultBundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
  });

  await writeFile(
    path.join(harnessRoot, "package.json"),
    JSON.stringify({ name: "caelush-dpapi-smoke", version: "0.1.0", main: "main.cjs" }),
  );
  await writeFile(path.join(harnessRoot, "main.cjs"), electronHarnessSource());

  runtime = await stageElectronRuntime(
    path.dirname(installedExecutable),
    runtimeRoot,
    electronPackage.version,
  );
  assert.match(runtime.executableSha256, /^[a-f0-9]{64}$/);

  await runHarness("write");
  const writeMarker = await readFile(path.join(testRoot, "write.marker"), "utf8");
  assert.match(writeMarker, /DPAPI_SMOKE_WRITE=PASS/);
  assert.match(writeMarker, /VAULT_INITIALIZED/);
  await runHarness("restore");
  const restoreMarker = await readFile(path.join(testRoot, "restore.marker"), "utf8");
  assert.match(restoreMarker, /DPAPI_SMOKE_RESTART_RESTORE=PASS/);
  assert.match(restoreMarker, /DPAPI_SMOKE_LOGOUT_CLEAR=PASS/);

  const vaultPath = lineValue(restoreMarker, "VAULT_PATH");
  assertInside(testRoot, vaultPath);
  await writeFile(vaultPath, Buffer.from("deliberately-corrupted-d3-test-vault", "utf8"));
  await runHarness("corrupt");
  const corruptMarker = await readFile(path.join(testRoot, "corrupt.marker"), "utf8");
  assert.match(corruptMarker, /DPAPI_SMOKE_CORRUPTION_FAIL_CLOSED=PASS/);

  process.stdout.write(
    `Windows Electron DPAPI smoke passed (Electron ${electronPackage.version}, ${runtime.fileCount} runtime files, SHA-256 ${runtime.executableSha256}).\n`,
  );
} finally {
  await runtime?.cleanup();
  await rm(testRoot, { recursive: true, force: true });
}

async function runHarness(mode) {
  const child = spawn(runtime.executablePath, [`--user-data-dir=${userDataRoot}`, harnessRoot], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      CAELUSH_VAULT_SMOKE_MODE: mode,
      CAELUSH_VAULT_SMOKE_MARKER: path.join(testRoot, `${mode}.marker`),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [code, signal] = await once(child, "close");
    if (code !== 0) {
      const marker = await readFile(path.join(testRoot, `${mode}.marker`), "utf8").catch(() => "");
      throw new Error(
        `Electron DPAPI ${mode} stage failed (${code ?? signal}).\n${marker}${output}`,
      );
    }
    return output;
  } finally {
    clearTimeout(timeout);
  }
}

function lineValue(output, key) {
  const match = new RegExp(`^${key}=(.+)$`, "m").exec(output);
  assert.ok(match, `Electron harness did not report ${key}.`);
  return match[1];
}

function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  assert.ok(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "The Electron harness reported a vault path outside its temporary test directory.",
  );
}

function electronHarnessSource() {
  return `
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const { appendFileSync } = require("node:fs");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const { DpapiVault, VaultUnavailableError } = require("./vault.cjs");

const mode = process.env.CAELUSH_VAULT_SMOKE_MODE;
const markerPath = process.env.CAELUSH_VAULT_SMOKE_MARKER;
const mark = (stage) => appendFileSync(markerPath, stage + "\\n", "utf8");
mark("MAIN_ENTERED");

app.whenReady().then(async () => {
  mark("APP_READY");
  const vaultPath = path.join(app.getPath("userData"), "credentials.dpapi");
  mark("VAULT_PATH=" + vaultPath);
  const vault = new DpapiVault(vaultPath, {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptStringAsync: (value) => safeStorage.encryptStringAsync(value),
    decryptStringAsync: async (value) => (await safeStorage.decryptStringAsync(Buffer.from(value))).result,
  }, process.platform);
  try {
    if (mode === "corrupt") {
      await assert.rejects(vault.initialize(), VaultUnavailableError);
      mark("DPAPI_SMOKE_CORRUPTION_FAIL_CLOSED=PASS");
    } else {
      mark("VAULT_INITIALIZING");
      await vault.initialize();
      mark("VAULT_INITIALIZED");
      const accountKey = "a".repeat(64);
      const activeKey = "0".repeat(64);
      if (mode === "write") {
        const privateKey = generateKeyPairSync("ed25519").privateKey
          .export({ format: "der", type: "pkcs8" }).toString("base64");
        const record = {
          normalizedEmail: "d3-dpapi-smoke@example.invalid",
          userId: "11111111-1111-4111-8111-111111111111",
          deviceId: "22222222-2222-4222-8222-222222222222",
          refreshToken: "D3-FAKE-REFRESH-TOKEN-DO-NOT-USE-" + "R".repeat(48),
          devicePrivateKeyPkcs8Base64: privateKey,
          offlineGrant: { envelopeVersion: 1, payload: { grantId: "D3-FAKE-OFFLINE-GRANT" }, signature: "test-only" },
          lastTrustedServerTime: "2026-10-10T12:00:00Z",
          lastAcceptedTime: "2026-10-10T12:01:00Z",
        };
        await vault.set(accountKey, record);
        mark("ACCOUNT_RECORD_WRITTEN");
        await vault.set(activeKey, { accountKey });
        assert.deepEqual(await vault.get(accountKey), record);
        const ciphertext = await readFile(vaultPath);
        for (const secret of [record.refreshToken, privateKey, "D3-FAKE-OFFLINE-GRANT"]) {
          assert.equal(ciphertext.includes(Buffer.from(secret, "utf8")), false);
        }
        mark("DPAPI_SMOKE_WRITE=PASS");
      } else if (mode === "restore") {
        const record = await vault.get(accountKey);
        assert.ok(record && typeof record === "object");
        assert.equal(record.refreshToken, "D3-FAKE-REFRESH-TOKEN-DO-NOT-USE-" + "R".repeat(48));
        assert.match(record.devicePrivateKeyPkcs8Base64, /^[A-Za-z0-9+/]+=*$/);
        assert.deepEqual(record.offlineGrant, {
          envelopeVersion: 1,
          payload: { grantId: "D3-FAKE-OFFLINE-GRANT" },
          signature: "test-only",
        });
        assert.deepEqual(await vault.get(activeKey), { accountKey });
        mark("DPAPI_SMOKE_RESTART_RESTORE=PASS");
        await vault.delete(accountKey);
        await vault.delete(activeKey);
        assert.equal(await vault.get(accountKey), null);
        assert.equal(await vault.get(activeKey), null);
        mark("DPAPI_SMOKE_LOGOUT_CLEAR=PASS");
      } else {
        throw new Error("Unknown isolated DPAPI smoke mode.");
      }
      mark("MODE_COMPLETE");
    }
    process.exitCode = 0;
  } catch (error) {
    mark("MODE_FAILED=" + (error instanceof VaultUnavailableError ? "VAULT_UNAVAILABLE" : "ASSERTION"));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}).catch(() => {
  mark("APP_READY_FAILED");
  process.exitCode = 1;
  app.quit();
});
`;
}
