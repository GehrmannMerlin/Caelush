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
    expect((await readStyle("#permission")).backgroundColor).toBe("rgb(245, 248, 255)");
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

  it("applies compact shared workbench typography and surfaces in both themes", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(`
      <!doctype html>
      <html data-caelush-theme="light">
      <body>
        <aside class="workspace-sidebar">
          <ol class="workspace-list">
            <li class="workspace-list-item workspace-list-item--selected workspace-list-item--has-sessions">
              <div id="project-row" class="workspace-card">
                <button class="workspace-list-button" type="button">
                  <span class="workspace-list-copy"><strong id="project-title">Caelush</strong></span>
                </button>
                <div class="workspace-card-actions">
                  <button id="project-action" class="workspace-card-action-button workspace-new-session-icon-button" type="button">+</button>
                </div>
              </div>
              <div class="workspace-session-group">
                <div class="workspace-session-row">
                  <button id="selected-session" class="workspace-session-item workspace-session-item--selected" type="button">
                    <span id="session-title" class="workspace-session-title">会话细节</span>
                  </button>
                  <button id="session-action" class="workspace-session-archive-button" type="button">×</button>
                </div>
              </div>
            </li>
          </ol>
        </aside>
        <main class="workspace-column">
          <section class="session-workspace">
            <div class="session-scroll">
              <div class="session-conversation assistant-markdown">
                <p id="body-copy">正文 <strong id="emphasis">强调</strong></p>
                <pre id="assistant-code"><code>npm run build</code></pre>
              </div>
              <div class="turn-presentation-process">
                <details class="turn-presentation-tool-entry" open>
                  <summary class="turn-presentation-tool-row">
                    <span class="turn-presentation-tool-action">读取</span>
                    <span class="turn-presentation-tool-subject">workspace-sidebar.ts</span>
                    <span class="turn-presentation-task-elapsed">11:20</span>
                  </summary>
                  <pre id="tool-code" class="turn-presentation-tool-command">const answer = 42;</pre>
                </details>
              </div>
            </div>
            <div class="conversation-composer-region">
              <form id="composer" class="prompt-composer">
                <textarea id="prompt-input" class="prompt-input" rows="2" placeholder="输入任务"></textarea>
                <div class="prompt-composer-footer">
                  <div class="prompt-composer-left-controls">
                    <button id="secondary" class="prompt-attachment-button" type="button">+</button>
                    <div class="permission-selector">
                      <select id="permission" class="permission-selector-select"><option>默认权限</option></select>
                    </div>
                  </div>
                  <div class="context-usage-control">
                    <button id="context-control" class="context-usage-ring-button" type="button">
                      <svg class="context-usage-ring" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7"></circle></svg>
                    </button>
                  </div>
                  <div class="prompt-composer-right-controls">
                    <div id="model-picker" class="model-picker">
                      <button id="model-trigger" class="model-picker-trigger" type="button">
                        模型
                      </button>
                      <div id="model-menu" class="model-picker-menu">
                        <div class="model-picker-menu-list">
                          <button id="model-item" class="model-picker-item" type="button">Claude</button>
                        </div>
                      </div>
                    </div>
                    <button id="submit" class="prompt-submit-button prompt-submit-button--icon" type="button">↑</button>
                  </div>
                </div>
              </form>
            </div>
          </section>
        </main>
      </body>
      </html>
    `);
    await page.addStyleTag({ content: appearanceStyles });
    await page.mouse.move(1279, 899);
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#selected-session") as Element).backgroundColor ===
        "rgb(234, 242, 255)",
      null,
      { timeout: 1000 },
    );
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#submit") as Element).boxShadow.includes(
          "rgba(37, 99, 235, 0.18)",
        ),
      null,
      { timeout: 1000 },
    );

    const readWorkbenchStyles = () =>
      page.evaluate(() => {
        const style = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (element === null) throw new Error(`Missing ${selector}`);
          const computed = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            background: computed.backgroundColor,
            borderColor: computed.borderColor,
            borderWidth: computed.borderWidth,
            boxShadow: computed.boxShadow,
            fontFamily: computed.fontFamily,
            fontSize: computed.fontSize,
            fontWeight: computed.fontWeight,
            gap: computed.gap,
            height: rect.height,
            lineHeight: computed.lineHeight,
            padding: computed.padding,
            radius: computed.borderRadius,
          };
        };
        return {
          body: style("#body-copy"),
          emphasis: style("#emphasis"),
          assistantCode: style("#assistant-code code"),
          tool: style(".turn-presentation-tool-entry"),
          metadata: style(".turn-presentation-task-elapsed"),
          code: style("#tool-code"),
          composer: style("#composer"),
          project: style("#project-row"),
          projectTitle: style("#project-title"),
          projectAction: style("#project-action"),
          session: style("#selected-session"),
          sessionTitle: style("#session-title"),
          sessionAction: style("#session-action"),
          permission: style("#permission"),
          modelTrigger: style("#model-trigger"),
          context: style("#context-control"),
          menu: style("#model-menu"),
          menuItem: style("#model-item"),
          button: style("#submit"),
          secondary: style("#secondary"),
          footer: style(".prompt-composer-footer"),
          leftControls: style(".prompt-composer-left-controls"),
        };
      });

    const light = await readWorkbenchStyles();
    expect(light.body.fontFamily).toContain("Microsoft YaHei UI");
    expect(light.body.fontFamily).toContain("PingFang SC");
    expect(light.body.fontSize).toBe("14px");
    expect(light.body.lineHeight).toBe("22px");
    expect(light.body.fontWeight).toBe("400");
    expect(light.emphasis.fontWeight).toBe("600");
    expect(light.assistantCode.fontFamily).toContain("Cascadia Code");
    expect(light.assistantCode.fontSize).toBe("12px");
    expect(light.assistantCode.lineHeight).toBe("19px");
    expect(light.tool.fontSize).toBe("12.5px");
    expect(light.tool.lineHeight).toBe("19px");
    expect(light.tool.fontFamily).toContain("Microsoft YaHei UI");
    expect(light.metadata.fontSize).toBe("11.5px");
    expect(light.metadata.lineHeight).toBe("19px");
    expect(light.code.fontFamily).toContain("Cascadia Code");
    expect(light.code.fontSize).toBe("12px");
    expect(light.code.lineHeight).toBe("19px");
    expect(light.composer.radius).toBe("12px");
    expect(light.composer.borderColor).toBe("rgb(230, 235, 242)");
    expect(light.composer.boxShadow).toContain("rgba(15, 23, 42, 0.024)");
    expect(light.composer.boxShadow).toContain("rgba(15, 23, 42, 0.04)");
    expect(light.composer.padding).toBe("10px");
    expect(light.footer.gap).toBe("6px");
    expect(light.leftControls.gap).toBe("6px");
    expect(light.projectTitle.fontSize).toBe("13px");
    expect(light.projectTitle.fontWeight).toBe("500");
    expect(light.projectTitle.lineHeight).toBe("20px");
    expect(light.project.height).toBe(32);
    expect(light.projectAction.height).toBe(28);
    expect(light.session.height).toBe(30);
    expect(light.session.radius).toBe("7px");
    expect(light.session.background).toBe("rgb(234, 242, 255)");
    expect(light.sessionTitle.fontSize).toBe("12.5px");
    expect(light.sessionTitle.fontWeight).toBe("500");
    expect(light.sessionTitle.lineHeight).toBe("19px");
    expect(light.sessionAction.height).toBeCloseTo(28, 2);
    expect(light.permission.height).toBe(28);
    expect(light.permission.fontSize).toBe("12px");
    expect(light.permission.fontWeight).toBe("500");
    expect(light.modelTrigger.height).toBe(28);
    expect(light.modelTrigger.fontSize).toBe("12px");
    expect(light.modelTrigger.fontWeight).toBe("500");
    expect(light.context.height).toBe(28);
    expect(light.menu.radius).toBe("10px");
    expect(light.menu.padding).toBe("5px");
    expect(light.menu.borderColor).toBe("rgba(15, 23, 42, 0.07)");
    expect(light.menu.borderWidth).toBe("1px");
    expect(light.menu.boxShadow).toContain("rgba(15, 23, 42, 0.05)");
    expect(light.menu.boxShadow).toContain("rgba(15, 23, 42, 0.12)");
    expect(light.menuItem.height).toBe(34);
    expect(light.menuItem.fontSize).toBe("12px");
    expect(light.button.height).toBe(28);
    expect(light.button.fontSize).toBe("12px");
    expect(light.button.fontWeight).toBe("500");
    expect(light.button.boxShadow).toContain("rgba(37, 99, 235, 0.18)");
    expect(light.secondary.borderWidth).toBe("0px");
    expect(light.secondary.boxShadow).toBe("none");
    expect(light.project.background).not.toBe(light.session.background);

    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const projectActionKeyboardFocus = await page.locator("#project-action").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        focused: element === document.activeElement,
        focusVisible: element.matches(":focus-visible"),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(projectActionKeyboardFocus.focused).toBe(true);
    expect(projectActionKeyboardFocus.focusVisible).toBe(true);
    expect(projectActionKeyboardFocus.outlineStyle).toBe("solid");
    expect(projectActionKeyboardFocus.outlineWidth).toBe("2px");

    for (let attempts = 0; attempts < 12; attempts += 1) {
      if (
        await page
          .locator("#model-trigger")
          .evaluate((element) => element === document.activeElement)
      ) {
        break;
      }
      await page.keyboard.press("Tab");
    }
    const lightModelKeyboardFocus = await page.locator("#model-trigger").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        focused: element === document.activeElement,
        focusVisible: element.matches(":focus-visible"),
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(lightModelKeyboardFocus.focused).toBe(true);
    expect(lightModelKeyboardFocus.focusVisible).toBe(true);
    expect(lightModelKeyboardFocus.outlineColor).toBe("rgb(37, 99, 235)");
    expect(lightModelKeyboardFocus.outlineStyle).toBe("solid");
    expect(lightModelKeyboardFocus.outlineWidth).toBe("2px");

    await page.locator("#secondary").hover();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#secondary") as Element).backgroundColor ===
        "rgb(245, 248, 255)",
      null,
      { timeout: 1000 },
    );
    const lightSecondaryHover = await page.locator("#secondary").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderWidth: style.borderWidth,
        boxShadow: style.boxShadow,
      };
    });
    expect(lightSecondaryHover).toEqual({
      background: "rgb(245, 248, 255)",
      borderWidth: "0px",
      boxShadow: "none",
    });
    await page.mouse.move(1279, 899);

    await page.locator("#prompt-input").focus();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#composer") as Element).boxShadow.includes(
          "rgba(37, 99, 235, 0.12)",
        ),
      null,
      { timeout: 1000 },
    );
    const lightFocusShadow = await page
      .locator("#composer")
      .evaluate((element) => getComputedStyle(element).boxShadow);
    expect(lightFocusShadow).toContain("rgba(37, 99, 235, 0.12)");
    expect(lightFocusShadow).toContain("rgba(15, 23, 42, 0.04)");
    await page.locator("#submit").hover();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#submit") as Element).filter ===
        "brightness(0.96)",
      null,
      { timeout: 1000 },
    );
    const lightHover = await page.locator("#submit").evaluate((element) => ({
      filter: getComputedStyle(element).filter,
      boxShadow: getComputedStyle(element).boxShadow,
    }));
    expect(lightHover.filter).toBe("brightness(0.96)");
    expect(lightHover.boxShadow).toContain("rgba(37, 99, 235, 0.28)");
    await page.mouse.down();
    await page.waitForTimeout(80);
    const pressedTransform = await page
      .locator("#submit")
      .evaluate((element) => getComputedStyle(element).transform);
    const pressScale = await page.evaluate(
      (transform) => new DOMMatrixReadOnly(transform).a,
      pressedTransform,
    );
    expect(pressScale).toBeCloseTo(0.975, 2);
    await page.mouse.up();
    const releaseMotion = await page.locator("#submit").evaluate((element) => {
      const style = getComputedStyle(element);
      return { duration: style.transitionDuration, easing: style.transitionTimingFunction };
    });
    expect(releaseMotion.duration).toContain("0.18s");
    expect(releaseMotion.easing).toContain("cubic-bezier(0.2, 0.8, 0.2, 1)");
    await page.mouse.move(0, 0);

    await page.evaluate(() => {
      document.documentElement.dataset.caelushTheme = "dark";
    });
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#selected-session") as Element).backgroundColor ===
        "rgb(37, 51, 77)",
      null,
      { timeout: 1000 },
    );
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#submit") as Element).boxShadow.includes(
          "rgba(0, 0, 0, 0.28)",
        ),
      null,
      { timeout: 1000 },
    );
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#composer") as Element).boxShadow.includes(
          "rgba(122, 162, 255, 0.12)",
        ),
      null,
      { timeout: 1000 },
    );
    const dark = await readWorkbenchStyles();
    expect(dark.composer.borderColor).toBe("rgb(51, 51, 51)");
    expect(dark.composer.boxShadow).toContain("rgba(0, 0, 0, 0.2)");
    expect(dark.composer.boxShadow).toContain("rgba(0, 0, 0, 0.267)");
    expect(dark.composer.boxShadow).toContain("rgba(122, 162, 255, 0.12)");
    expect(dark.assistantCode.fontFamily).toContain("Cascadia Code");
    expect(dark.assistantCode.fontSize).toBe("12px");
    expect(dark.assistantCode.lineHeight).toBe("19px");
    expect(dark.tool.fontFamily).toContain("Microsoft YaHei UI");
    expect(dark.session.background).toBe("rgb(37, 51, 77)");
    expect(dark.project.background).not.toBe(dark.session.background);
    expect(dark.menu.boxShadow).toContain("rgba(0, 0, 0, 0.24)");
    expect(dark.menu.boxShadow).toContain("rgba(0, 0, 0, 0.38)");
    expect(dark.menu.boxShadow).toContain("rgba(255, 255, 255, 0.08)");
    expect(dark.menu.borderWidth).toBe("1px");
    expect(dark.button.boxShadow).toContain("rgba(0, 0, 0, 0.28)");
    expect(dark.secondary.background).toBe("rgba(0, 0, 0, 0)");
    expect(dark.secondary.borderWidth).toBe("0px");
    expect(dark.secondary.boxShadow).toBe("none");
    await page.locator("#model-trigger").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const darkModelKeyboardFocus = await page.locator("#model-trigger").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        focused: element === document.activeElement,
        focusVisible: element.matches(":focus-visible"),
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(darkModelKeyboardFocus.focused).toBe(true);
    expect(darkModelKeyboardFocus.focusVisible).toBe(true);
    expect(darkModelKeyboardFocus.outlineColor).toBe("rgb(122, 162, 255)");
    expect(darkModelKeyboardFocus.outlineStyle).toBe("solid");
    expect(darkModelKeyboardFocus.outlineWidth).toBe("2px");
    await page.locator("#secondary").hover();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#secondary") as Element).backgroundColor ===
        "rgb(48, 48, 48)",
      null,
      { timeout: 1000 },
    );
    expect(
      await page
        .locator("#secondary")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe("rgb(48, 48, 48)");
    await page.locator("#submit").hover();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#submit") as Element).boxShadow.includes(
          "rgba(0, 0, 0, 0.36)",
        ),
      null,
      { timeout: 1000 },
    );
    const darkHoverShadow = await page
      .locator("#submit")
      .evaluate((element) => getComputedStyle(element).boxShadow);
    expect(darkHoverShadow).toContain("rgba(0, 0, 0, 0.36)");
    await page.setViewportSize({ width: 390, height: 844 });
    const narrowComposerLayout = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (element === null) throw new Error(`Missing ${selector}`);
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      return {
        composer: bounds("#composer"),
        left: bounds(".prompt-composer-left-controls"),
        context: bounds("#context-control"),
        right: bounds(".prompt-composer-right-controls"),
        model: bounds("#model-picker"),
        submit: bounds("#submit"),
      };
    });
    for (const control of [
      narrowComposerLayout.left,
      narrowComposerLayout.context,
      narrowComposerLayout.right,
      narrowComposerLayout.model,
      narrowComposerLayout.submit,
    ]) {
      expect(control.left).toBeGreaterThanOrEqual(narrowComposerLayout.composer.left);
      expect(control.right).toBeLessThanOrEqual(narrowComposerLayout.composer.right);
    }
    expect(narrowComposerLayout.left.bottom).toBeLessThanOrEqual(narrowComposerLayout.right.bottom);
    expect(narrowComposerLayout.context.top).toBeGreaterThan(narrowComposerLayout.left.top);

    await page.setViewportSize({ width: 320, height: 720 });
    const narrowMenuBounds = await page.locator("#model-menu").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
    expect(narrowMenuBounds.width).toBeLessThanOrEqual(288);
    expect(narrowMenuBounds.left).toBeGreaterThanOrEqual(0);
    expect(narrowMenuBounds.right).toBeLessThanOrEqual(320);
    await page.close();
  });

  it("keeps sidebar actions visible to touch users and honors reduced motion", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    await page.setContent(`
      <!doctype html>
      <html data-caelush-theme="light">
      <body>
        <aside class="workspace-sidebar">
          <div class="workspace-card">
            <button class="workspace-card-action-button" id="touch-project-action" type="button">+</button>
          </div>
          <div class="workspace-session-row">
            <button class="workspace-session-item" type="button">Session</button>
            <button class="workspace-session-archive-button" id="touch-session-action" type="button">×</button>
          </div>
        </aside>
        <button class="prompt-submit-button" id="reduced-motion-button" type="button">Send</button>
      </body>
      </html>
    `);
    await page.addStyleTag({ content: appearanceStyles });

    const readActionState = (selector: string) =>
      page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, pointerEvents: style.pointerEvents };
      });
    expect(await readActionState("#touch-project-action")).toEqual({
      opacity: "1",
      pointerEvents: "auto",
    });
    expect(await readActionState("#touch-session-action")).toEqual({
      opacity: "1",
      pointerEvents: "auto",
    });

    const reducedMotion = await page.locator("#reduced-motion-button").evaluate((element) => {
      const style = getComputedStyle(element);
      return { transitionDuration: style.transitionDuration, transform: style.transform };
    });
    expect(
      reducedMotion.transitionDuration.split(",").every((duration) => duration.trim() === "0s"),
    ).toBe(true);
    expect(reducedMotion.transform).toBe("none");
    await page.close();
  });
});
