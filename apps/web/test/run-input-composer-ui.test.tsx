import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRunId } from "@caelush/protocol";
import { PromptComposer } from "../src/components/prompt-composer.js";
import type { WebRunInputItem } from "../src/application/run-input-state.js";

const readStyle = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const composerStyles = [
  readStyle("../../../packages/ui-theme/src/styles/light.css"),
  readStyle("../../../packages/ui-theme/src/styles/dark.css"),
  readStyle("../../../packages/ui-theme/src/styles/selector.css"),
  readStyle("../src/styles.css"),
].join("\n");

const runId = createRunId();

function runInput(inputId: string, text: string, stage: WebRunInputItem["stage"]): WebRunInputItem {
  return { inputId, text, stage, runId };
}

function renderComposer(items: readonly WebRunInputItem[] = []) {
  return renderToStaticMarkup(
    <main
      className="conversation-composer-region"
      style={{ width: "min(640px, calc(100vw - 32px))", margin: "45vh auto 12px" }}
    >
      <PromptComposer
        disabled={false}
        submission="ACTIVE"
        editable
        steeringAvailable
        draftText=""
        onSteer={async () => true}
        onCancel={async () => true}
        onSubmit={async () => true}
        runInputs={items}
      />
    </main>,
  );
}

async function createStyledPage(
  browser: Browser,
  html: string,
  viewport = { width: 1280, height: 900 },
) {
  const page = await browser.newPage({ viewport });
  await page.setContent(
    `<!doctype html><html data-caelush-theme="light"><body>${html}</body></html>`,
  );
  await page.addStyleTag({ content: composerStyles });
  return page;
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector(".prompt-composer");
    const panel = document.querySelector(".run-input-pending");
    if (!(composer instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      throw new Error("Composer or pending guidance panel is missing");
    }
    const composerRect = composer.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelStyle = getComputedStyle(panel);
    return {
      composerHeight: composerRect.height,
      composerWidth: composerRect.width,
      panelHeight: panelRect.height,
      panelWidth: panelRect.width,
      panelPosition: panelStyle.position,
      panelMaxHeight: panelStyle.maxHeight,
      panelOverflowY: panelStyle.overflowY,
      panelClientHeight: panel.clientHeight,
      panelScrollHeight: panel.scrollHeight,
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
}

async function measureComposerHeight(page: Page) {
  return page
    .locator(".prompt-composer")
    .evaluate((element) => element.getBoundingClientRect().height);
}

describe("pending Run input composer presentation", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("shows only sending and pending guidance in a width-matched overlay", async () => {
    const page = await createStyledPage(
      browser,
      renderComposer([
        runInput("sending", "先确认配置文件的位置。", "SENDING"),
        runInput("pending", "分析这个内容记得记录在一个 md 文档中。", "PENDING"),
        runInput("recorded", "已经进入对话记录。", "RECORDED"),
        runInput("rejected", "仍在草稿里的文字。", "REJECTED"),
      ]),
    );

    const panel = page.getByRole("region", { name: "待应用的补充" });
    expect(await panel.isVisible()).toBe(true);
    const panelText = await panel.innerText();
    expect(panelText).toContain("先确认配置文件的位置。");
    expect(panelText).toContain("分析这个内容记得记录在一个 md 文档中。");
    expect(panelText).not.toContain("已经进入对话记录。");
    expect(panelText).not.toContain("仍在草稿里的文字。");
    expect(panelText).not.toContain("已接收，等待当前响应和工具批次结束");
    expect(await panel.locator("ul, li").count()).toBe(0);

    const layout = await measure(page);
    expect(layout.panelPosition).toBe("absolute");
    expect(layout.panelWidth).toBeCloseTo(layout.composerWidth, 0);
    expect(layout.panelOverflowY).toBe("auto");
    expect(layout.panelWidth).toBeLessThan(layout.viewportWidth);
    await page.close();
  });

  it("grows then scrolls without changing composer height", async () => {
    const shortPage = await createStyledPage(
      browser,
      renderComposer([runInput("short", "补充一句。", "PENDING")]),
    );
    const short = await measure(shortPage);

    await shortPage.setContent(
      `<!doctype html><html data-caelush-theme="light"><body>${renderComposer([
        runInput(
          "medium",
          "请检查一下这段任务执行过程中的输入，然后再继续；还有一条需要保留的补充说明。".repeat(3),
          "PENDING",
        ),
      ])}</body></html>`,
    );
    await shortPage.addStyleTag({ content: composerStyles });
    const medium = await measure(shortPage);

    await shortPage.setViewportSize({ width: 390, height: 844 });
    await shortPage.setContent(
      `<!doctype html><html data-caelush-theme="light"><body>${renderComposer()}</body></html>`,
    );
    await shortPage.addStyleTag({ content: composerStyles });
    const mobileComposerHeight = await measureComposerHeight(shortPage);

    await shortPage.setContent(
      `<!doctype html><html data-caelush-theme="light"><body>${renderComposer([
        runInput(
          "long",
          "请继续检查：" + "补充要求需要保留在当前任务中，完成后再总结。".repeat(120),
          "PENDING",
        ),
      ])}</body></html>`,
    );
    await shortPage.addStyleTag({ content: composerStyles });
    const long = await measure(shortPage);

    expect(medium.panelHeight).toBeGreaterThan(short.panelHeight);
    expect(long.panelHeight).toBeLessThanOrEqual(Math.min(844 * 0.42, 384) + 1);
    expect(long.panelScrollHeight).toBeGreaterThan(long.panelClientHeight);
    expect(medium.composerHeight).toBeCloseTo(short.composerHeight, 0);
    expect(long.composerHeight).toBeCloseTo(mobileComposerHeight, 0);
    expect(long.panelWidth).toBeCloseTo(long.composerWidth, 0);
    expect(long.documentWidth).toBeLessThanOrEqual(long.viewportWidth);
    await shortPage.close();
  });

  it("removes the overlay after the input is recorded", async () => {
    const html = renderComposer([runInput("recorded", "已成为正常对话消息。", "RECORDED")]);
    const page = await createStyledPage(browser, html);

    expect(await page.locator(".run-input-pending").count()).toBe(0);
    await page.close();
  });
});
