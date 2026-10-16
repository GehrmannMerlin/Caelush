import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";

const readStyle = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

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
          <form class="prompt-composer">composer</form>
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
});
