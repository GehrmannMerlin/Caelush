import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRunId,
  createToolInvocationId,
  type SessionTurnPresentationResponse,
} from "@caelush/protocol";
import { TurnPresentationFeed } from "../src/components/turn-presentation-feed.js";

const readStyle = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const presentationStyles = [
  readStyle("../../../packages/ui-theme/src/styles/light.css"),
  readStyle("../../../packages/ui-theme/src/styles/dark.css"),
  readStyle("../../../packages/ui-theme/src/styles/selector.css"),
  readStyle("../src/styles.css"),
].join("\n");

function renderSteeringTurn() {
  const runId = createRunId();
  const conversationTurnId = "turn-with-steering";
  const presentation = {
    capabilityVersion: 3 as const,
    turns: [
      {
        runId,
        conversationTurnId,
        runStatus: "RUNNING" as const,
        openedAt: 1,
        highWatermark: 3,
        items: [
          {
            id: "user:goal",
            runId,
            conversationTurnId,
            ordinal: 0,
            status: "COMPLETED" as const,
            createdAt: 1,
            kind: "USER" as const,
            text: "检查整个项目的结构。",
          },
          {
            id: "tool:read",
            runId,
            conversationTurnId,
            ordinal: 1,
            status: "COMPLETED" as const,
            createdAt: 2,
            kind: "TOOL" as const,
            toolInvocationId: createToolInvocationId(),
            toolName: "read_file",
            category: "READ" as const,
            phase: "COMPLETED" as const,
            title: "读取文件",
            summary: "读取 package.json",
            facts: [],
            effects: [],
          },
          {
            id: "user:steering",
            runId,
            conversationTurnId,
            ordinal: 2,
            status: "COMPLETED" as const,
            createdAt: 3,
            kind: "USER" as const,
            text: "再看一下版本约束。",
          },
        ],
      },
    ],
  } satisfies Extract<SessionTurnPresentationResponse, { capabilityVersion: 3 }>;

  return renderToStaticMarkup(
    <main style={{ width: "min(640px, calc(100vw - 32px))", margin: "32px auto" }}>
      <TurnPresentationFeed
        presentation={presentation}
        activeRun={{ id: runId, status: "RUNNING" }}
      />
    </main>,
  );
}

describe("steering message presentation", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  it("right-aligns compact steering bubbles after process items", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.setContent(
      `<!doctype html><html data-caelush-theme="light"><body>${renderSteeringTurn()}</body></html>`,
    );
    await page.addStyleTag({ content: presentationStyles });

    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => {
        const body = document.querySelector(".turn-presentation-process .turn-presentation-body");
        const processUser = document.querySelector(
          ".turn-presentation-process .turn-presentation-item--user",
        );
        const goalUser = document.querySelector(
          ".turn-presentation-users .turn-presentation-item--user",
        );
        const users = document.querySelector(".turn-presentation-users");
        if (
          !(body instanceof HTMLElement) ||
          !(processUser instanceof HTMLElement) ||
          !(goalUser instanceof HTMLElement) ||
          !(users instanceof HTMLElement)
        ) {
          throw new Error("Turn user items are missing");
        }
        const bodyRect = body.getBoundingClientRect();
        const bodyStyle = getComputedStyle(body);
        const userRect = processUser.getBoundingClientRect();
        const goalRect = goalUser.getBoundingClientRect();
        const usersRect = users.getBoundingClientRect();
        const innerRightEdge = bodyRect.right - Number.parseFloat(bodyStyle.paddingRight);
        return {
          processUserWidth: userRect.width,
          processContentWidth: body.clientWidth,
          processRightGap: innerRightEdge - userRect.right,
          goalRightGap: usersRect.right - goalRect.right,
          toolBeforeCorrection:
            document
              .querySelector(".turn-presentation-tool-entry")
              ?.compareDocumentPosition(processUser) === Node.DOCUMENT_POSITION_FOLLOWING,
        };
      });

      expect(layout.processUserWidth).toBeLessThan(layout.processContentWidth / 2);
      expect(layout.processRightGap).toBeCloseTo(0, 0);
      expect(layout.goalRightGap).toBeCloseTo(0, 0);
      expect(layout.toolBeforeCorrection).toBe(true);
    }

    await page.close();
  });
});
