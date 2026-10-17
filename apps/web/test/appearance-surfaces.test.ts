import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";

const readStyle = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
const readAssetDataUrl = (relativePath: string) =>
  "data:image/png;base64," +
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url))).toString("base64");

const lightLogoDataUrl = readAssetDataUrl("../../../packages/ui-theme/assets/caelush-logo.png");
const darkLogoDataUrl = readAssetDataUrl(
  "../../../packages/ui-theme/assets/caelush-logo-white.png",
);

const appearanceStyles = [
  readStyle("../../../packages/ui-theme/src/styles/light.css"),
  readStyle("../../../packages/ui-theme/src/styles/dark.css"),
  readStyle("../../../packages/ui-theme/src/styles/selector.css"),
  readStyle("../src/styles.css"),
].join("\n");

describe("appearance surface colors", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("switches existing workbench, dialog, archive, and Portal surfaces as one palette", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <html data-caelush-theme="light">
      <head></head>
      <body>
      <div class="host-shell"><div class="host-card">host</div></div>
      <main class="web-app-shell">
        <aside class="workspace-sidebar">
          <strong class="sidebar-copy">sidebar</strong>
          <button class="workspace-settings-button">settings</button>
        </aside>
        <section class="workspace-column">
          <div class="workspace-notices">notice</div>
          <form class="prompt-composer"><textarea class="prompt-input"></textarea></form>
          <article class="conversation-entry--assistant">assistant message</article>
          <article class="assistant-markdown"><a href="#">blue link</a></article>
        </section>
      </main>
      <div class="workspace-dialog-backdrop"><form class="workspace-dialog">dialog</form></div>
      <div class="settings-surface"><div class="settings-surface-panel">settings</div></div>
      <div class="model-picker-menu">models</div>
      <div class="workspace-settings-menu">sidebar menu</div>
      <main class="archive-page">archive</main>
      <button class="archive-bulk">delete all</button>
      <div class="archive-workspace-popover">archive filter</div>
      <div class="archive-delete-dialog">archive delete</div>
      <div class="permission-selector-confirmation">portal</div>
      <aside class="desktop-workspace-panel">desktop panel</aside>
      <section class="desktop-terminal">terminal</section>
      <section class="desktop-browser">browser toolbar</section>
      <div class="desktop-browser-viewport">browser viewport</div>
      <div class="timeline">timeline</div>
      <div class="workspace-bootstrap-loading">loading</div>
      <div class="workbench-loading-composer">loading composer</div>
      <div class="archive-error">archive error</div>
      <div class="archive-skeleton">archive loading</div>
      </body>
      </html>
    `);
    await page.addStyleTag({ content: appearanceStyles });
    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation: none !important; transition: none !important; }",
    });

    const readColors = () =>
      page.evaluate(() => {
        const color = (selector: string, property: "backgroundColor" | "color") => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
          return getComputedStyle(element)[property];
        };
        return {
          scheme: getComputedStyle(document.documentElement).colorScheme,
          hostShell: color(".host-shell", "backgroundColor"),
          hostCard: color(".host-card", "backgroundColor"),
          page: color(".web-app-shell", "backgroundColor"),
          sidebar: color(".workspace-sidebar", "backgroundColor"),
          sidebarCopy: color(".sidebar-copy", "color"),
          sidebarSettings: color(".workspace-settings-button", "color"),
          bodyText: color("body", "color"),
          notice: color(".workspace-notices", "backgroundColor"),
          composer: color(".prompt-composer", "backgroundColor"),
          assistantMessage: color(".conversation-entry--assistant", "backgroundColor"),
          workspaceDialog: color(".workspace-dialog", "backgroundColor"),
          settingsDialog: color(".settings-surface-panel", "backgroundColor"),
          modelMenu: color(".model-picker-menu", "backgroundColor"),
          sidebarMenu: color(".workspace-settings-menu", "backgroundColor"),
          archive: color(".archive-page", "backgroundColor"),
          archiveBulk: color(".archive-bulk", "backgroundColor"),
          archiveBulkText: color(".archive-bulk", "color"),
          archivePopover: color(".archive-workspace-popover", "backgroundColor"),
          archiveDeleteDialog: color(".archive-delete-dialog", "backgroundColor"),
          permissionPortal: color(".permission-selector-confirmation", "backgroundColor"),
          desktopPanel: color(".desktop-workspace-panel", "backgroundColor"),
          terminal: color(".desktop-terminal", "backgroundColor"),
          desktopBrowser: color(".desktop-browser", "backgroundColor"),
          desktopBrowserViewport: color(".desktop-browser-viewport", "backgroundColor"),
          timeline: color(".timeline", "backgroundColor"),
          loading: color(".workspace-bootstrap-loading", "backgroundColor"),
          loadingComposer: color(".workbench-loading-composer", "backgroundColor"),
          archiveError: color(".archive-error", "backgroundColor"),
          archiveSkeleton: color(".archive-skeleton", "backgroundColor"),
          composerInput: color(".prompt-input", "backgroundColor"),
          link: color(".assistant-markdown a", "color"),
        };
      });

    const light = await readColors();
    expect(light.scheme).toBe("light");
    expect(light.hostShell).toBe("rgb(255, 255, 255)");
    expect(light.hostCard).toBe("rgb(255, 255, 255)");
    expect(light.page).toBe("rgb(255, 255, 255)");
    expect(light.sidebar).toBe("rgb(251, 251, 251)");
    expect(light.sidebarCopy).toBe("rgb(17, 24, 39)");
    expect(light.sidebarSettings).toBe("rgb(17, 24, 39)");
    expect(light.bodyText).toBe("rgb(41, 55, 82)");
    expect(light.composer).toBe("rgb(255, 255, 255)");

    await page.evaluate(() => {
      document.documentElement.dataset.caelushTheme = "dark";
    });
    const dark = await readColors();
    expect(dark.scheme).toBe("dark");
    expect(dark.hostShell).toBe("rgb(24, 24, 24)");
    expect(dark.hostCard).toBe("rgb(42, 42, 42)");
    expect(dark.page).toBe("rgb(24, 24, 24)");
    expect(dark.sidebar).toBe("rgb(27, 27, 27)");
    expect(dark.sidebarSettings).toBe("rgb(243, 243, 243)");
    expect(dark.composer).toBe("rgb(54, 54, 54)");
    expect(dark.composerInput).toBe(dark.composer);
    expect(dark.notice).toBe("rgb(42, 42, 42)");
    expect(dark.assistantMessage).toBe("rgb(42, 42, 42)");
    expect(dark.workspaceDialog).toBe("rgb(42, 42, 42)");
    expect(dark.settingsDialog).toBe("rgb(42, 42, 42)");
    expect(dark.modelMenu).toBe("rgb(42, 42, 42)");
    expect(dark.sidebarMenu).toBe("rgb(42, 42, 42)");
    expect(dark.archive).toBe("rgb(24, 24, 24)");
    expect(dark.archiveBulk).toBe("rgb(61, 39, 41)");
    expect(dark.archiveBulkText).toBe("rgb(255, 138, 138)");
    expect(dark.archivePopover).toBe("rgb(42, 42, 42)");
    expect(dark.archiveDeleteDialog).toBe("rgb(42, 42, 42)");
    expect(dark.permissionPortal).toBe("rgb(42, 42, 42)");
    expect(dark.desktopPanel).toBe("rgb(27, 27, 27)");
    expect(dark.terminal).toBe("rgb(24, 24, 24)");
    expect(dark.desktopBrowser).toBe("rgb(42, 42, 42)");
    expect(dark.desktopBrowserViewport).toBe("rgb(42, 42, 42)");
    expect(dark.timeline).toBe("rgb(42, 42, 42)");
    expect(dark.loading).toBe("rgb(24, 24, 24)");
    expect(dark.loadingComposer).toBe("rgb(54, 54, 54)");
    expect(dark.archiveError).toBe("rgb(61, 39, 41)");
    expect(dark.archiveSkeleton).toBe("rgb(32, 32, 32)");
    expect(dark.link).toBe("rgb(122, 162, 255)");

    await page.evaluate(() => {
      document.documentElement.dataset.caelushTheme = "light";
    });
    const returnedToLight = await readColors();
    expect(returnedToLight.sidebar).toBe(light.sidebar);
    expect(returnedToLight.composer).toBe(light.composer);
    expect(returnedToLight.composerInput).toBe(light.composerInput);
    expect(returnedToLight.workspaceDialog).toBe(light.workspaceDialog);
    expect(returnedToLight.settingsDialog).toBe(light.settingsDialog);
    expect(returnedToLight.modelMenu).toBe(light.modelMenu);
    expect(returnedToLight.sidebarMenu).toBe(light.sidebarMenu);
    expect(returnedToLight.archive).toBe(light.archive);
    expect(returnedToLight.archivePopover).toBe(light.archivePopover);
    expect(returnedToLight.archiveDeleteDialog).toBe(light.archiveDeleteDialog);
    expect(returnedToLight.permissionPortal).toBe(light.permissionPortal);
    expect(returnedToLight.desktopPanel).toBe(light.desktopPanel);
    expect(returnedToLight.terminal).toBe(light.terminal);
    expect(returnedToLight.desktopBrowser).toBe(light.desktopBrowser);
    expect(returnedToLight.desktopBrowserViewport).toBe(light.desktopBrowserViewport);
    expect(returnedToLight.timeline).toBe(light.timeline);
    expect(returnedToLight.loading).toBe(light.loading);
    expect(returnedToLight.loadingComposer).toBe(light.loadingComposer);
    expect(returnedToLight.archiveError).toBe(light.archiveError);
    expect(returnedToLight.archiveSkeleton).toBe(light.archiveSkeleton);
  });

  it("keeps execution surfaces dark, confirms full-access text contrast, and sizes the permission control to its label", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <!doctype html>
      <html data-caelush-theme="dark">
      <body>
        <details class="turn-presentation-process" open>
          <div class="turn-presentation-body">
            <pre class="turn-presentation-tool-output">tool output</pre>
          </div>
        </details>
        <select class="permission-selector-select" id="permission">
          <option value="read">只读</option>
          <option value="workspace">工作区内修改</option>
          <option value="full">完全访问</option>
        </select>
        <div class="permission-selector-confirmation">
          <h2>确认完全权限</h2>
          <p>完全权限会让 Agent 使用主机用户范围执行文件、进程和网络操作。</p>
          <div class="permission-selector-confirmation-actions">
            <button type="button">取消</button>
            <button type="button">确认使用完全权限</button>
          </div>
        </div>
      </body>
      </html>
    `);
    await page.addStyleTag({ content: appearanceStyles });
    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation: none !important; transition: none !important; }",
    });

    const readStyle = (selector: string) =>
      page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
          borderWidth: style.borderWidth,
          borderRadius: style.borderRadius,
          width: element.getBoundingClientRect().width,
        };
      });

    expect((await readStyle(".turn-presentation-body")).backgroundColor).toBe("rgb(24, 24, 24)");
    expect((await readStyle(".turn-presentation-tool-output")).backgroundColor).toBe(
      "rgb(24, 24, 24)",
    );
    expect((await readStyle(".permission-selector-confirmation h2")).color).toBe(
      "rgb(243, 243, 243)",
    );
    expect((await readStyle(".permission-selector-confirmation p")).color).toBe(
      "rgb(243, 243, 243)",
    );
    expect(
      (await readStyle(".permission-selector-confirmation-actions button:first-child")).color,
    ).toBe("rgb(243, 243, 243)");
    expect(
      (await readStyle(".permission-selector-confirmation-actions button:last-child")).color,
    ).toBe("rgb(243, 243, 243)");

    const permission = page.locator("#permission");
    expect((await readStyle("#permission")).borderWidth).toBe("0px");
    await permission.hover();
    expect((await readStyle("#permission")).backgroundColor).toBe("rgb(48, 48, 48)");
    const shortPermissionWidth = (await readStyle("#permission")).width;
    await permission.selectOption("workspace");
    const longPermissionWidth = (await readStyle("#permission")).width;
    expect(longPermissionWidth).toBeGreaterThan(shortPermissionWidth);

    await page.evaluate(() => {
      document.documentElement.dataset.caelushTheme = "light";
    });
    expect((await readStyle(".turn-presentation-tool-output")).backgroundColor).toBe(
      "rgb(255, 255, 255)",
    );
    expect((await readStyle(".permission-selector-confirmation h2")).color).toBe("rgb(22, 36, 60)");
    expect((await readStyle(".permission-selector-confirmation p")).color).toBe("rgb(75, 93, 120)");
    expect((await readStyle("#permission")).borderWidth).toBe("0px");
    await permission.hover();
    expect((await readStyle("#permission")).backgroundColor).toBe("rgb(238, 240, 243)");
  });

  it("keeps dark welcome and process logos optically the same size as their light variants", async () => {
    for (const viewport of [
      { width: 2560, height: 1392 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      await page.setContent(
        [
          '<!doctype html><html data-caelush-theme="light"><head></head><body>',
          '<div class="conversation-start-brand"><img id="welcome-logo" class="caelush-brand" data-caelush-brand-kind="logo" data-caelush-brand-theme="light" src="',
          lightLogoDataUrl,
          '"></div>',
          '<details class="turn-presentation-process"><summary><span class="turn-presentation-summary-copy">',
          '<img id="process-logo" class="caelush-brand turn-presentation-logo" data-caelush-brand-kind="logo" data-caelush-brand-theme="light" src="',
          lightLogoDataUrl,
          '"><span class="turn-presentation-task-elapsed">用时</span></span></summary></details>',
          '<form class="prompt-composer"><textarea class="prompt-input"></textarea></form>',
          "</body></html>",
        ].join(""),
      );
      await page.addStyleTag({ content: appearanceStyles });
      await page.addStyleTag({
        content:
          "*, *::before, *::after { animation: none !important; transition: none !important; }",
      });

      const measureVisibleLogo = (selector: string) =>
        page.evaluate(async (imageSelector) => {
          const image = document.querySelector<HTMLImageElement>(imageSelector);
          if (image === null) throw new Error("Missing logo image: " + imageSelector);
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (context === null) throw new Error("Canvas is unavailable");
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let minX = canvas.width;
          let minY = canvas.height;
          let maxX = -1;
          let maxY = -1;
          for (let y = 0; y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width; x += 1) {
              if (pixels[(y * canvas.width + x) * 4 + 3]! <= 8) continue;
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            }
          }
          if (maxX < minX || maxY < minY) throw new Error("Logo image has no visible pixels");
          const rect = image.getBoundingClientRect();
          const style = getComputedStyle(image);
          const scale =
            style.objectFit === "cover"
              ? Math.max(rect.width / canvas.width, rect.height / canvas.height)
              : Math.min(rect.width / canvas.width, rect.height / canvas.height);
          const contentWidth = canvas.width * scale;
          const contentHeight = canvas.height * scale;
          let left = rect.left + (rect.width - contentWidth) / 2 + minX * scale;
          let right = rect.left + (rect.width - contentWidth) / 2 + (maxX + 1) * scale;
          let top = rect.top + (rect.height - contentHeight) / 2 + minY * scale;
          let bottom = rect.top + (rect.height - contentHeight) / 2 + (maxY + 1) * scale;
          left = Math.max(left, rect.left);
          right = Math.min(right, rect.right);
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
          for (
            let ancestor = image.parentElement;
            ancestor !== null;
            ancestor = ancestor.parentElement
          ) {
            const ancestorStyle = getComputedStyle(ancestor);
            const ancestorRect = ancestor.getBoundingClientRect();
            if (["hidden", "clip", "auto", "scroll"].includes(ancestorStyle.overflowX)) {
              left = Math.max(left, ancestorRect.left);
              right = Math.min(right, ancestorRect.right);
            }
            if (["hidden", "clip", "auto", "scroll"].includes(ancestorStyle.overflowY)) {
              top = Math.max(top, ancestorRect.top);
              bottom = Math.min(bottom, ancestorRect.bottom);
            }
          }
          return {
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top),
          };
        }, selector);

      const lightWelcome = await measureVisibleLogo("#welcome-logo");
      const lightProcess = await measureVisibleLogo("#process-logo");
      if (viewport.width === 2560) {
        expect(lightWelcome.width).toBeCloseTo(189, 0);
        expect(lightWelcome.height).toBeCloseTo(51, 0);
        expect(lightProcess.width).toBeCloseTo(73, 0);
        expect(lightProcess.height).toBeCloseTo(20, 0);
      }
      await page.evaluate(async (darkSrc) => {
        document.documentElement.dataset.caelushTheme = "dark";
        for (const image of document.querySelectorAll<HTMLImageElement>(
          "#welcome-logo, #process-logo",
        )) {
          image.dataset.caelushBrandTheme = "dark";
          image.src = darkSrc;
          await image.decode();
        }
      }, darkLogoDataUrl);
      const darkWelcome = await measureVisibleLogo("#welcome-logo");
      const darkProcess = await measureVisibleLogo("#process-logo");

      expect(darkWelcome.width).toBeCloseTo(lightWelcome.width, 0);
      expect(darkWelcome.height).toBeCloseTo(lightWelcome.height, 0);
      expect(darkProcess.width).toBeCloseTo(lightProcess.width, 0);
      expect(darkProcess.height).toBeCloseTo(lightProcess.height, 0);

      await page.evaluate(async (lightSrc) => {
        document.documentElement.dataset.caelushTheme = "light";
        for (const image of document.querySelectorAll<HTMLImageElement>(
          "#welcome-logo, #process-logo",
        )) {
          image.dataset.caelushBrandTheme = "light";
          image.src = lightSrc;
          await image.decode();
        }
      }, lightLogoDataUrl);
      const returnedWelcome = await measureVisibleLogo("#welcome-logo");
      const returnedProcess = await measureVisibleLogo("#process-logo");
      expect(returnedWelcome.width).toBeCloseTo(lightWelcome.width, 0);
      expect(returnedWelcome.height).toBeCloseTo(lightWelcome.height, 0);
      expect(returnedProcess.width).toBeCloseTo(lightProcess.width, 0);
      expect(returnedProcess.height).toBeCloseTo(lightProcess.height, 0);
      await page.close();
    }
  });
});
