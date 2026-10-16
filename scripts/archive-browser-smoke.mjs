import assert from "node:assert/strict";
import process from "node:process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { CaelushClient } from "@caelush/client";
import { startDaemon } from "../apps/daemon/dist/index.js";
import {
  createSmokeRoot,
  removeSmokeRoot,
  createProjects,
  inventory,
  startModelFixture,
  seedArchiveFixture,
  databaseEvidence,
  exerciseArchivePage,
  model,
} from "./archive-smoke-fixture.mjs";

const argv = process.argv.slice(2);
assert.equal(argv[argv.indexOf("--mode") + 1], "web", "Use --mode web");
const requested = argv[argv.indexOf("--artifacts") + 1];
assert.ok(requested && path.isAbsolute(requested), "--artifacts must be absolute");
const artifacts = path.resolve(requested);
await mkdir(artifacts, { recursive: true });
const root = await createSmokeRoot();
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let daemon, browser, provider;
let passed = false;
try {
  const projects = await createProjects(root);
  const beforeFiles = await inventory(projects);
  provider = await startModelFixture();
  const databasePath = path.join(root, "caelush.db");
  const options = {
    databasePath,
    port: 0,
    providers: [
      {
        provider: model.provider,
        baseUrl: provider.url,
        apiKey: "archive-fixture-key",
        allowedModels: [model.model],
        modelProfiles: {
          [model.model]: {
            contextWindowTokens: 128000,
            maxOutputTokens: 8192,
            recommendedOutputReserveTokens: 4096,
          },
        },
      },
    ],
    defaultModel: model,
    fullAccessAvailable: true,
    web: { buildRoot: path.join(repository, "apps/web/dist") },
  };
  daemon = await startDaemon(options);
  let client = new CaelushClient({ baseUrl: daemon.url });
  const fixture = await seedArchiveFixture(client, projects);
  const beforeDatabase = databaseEvidence(databasePath, fixture);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(daemon.url);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("menuitem", { name: "已归档", exact: true }).click();
  await expect(page.locator(".archive-row").first()).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "archive-initial.png"), fullPage: false });
  const interactions = await exerciseArchivePage(page, artifacts);
  const { verifyWorkspaceReRegistration } = await import("./archive-smoke-fixture.mjs");
  await verifyWorkspaceReRegistration(client, fixture);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({ path: path.join(artifacts, "archive-narrow.png"), fullPage: true });
  assert.equal(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth,
    ),
    true,
    "No narrow horizontal overflow",
  );
  const stateBefore = await client.getArchiveState({
    type: "SESSION",
    sessionId: fixture.independentId,
  });
  await browser.close();
  browser = undefined;
  await daemon.close();
  daemon = undefined;
  daemon = await startDaemon(options);
  client = new CaelushClient({ baseUrl: daemon.url });
  assert.deepEqual(
    await client.getArchiveState({ type: "SESSION", sessionId: fixture.independentId }),
    stateBefore,
  );
  await assert.rejects(
    client.getSession(fixture.alpha.sessionId),
    (error) => error.status === 404 || error.code === "NOT_FOUND",
  );
  assert.equal((await client.listArchivedSessions({ query: "%_" })).matchedCount, 0);
  const afterDatabase = databaseEvidence(databasePath, fixture);
  assert.ok(Object.values(afterDatabase.alpha).every((count) => count === 0));
  assert.equal(afterDatabase.targetSession, 0);
  assert.equal(afterDatabase.bulkSessions, 0);
  assert.equal(afterDatabase.purgedWorkspaceSessions, 0);
  assert.equal(afterDatabase.purgedWorkspaceArchive, 0);
  assert.deepEqual(afterDatabase.retained, beforeDatabase.retained);
  assert.deepEqual(afterDatabase.foreignKeyCheck, []);
  assert.deepEqual(await inventory(projects), beforeFiles);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify(
      {
        result: "PASS",
        host: "real HTTP Web",
        interactions,
        restart: "PASS",
        projectFiles: Object.keys(beforeFiles).length,
        projectFilesAndGitUnchanged: true,
        beforeDatabase,
        afterDatabase,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
  passed = true;
  await rm(path.join(artifacts, "failure.txt"), { force: true });
  process.stdout.write(
    "ARCHIVE_WEB_SMOKE=PASS (real HTTP, 105 matching records, restart, database graph and project Git unchanged)\n",
  );
} catch (error) {
  await writeFile(path.join(artifacts, "failure.txt"), String(error.stack ?? error));
  process.stderr.write(`ARCHIVE_WEB_SMOKE=FAIL ${String(error.message)}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await daemon?.close();
  await provider?.close();
  if (passed) await removeSmokeRoot(root);
  else process.stderr.write(`Isolated fixture retained: ${root}\n`);
}
