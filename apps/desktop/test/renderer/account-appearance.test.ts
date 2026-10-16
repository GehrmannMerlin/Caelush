import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
const entry = [
  'import { StrictMode, useState } from "react";',
  'import { createRoot } from "react-dom/client";',
  'import { AccountAppearanceScreen } from "./src/renderer/components/account-appearance-screen.tsx";',
  'const initial = { preference: "light", resolvedTheme: "light", revision: 0 };',
  'const bridge = { capabilityVersion: 1, initialSnapshot: initial, getSnapshot: async()=>initial, setPreference: async(preference)=>({preference,resolvedTheme:preference==="system"?"light":preference,revision:1}), subscribe: ()=>()=>{} };',
  "window.appearanceTest = { calls: [] };",
  "function Harness() { const [snapshot, setSnapshot] = useState(initial); const [supported, setSupported] = useState(true); window.appearanceTest.unsupported = () => setSupported(false); return <AccountAppearanceScreen snapshot={snapshot} api={supported?bridge:undefined} error={null} onPreferenceChange={async(preference)=>{window.appearanceTest.calls.push(preference);const next=await bridge.setPreference(preference);setSnapshot(next);return next;}}/>; }",
  'createRoot(document.getElementById("root")).render(<StrictMode><Harness/></StrictMode>);',
].join("\n");

