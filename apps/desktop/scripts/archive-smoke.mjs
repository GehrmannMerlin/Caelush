import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { stageElectronRuntime } from "./stage-electron-runtime.mjs";
import { _electron, expect } from "@playwright/test";
import {
  createSmokeRoot,
  removeSmokeRoot,
  createProjects,
  inventory,
  exerciseArchivePage,
} from "../../../scripts/archive-smoke-fixture.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  process.stdout.write("ARCHIVE_DESKTOP_SMOKE=SKIPPED (requires Windows x64)\n");
  process.exit(0);
}
const argv = process.argv.slice(2);
const requested = argv[argv.indexOf("--artifacts") + 1];
assert.ok(requested && path.isAbsolute(requested), "--artifacts must be absolute");
const artifacts = path.resolve(requested);
await mkdir(artifacts, { recursive: true });
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await createSmokeRoot();
const harness = path.join(root, "harness");
const require = createRequire(import.meta.url);
let application;
let runtime;
let passed = false;
try {
  await mkdir(harness);
  const projects = await createProjects(root);
  const beforeFiles = await inventory(projects);
  await writeFile(path.join(root, "projects.json"), JSON.stringify(projects));
  await build({
    absWorkingDir: desktopRoot,
    entryPoints: ["test/archive/archive-smoke-main.ts"],
    outfile: path.join(harness, "main.cjs"),
    bundle: true,
    treeShaking: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron", "@playwright/test"],
    define: {
      __CAELUSH_BUILD_CONFIG__: JSON.stringify(
        JSON.stringify({
          production: false,
          purpose: "internal-test",
          channel: "dev",
          cloudOrigin: "http://127.0.0.1:8000",
          offlinePublicKeys: {},
          externalHttpsHosts: [],
        }),
      ),
    },
  });
  await writeFile(
    path.join(harness, "package.json"),
    JSON.stringify({ name: "caelush-archive-fixture", version: "0.1.0", main: "main.cjs" }),
  );
  runtime = await stageElectronRuntime(path.dirname(require("electron")), root);
  const errors = [];
  async function launch(phase) {
    const env = {
      ...process.env,
      CAELUSH_ARCHIVE_TEST_ROOT: root,
      CAELUSH_ARCHIVE_APP_ROOT: desktopRoot,
      CAELUSH_ARCHIVE_PHASE: phase,
      LOCALAPPDATA: path.join(root, "local-app-data"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const instance = await _electron.launch({
      executablePath: runtime.executablePath,
      args: [harness],
      env,
      timeout: 90_000,
    });
    instance.process().stderr.on("data", (chunk) => {
      const text = String(chunk);
      if (text.includes("ARCHIVE_MAIN_FAIL")) process.stderr.write(text);
    });
    const page = await instance.firstWindow({ timeout: 90_000 });
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => errors.push(error.message));
    return { instance, page };
  }
  let launched = await launch("first");
  application = launched.instance;
  let page = launched.page;
  assert.ok(page.url().startsWith("caelush-login://app/"));
  await page.getByRole("button", { name: "已归档", exact: true }).click();
  await expect(page.locator(".archive-row").first()).toBeVisible();
  async function screenshot(name) {
    const encoded = await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      // Wake the hidden compositor before capturing the frame after the DOM assertions.
      await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
      return (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true }))
        .toPNG()
        .toString("base64");
    });
    await writeFile(path.join(artifacts, name), Buffer.from(encoded, "base64"));
  }
  await screenshot("archive-initial.png");
  const interactions = await exerciseArchivePage(page, artifacts, true, screenshot);
  await application.evaluate(() => globalThis.archiveSmoke.verifyWorkspaceReRegistration());
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(800, 760),
  );
  await screenshot("archive-narrow.png");
  assert.equal(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth,
    ),
    true,
  );
  const proxyStatus = await page.evaluate(async () => {
    try {
      return (await globalThis.fetch("caelush-app://app/api/v1/archives/sessions")).status;
    } catch {
      return "blocked";
    }
  });
  assert.notEqual(proxyStatus, 200, "Login renderer never receives generic daemon proxy access");
  const evidence = await application.evaluate(() => globalThis.archiveSmoke.evidence());
  await application.evaluate(() => globalThis.archiveSmoke.saveRestartState());
  await application.evaluate(() => globalThis.archiveSmoke.shutdown());
  await application.close();
  application = undefined;
  launched = await launch("restart");
  application = launched.instance;
  page = launched.page;
  await expect(page.getByRole("heading", { name: "已归档", exact: true })).toBeVisible();
  await expect(page.locator(".archive-row")).toHaveCount(1);
  await screenshot("archive-after-restart.png");
  assert.deepEqual(await application.evaluate(() => globalThis.archiveSmoke.evidence()), evidence);
  const manifest = JSON.parse(await readFile(path.join(root, "archive-fixture.json"), "utf8"));
  assert.ok(Object.values(evidence.alpha).every((count) => count === 0));
  assert.equal(evidence.targetSession, 0);
  assert.equal(evidence.bulkSessions, 0);
  assert.equal(evidence.purgedWorkspaceSessions, 0);
  assert.equal(evidence.purgedWorkspaceArchive, 0);
  assert.deepEqual(evidence.retained, manifest.beforeDatabase.retained);
  assert.deepEqual(evidence.foreignKeyCheck, []);
  await application.evaluate(() => globalThis.archiveSmoke.shutdown());
  await application.close();
  application = undefined;
  assert.deepEqual(await inventory(projects), beforeFiles);
  assert.deepEqual(errors, []);
  const html = await readFile(path.join(desktopRoot, "dist/renderer/index.html"), "utf8");
  const asset = html.match(/src="([^"]+\.js)"/u)?.[1];
  assert.ok(asset);
  const rendererSha256 = createHash("sha256")
    .update(await readFile(path.join(desktopRoot, "dist/renderer", asset)))
    .digest("hex");
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify(
      {
        result: "PASS",
        host: "real Electron + caelush-login protocol + production preload/IPC/supervisor",
        interactions,
        restart: "PASS",
        genericLoginProxy: proxyStatus,
        rendererAsset: asset,
        rendererSha256,
        projectFiles: Object.keys(beforeFiles).length,
        projectFilesAndGitUnchanged: true,
        beforeDatabase: manifest.beforeDatabase,
        afterDatabase: evidence,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  passed = true;
  await rm(path.join(artifacts, "failure.txt"), { force: true });
  process.stdout.write(
    "ARCHIVE_DESKTOP_SMOKE=PASS (real Electron/preload/daemon, restart, 105 records, project Git unchanged)\n",
  );
} catch (error) {
  await writeFile(path.join(artifacts, "failure.txt"), String(error.stack ?? error));
  process.stderr.write(`ARCHIVE_DESKTOP_SMOKE=FAIL ${String(error.message)}\n`);
  process.exitCode = 1;
} finally {
  if (application) {
    await application.evaluate(() => globalThis.archiveSmoke?.shutdown()).catch(() => undefined);
    await application.close();
  }
  if (passed) await removeSmokeRoot(root);
  else process.stderr.write(`Isolated fixture retained: ${root}\n`);
}
