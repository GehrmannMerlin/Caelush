/* global URL, fetch, process, document, window, HTMLElement, getComputedStyle */

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
const startNewSession = async () => {
  const newSessionButton = page.locator("button.workspace-new-session-button").first();
  if ((await newSessionButton.count()) === 0) {
    const selectedWorkspace = page
      .locator('button.workspace-list-button[aria-current="page"]')
      .first();
    if (
      (await selectedWorkspace.count()) !== 0 &&
      (await selectedWorkspace.getAttribute("aria-expanded")) !== "true"
    ) {
      await selectedWorkspace.click();
    }
  }
  await waitVisible(newSessionButton);
  await newSessionButton.click();
};
const selectSession = async (title) => {
  await page.locator("button.workspace-session-item").filter({ hasText: title }).click();
};
const openTimeline = async () => {
  const timeline = page.locator("details.timeline");
  if ((await timeline.count()) !== 0 && (await timeline.getAttribute("open")) === null) {
    await timeline.locator("summary").click();
  }
};
const assertViewportSplitLayout = async () => {
  const layout = await page.evaluate(() => {
    const sidebar = document.querySelector(".workspace-sidebar");
    const sessionScroll = document.querySelector(".session-scroll");
    const workspaceColumn = document.querySelector(".workspace-column");
    const addWorkspaceButton = document.querySelector(".workspace-add-button");
    const workspaceCard = document.querySelector(".workspace-card");
    if (!(sidebar instanceof HTMLElement)) throw new Error("workspace sidebar missing");
    if (!(sessionScroll instanceof HTMLElement)) throw new Error("session scroll region missing");
    if (!(workspaceColumn instanceof HTMLElement)) throw new Error("workspace column missing");
    if (!(addWorkspaceButton instanceof HTMLElement))
      throw new Error("add workspace button missing");
    if (!(workspaceCard instanceof HTMLElement)) throw new Error("workspace card missing");
    const sidebarStyle = getComputedStyle(sidebar);
    const sessionScrollStyle = getComputedStyle(sessionScroll);
    const columnStyle = getComputedStyle(workspaceColumn);
    const addWorkspaceButtonStyle = getComputedStyle(addWorkspaceButton);
    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      documentFitsViewport: document.documentElement.scrollHeight <= window.innerHeight + 1,
      bodyFitsViewport: document.body.scrollHeight <= window.innerHeight + 1,
      topbarCount: document.querySelectorAll(".web-topbar").length,
      brandInSidebar: sidebar.querySelector(".workspace-sidebar-brand") !== null,
      sidebarPosition: sidebarStyle.position,
      sidebarOverflowY: sidebarStyle.overflowY,
      sidebarBackgroundImage: sidebarStyle.backgroundImage,
      sessionOverflowY: sessionScrollStyle.overflowY,
      columnOverflowY: columnStyle.overflowY,
      addWorkspaceButtonWidth: addWorkspaceButton.getBoundingClientRect().width,
      workspaceCardWidth: workspaceCard.getBoundingClientRect().width,
      addWorkspaceButtonTextAlign: addWorkspaceButtonStyle.textAlign,
      addWorkspaceButtonColor: addWorkspaceButtonStyle.color,
    };
  });
  if (layout.topbarCount !== 0) throw new Error("desktop top navigation still exists");
  if (!layout.brandInSidebar) throw new Error("Agent brand is not inside the sidebar");
  if (layout.bodyOverflow !== "hidden") throw new Error("body scroll is not locked");
  if (!layout.documentFitsViewport || !layout.bodyFitsViewport)
    throw new Error("page-level vertical scroll leaked outside the panels");
  if (layout.sidebarPosition !== "fixed") throw new Error("sidebar is not fixed");
  if (layout.sidebarOverflowY !== "auto") throw new Error("sidebar does not own vertical scroll");
  if (layout.sessionOverflowY !== "visible")
    throw new Error("session scroll region should defer vertical scroll to the workspace rail");
  if (layout.columnOverflowY !== "auto")
    throw new Error("workspace column does not own the primary vertical scroll");
  if (layout.sidebarBackgroundImage !== "none") throw new Error("sidebar uses a gradient");
  if (Math.abs(layout.addWorkspaceButtonWidth - layout.workspaceCardWidth) > 1)
    throw new Error(
      `add workspace button is ${layout.addWorkspaceButtonWidth}px wide, card is ${layout.workspaceCardWidth}px`,
    );
  if (layout.addWorkspaceButtonTextAlign !== "center")
    throw new Error("add workspace button text is not centered");
  if (layout.addWorkspaceButtonColor !== "rgb(17, 24, 39)")
    throw new Error("sidebar action text is not high contrast");
};
const postJson = async (path, payload) => {
  const response = await fetch(new URL(path, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok)
    throw new Error("HTTP " + response.status + " from " + path + ": " + (await response.text()));
  return response.json();
};

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitVisible(page.locator(".workspace-sidebar"));
  await waitVisible(page.locator(".session-scroll"));
  await assertViewportSplitLayout();
  await startNewSession();
  const composer = page.locator("textarea.prompt-input");
  await composer.fill("read browser fixture");
  await page.locator("button.prompt-submit-button").click();
  await waitVisible(exactText("Verified browser result."));
  await openTimeline();
  await waitVisible(page.locator(".timeline-entry-title").filter({ hasText: "读取文件" }));
  await waitVisible(page.locator(".timeline-entry-path").filter({ hasText: "fixture.txt" }));
  if ((await page.locator(".session-list-meta").count()) !== 0)
    throw new Error("status subtitle leaked");
  if ((await page.locator(".session-status-icon").count()) < 1)
    throw new Error("status icon missing");
  if ((await page.locator('.session-status-icon[aria-label="已完成"]').count()) !== 1)
    throw new Error("completed status missing");

  await page.reload({ waitUntil: "domcontentloaded" });
  await selectSession("read browser fixture");
  await waitVisible(exactText("Verified browser result."));
  await startNewSession();
  await composer.fill("apply browser patch");
  await page.locator("button.prompt-submit-button").click();
  await waitVisible(exactText("需要审批"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await selectSession("apply browser patch");
  await waitVisible(page.locator(".approval-card"));
  await page.locator("button.approval-action--approve_once").click();
  await waitVisible(exactText("Verified browser result.").last());
  await openTimeline();
  await waitVisible(page.locator(".timeline-entry-title").filter({ hasText: "修改文件" }).last());
  await waitVisible(exactText("Verification passed.").last());
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "apply browser patch" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  await startNewSession();
  await composer.fill("reject browser patch");
  await page.locator("button.prompt-submit-button").click();
  await waitVisible(exactText("需要审批"));
  await page.locator("button.approval-action--reject").click();
  await exactText("需要审批").waitFor({ state: "hidden", timeout: 15_000 });
  await waitVisible(exactText("Verified browser result.").last());
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "reject browser patch" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  await startNewSession();
  await composer.fill("cancel browser task");
  await page.locator("button.prompt-submit-button").click();
  await waitVisible(page.locator("button.cancel-button"));
  await page.locator("button.cancel-button").click();
  await waitVisible(page.locator('.session-status-icon[aria-label="已取消"]').last());

  const reconnectSession = await postJson("/api/v1/sessions", {
    title: "reconnect browser task",
    defaultWorkspace: workspace,
    defaultModel: { provider: "browser-fixture", model: "browser-fixture-model" },
    metadata: {},
  });
  const reconnectRun = await postJson("/api/v1/sessions/" + reconnectSession.id + "/runs", {
    goal: "reconnect browser task",
    workspace,
    model: { provider: "browser-fixture", model: "browser-fixture-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 120_000 },
  });
  await postJson("/api/v1/runs/" + reconnectRun.id + "/start", {});
  await page.reload({ waitUntil: "domcontentloaded" });
  await selectSession("reconnect browser task");
  await waitVisible(page.locator("button.cancel-button"));
  await waitVisible(page.locator(".timeline-entry-title").filter({ hasText: "Model" }));
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
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 120_000 },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await selectSession("pending browser task");
  await waitVisible(page.locator(".recovery-panel"));
  await page.locator(".recovery-run button").click();
  await waitVisible(exactText("Verified browser result.").last());
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "pending browser task" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  await page.setViewportSize({ width: 375, height: 812 });
  await assertViewportSplitLayout();
  await page.locator(".sidebar-toggle-button").click();
  if ((await page.locator(".sidebar-toggle-button").getAttribute("aria-expanded")) !== "true")
    throw new Error("sidebar did not open");
  await page.locator(".sidebar-backdrop").click({ position: { x: 350, y: 120 } });
  if ((await page.locator(".sidebar-toggle-button").getAttribute("aria-expanded")) !== "false")
    throw new Error("sidebar did not close");
  await page.waitForTimeout(220);
  const body = await page.locator("body").innerText();
  if (!body.includes("pending browser task")) throw new Error("pending recovery title missing");
  for (const forbidden of ["Inspector", "Terminal", "stdout"]) {
    if (body.includes(forbidden)) throw new Error(forbidden + " leaked into production UI");
  }
  await mkdir(artifactDirectory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: artifactDirectory + "/desktop.png", fullPage: true });
  await page.locator(".workspace-card").first().hover();
  await page.waitForTimeout(220);
  const tooltipStyle = await page
    .locator(".workspace-card")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        opacity: style.opacity,
        width: style.width,
      };
    });
  if (tooltipStyle.backgroundColor !== "rgb(30, 79, 133)")
    throw new Error("workspace path tooltip is not solid blue");
  await page.screenshot({
    path: artifactDirectory + "/desktop-workspace-tooltip.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(220);
  await page.screenshot({ path: artifactDirectory + "/mobile.png", fullPage: true });
} catch (error) {
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({ path: artifactDirectory + "/failure.png", fullPage: true });
  await context.tracing.stop({ path: artifactDirectory + "/failure.zip" });
  throw error;
}
await context.tracing.stop();
await browser.close();