describe.skipIf(!existsSync(chromium.executablePath()))("Desktop account appearance page", () => {
  let browser: Browser;
  let page: Page;
  let bundle: string;
  let appSource: string;

  beforeAll(async () => {
    const output = await build({
      stdin: { contents: entry, resolveDir: desktopRoot, loader: "tsx" },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    bundle = output.outputFiles[0]!.text;
    appSource = await readFile(new URL("../../src/renderer/App.tsx", import.meta.url), "utf8");
    browser = await chromium.launch({ headless: true });
  }, 30000);

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.setDefaultTimeout(2500);
    await page.setContent(
      '<html data-caelush-theme="light"><body><div id="root"></div></body></html>',
    );
    for (const filename of ["light.css", "dark.css", "selector.css"])
      await page.addStyleTag({
        content: await readFile(
          new URL(`../../../../packages/ui-theme/src/styles/${filename}`, import.meta.url),
          "utf8",
        ),
      });
    await page.addStyleTag({
      content: await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8"),
    });
    await page.addScriptTag({ content: bundle });
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("offers all three appearance modes and forwards each selected preference", async () => {
    for (const label of ["浅色", "深色", "跟随系统"])
      expect(await page.getByRole("radio", { name: label }).count()).toBe(1);

    await page.locator(".caelush-appearance__option").nth(1).click();
    expect(await page.evaluate(() => window.appearanceTest.calls)).toEqual(["dark"]);
    expect(await page.getByText("选择此设备上的显示模式").count()).toBe(1);
  });

  it("shows an explicit unsupported-version message without appearance controls", async () => {
    await page.evaluate(() => window.appearanceTest.unsupported());

    expect(await page.getByRole("status").innerText()).toContain("当前 Desktop 版本不支持外观设置");
    expect(await page.getByRole("radio").count()).toBe(0);
  });

  it("recognizes the appearance route and exposes it after personal information", () => {
    expect(appSource).toContain('query.get("section") === "appearance"');
    expect(appSource).toContain('onNavigate("appearance")');
    expect(appSource.indexOf('onNavigate("profile")')).toBeLessThan(
      appSource.indexOf('onNavigate("appearance")'),
    );
    expect(appSource).toContain('return "appearance";');
  });

  it("applies distinct palettes to account, login, dialog, and archive surfaces", async () => {
    await page.evaluate(() => {
      const root = document.getElementById("root");
      if (root === null) throw new Error("missing root");
      root.innerHTML = `
        <div class="account-layout">
          <aside class="account-sidebar" id="theme-sidebar"></aside>
          <main class="account-content" id="theme-content">
            <section class="detail-panel" id="theme-card"></section>
            <div class="update-history-menu" id="theme-menu"></div>
            <div class="profile-crop-dialog" id="theme-crop-dialog"></div>
            <button class="revoke-button" id="theme-revoke">撤销</button>
            <section class="archive-page" id="theme-archive">
              <button class="archive-workspace-trigger" id="theme-archive-trigger">全部工作区</button>
              <div class="archive-workspace-popover" id="theme-popover"></div>
              <div class="archive-modal-backdrop" id="theme-archive-backdrop"></div>
              <div class="archive-delete-dialog" id="theme-archive-dialog"></div>
              <button class="archive-bulk" id="theme-archive-bulk">删除全部</button>
              <button class="archive-danger" id="theme-archive-danger">删除</button>
            </section>
          </main>
        </div>
        <main class="auth-layout">
          <div class="auth-content"><section class="auth-panel"><div class="auth-panel-inner">
            <div class="input-wrap" id="theme-auth-input"><input /></div>
            <button class="primary-button" id="theme-auth-button">登录</button>
            <div class="message-box info" id="theme-auth-info">提示</div>
            <div class="message-box error" id="theme-auth-error">错误</div>
          </div></section></div>
        </main>`;
    });

    const readColors = () =>
      page.evaluate(() => {
        const color = (id: string, property: "backgroundColor" | "color" | "borderTopColor") =>
          getComputedStyle(document.getElementById(id)!)[property];
        return {
          theme: document.documentElement.dataset.caelushTheme,
          sidebar: color("theme-sidebar", "backgroundColor"),
          content: color("theme-content", "backgroundColor"),
          card: color("theme-card", "backgroundColor"),
          menu: color("theme-menu", "backgroundColor"),
          cropDialog: color("theme-crop-dialog", "backgroundColor"),
          revoke: color("theme-revoke", "backgroundColor"),
          archive: color("theme-archive", "backgroundColor"),
          archiveTrigger: color("theme-archive-trigger", "backgroundColor"),
          popover: color("theme-popover", "backgroundColor"),
          archiveBackdrop: color("theme-archive-backdrop", "backgroundColor"),
          archiveDialog: color("theme-archive-dialog", "backgroundColor"),
          archiveBulk: color("theme-archive-bulk", "backgroundColor"),
          archiveDanger: color("theme-archive-danger", "backgroundColor"),
          authInput: color("theme-auth-input", "backgroundColor"),
          authButton: color("theme-auth-button", "backgroundColor"),
          authButtonText: color("theme-auth-button", "color"),
          authInfo: color("theme-auth-info", "backgroundColor"),
          authError: color("theme-auth-error", "backgroundColor"),
          text: color("theme-content", "color"),
        };
      });

    const light = await readColors();
    await page.evaluate(() => {
      document.documentElement.dataset.caelushTheme = "dark";
    });
    await page.waitForTimeout(150);
    const dark = await readColors();

    expect(light.sidebar).toBe("rgb(249, 249, 249)");
    expect(light.content).toBe("rgb(255, 255, 255)");
    expect(light.card).toBe("rgb(255, 255, 255)");
    expect(light.cropDialog).toBe("rgb(255, 255, 255)");
    expect(light.archive).toBe("rgb(255, 255, 255)");
    expect(light.popover).toBe("rgb(255, 255, 255)");
    expect(light.archiveDialog).toBe("rgb(255, 255, 255)");
    expect(light.authInput).toBe("rgb(255, 255, 255)");
    expect(dark.sidebar).toBe("rgb(27, 27, 27)");
    expect(dark.content).toBe("rgb(24, 24, 24)");
    expect(dark.card).toBe("rgb(42, 42, 42)");
    expect(dark.menu).toBe("rgb(42, 42, 42)");
    expect(dark.cropDialog).toBe("rgb(42, 42, 42)");
    expect(dark.archive).toBe("rgb(24, 24, 24)");
    expect(dark.popover).toBe("rgb(42, 42, 42)");
    expect(dark.archiveDialog).toBe("rgb(42, 42, 42)");
    expect(dark.authInput).toBe("rgb(54, 54, 54)");
    expect(dark.revoke).toBe("rgb(61, 39, 41)");
    expect(dark.authButton).toBe("rgb(122, 162, 255)");
    expect(dark.authButtonText).toBe("rgb(18, 18, 18)");
    expect(dark.authInfo).toBe("rgb(42, 42, 42)");
    expect(dark.authError).toBe("rgb(61, 39, 41)");
    expect(dark.archiveTrigger).toBe("rgb(54, 54, 54)");
    expect(dark.archiveBackdrop).toBe("rgba(0, 0, 0, 0.64)");
    expect(dark.archiveBulk).toBe("rgb(61, 39, 41)");
    expect(dark.archiveDanger).toBe("rgb(255, 138, 138)");
    expect(dark.text).toBe("rgb(243, 243, 243)");
    await page.addStyleTag({ content: "#theme-archive-backdrop { display: none; }" });
    await page.locator("#theme-revoke").hover();
    await page.waitForTimeout(150);
    expect((await readColors()).revoke).toBe("rgb(61, 39, 41)");
  });
});
