/* global URL, fetch, process */

import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const [url, artifactDirectory, workspaceJson] = process.argv.slice(2);
if (url === undefined || artifactDirectory === undefined || workspaceJson === undefined) {
  throw new Error("Browser smoke requires URL, artifact directory, and workspace JSON.");
}
const workspace = JSON.parse(workspaceJson);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const waitVisible = (locator, timeout = 15_000) => locator.waitFor({ state: "visible", timeout });
const exactText = (value) => page.getByText(value, { exact: true });
const postJson = async (path, payload) => {
  const response = await fetch(new URL(path, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " from " + path);
  return response.json();
};

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitVisible(page.locator("#session-workspace-title"));
  await page.locator("button.new-session-button").click();
  const composer = page.locator("textarea.prompt-input");
  await composer.fill("read browser fixture");
  await page.locator("button.prompt-submit-button").click();
  await waitVisible(exactText("Verified browser result."));
  await waitVisible(page.locator(".timeline-entry-title").filter({ hasText: "读取文件" }));
  await waitVisible(page.locator(".timeline-entry-path").filter({ hasText: "fixture.txt" }));
  if ((await page.locator(".session-list-meta").count()) !== 0)
    throw new Error("status subtitle leaked");
  if ((await page.locator(".session-status-icon").count()) < 1)
    throw new Error("status icon missing");
  if ((await page.locator('.session-status-icon[aria-label="已完成"]').count()) !== 1)
    throw new Error("completed status missing");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".session-list-title").filter({ hasText: "read browser fixture" }).click();
  await waitVisible(exactText("Verified browser result."));
  await page.locator("button.new-session-button").click();
  await composer.fill("apply browser patch");
  await page.locator("button.prompt-submit-button").click();
  await waitVisible(exactText("需要审批"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".session-list-title").filter({ hasText: "apply browser patch" }).click();
  await waitVisible(page.locator(".approval-card"));
  await page.locator("button.approval-action--approve_once").click();
  await waitVisible(exactText("Verified browser result.").last());
  await waitVisible(page.locator(".timeline-entry-title").filter({ hasText: "修改文件" }).last());
  await waitVisible(exactText("Verification passed.").last());
  await waitVisible(
    page
      .locator("li.session-list-item")
      .filter({ hasText: "apply browser patch" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  await page.locator("button.new-session-button").click();
  await composer.fill("reject browser patch");
  await page.locator("button.prompt-submit-button").click();
  await waitVisible(exactText("需要审批"));
  await page.locator("button.approval-action--reject").click();
  await exactText("需要审批").waitFor({ state: "hidden", timeout: 15_000 });
  await waitVisible(exactText("Verified browser result.").last());
  await waitVisible(
    page
      .locator("li.session-list-item")
      .filter({ hasText: "reject browser patch" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  await page.locator("button.new-session-button").click();
  await composer.fill("cancel browser task");
  await page.locator("button.prompt-submit-button").click();
  await waitVisible(page.locator("button.cancel-button"));
  await page.locator("button.cancel-button").click();
  await waitVisible(page.locator('.session-status-icon[aria-label="已取消"]').last());

  const session = await postJson("/api/v1/sessions", {
    title: "pending browser task",
    defaultWorkspace: workspace,
    defaultModel: { provider: "browser-fixture", model: "browser-fixture-model" },
    metadata: {},
  });
  await postJson("/api/v1/sessions/" + session.id + "/runs", {
    goal: "pending browser task",
    workspace,
    model: { provider: "browser-fixture", model: "browser-fixture-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".session-list-title").filter({ hasText: "pending browser task" }).click();
  await waitVisible(page.locator(".recovery-panel"));
  await page.locator(".recovery-run button").click();
  await waitVisible(exactText("Verified browser result.").last());
  await waitVisible(
    page
      .locator("li.session-list-item")
      .filter({ hasText: "pending browser task" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator(".sidebar-toggle-button").click();
  if ((await page.locator(".sidebar-toggle-button").getAttribute("aria-expanded")) !== "true")
    throw new Error("sidebar did not open");
  await page.locator(".sidebar-close-button").click();
  if ((await page.locator(".sidebar-toggle-button").getAttribute("aria-expanded")) !== "false")
    throw new Error("sidebar did not close");
  const body = await page.locator("body").innerText();
  if (!body.includes("pending browser task")) throw new Error("pending recovery title missing");
  for (const forbidden of ["Inspector", "Terminal", "stdout"]) {
    if (body.includes(forbidden)) throw new Error(forbidden + " leaked into production UI");
  }
} catch (error) {
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({ path: artifactDirectory + "/failure.png", fullPage: true });
  await context.tracing.stop({ path: artifactDirectory + "/failure.zip" });
  throw error;
}
await context.tracing.stop();
await browser.close();
