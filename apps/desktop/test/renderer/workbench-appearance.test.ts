import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

declare global {
  interface Window {
    appearanceRouteTest: { preferences: string[] };
  }
}

const webRoot = fileURLToPath(new URL("../../../web/", import.meta.url));
const entry = [
  'import { createElement, useState } from "react";',
  'import { createRoot } from "react-dom/client";',
  'import { WorkbenchAppearanceRoute } from "./src/components/appearance-page.js";',
  'import { WorkspaceSidebarFooter } from "./src/components/workspace-sidebar-footer.js";',
  'const initial = { preference: "system", resolvedTheme: "dark", revision: 2 };',
  "window.appearanceRouteTest = { preferences: [] };",
  'function DraftWorkspace({ onOpenAppearance }) { const [draft, setDraft] = useState(""); return createElement("main", {className:"web-app-shell"}, createElement("div", {style:{position:"fixed", bottom:16, left:16, width:220}}, createElement(WorkspaceSidebarFooter, {onOpenAppearance})), createElement("textarea", {"aria-label":"未发送内容", value:draft, onChange:event=>setDraft(event.currentTarget.value)})); }',
  'function Harness() { const [open, setOpen] = useState(false); const [snapshot, setSnapshot] = useState(initial); const changePreference = async preference => { window.appearanceRouteTest.preferences.push(preference); const next = {preference, resolvedTheme:preference === "system" ? "dark" : preference, revision:snapshot.revision + 1}; setSnapshot(next); return next; }; return createElement(WorkbenchAppearanceRoute, {isOpen:open, snapshot, workbench:createElement(DraftWorkspace, {onOpenAppearance:()=>setOpen(true)}), onBack:()=>setOpen(false), onPreferenceChange:changePreference}); }',
  'createRoot(document.getElementById("root")).render(createElement(Harness));',
].join("\n");

describe.skipIf(!existsSync(chromium.executablePath()))("Web appearance page", () => {
  let browser: Browser;
  let page: Page;
  let bundle: string;

  beforeAll(async () => {
    const output = await build({
      stdin: { contents: entry, resolveDir: webRoot, loader: "tsx" },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    bundle = output.outputFiles[0]!.text;
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(2500);
    await page.setContent(
      '<html data-caelush-theme="light"><head><meta name="theme-color" content="#ffffff"></head><body><div id="root"></div></body></html>',
    );
    for (const filename of ["light.css", "dark.css", "selector.css"])
      await page.addStyleTag({
        content: readFileSync(
          fileURLToPath(
            new URL(`../../../../packages/ui-theme/src/styles/${filename}`, import.meta.url),
          ),
          "utf8",
        ),
      });
    await page.addStyleTag({
      content: readFileSync(
        fileURLToPath(new URL("../../../web/src/styles.css", import.meta.url)),
        "utf8",
      ),
    });
    await page.addScriptTag({ content: bundle });
  });

  afterAll(async () => {
    await browser?.close();
  });

  afterEach(async () => {
    await page?.close();
  });

  it("opens a sidebar-free appearance page and returns with the workbench draft intact", async () => {
    const draft = page.getByRole("textbox", { name: "未发送内容" });
    await draft.fill("尚未发送的工作内容");
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("menuitem", { name: "外观" }).click();

    expect(await page.getByRole("heading", { name: "外观", level: 1 }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "返回工作台" }).isVisible()).toBe(true);
    for (const label of ["浅色", "深色", "跟随系统"])
      expect(await page.getByRole("radio", { name: label }).isVisible()).toBe(true);
    expect(await page.locator("#caelush-workspace-sidebar").count()).toBe(0);
    expect(await page.locator(".web-app-shell").isHidden()).toBe(true);

    await page.getByRole("radio", { name: "深色" }).check({ force: true });
    await page.waitForFunction(() => window.appearanceRouteTest.preferences.length === 1);
    expect(await page.evaluate(() => window.appearanceRouteTest.preferences)).toEqual(["dark"]);
    await page.getByRole("button", { name: "返回工作台" }).click();

    expect(await page.locator(".web-app-shell").isVisible()).toBe(true);
    expect(await draft.inputValue()).toBe("尚未发送的工作内容");
  });

  it("uses the shared dark palette and stacks choices on a narrow viewport", async () => {
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("menuitem", { name: "外观" }).click();
    await page.evaluate(() => {
      document.documentElement.dataset.caelushTheme = "dark";
    });
    const colors = await page.locator(".appearance-page").evaluate((element) => ({
      page: getComputedStyle(element).backgroundColor,
      card: getComputedStyle(element.querySelector(".appearance-page-card")!).backgroundColor,
    }));
    expect(colors).toEqual({ page: "rgb(24, 24, 24)", card: "rgb(42, 42, 42)" });

    await page.setViewportSize({ width: 390, height: 844 });
    const columns = await page
      .locator(".caelush-appearance__options")
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(1);
  });
});
