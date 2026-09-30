import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createRunId, type SessionTurnPresentationResponse } from "@caelush/protocol";

import { TurnPresentationFeed } from "../src/components/turn-presentation-feed.js";

const runId = createRunId();
function presentation(): SessionTurnPresentationResponse {
  return {
    capabilityVersion: 1,
    highWatermark: 8,
    items: [
      {
        id: "user:presentation",
        runId,
        conversationTurnId: "turn-1",
        ordinal: 0,
        status: "COMPLETED",
        createdAt: 1,
        kind: "USER",
        text: "检查项目",
      },
      {
        id: "assistant:commentary",
        runId,
        conversationTurnId: "turn-1",
        ordinal: 1,
        status: "COMPLETED",
        createdAt: 2,
        kind: "ASSISTANT",
        phase: "COMMENTARY",
        text: "我先检查工作区并收集证据。",
      },
      {
        id: "tool-1:presentation",
        runId,
        conversationTurnId: "turn-1",
        ordinal: 2,
        status: "COMPLETED",
        createdAt: 3,
        kind: "TOOL",
        toolInvocationId: "tin_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
        toolName: "read_file",
        title: "读取文件",
        summary: "读取 src/index.ts",
        facts: [
          { key: "状态", value: "已完成" },
          { key: "风险", value: "低风险" },
        ],
        preview: "安全预览",
      },
      {
        id: "assistant:final",
        runId,
        conversationTurnId: "turn-1",
        ordinal: 3,
        status: "COMPLETED",
        createdAt: 4,
        kind: "ASSISTANT",
        phase: "FINAL_ANSWER",
        text: "检查完成，项目结构正常。",
      },
      {
        id: "run-summary",
        runId,
        conversationTurnId: "turn-summary",
        ordinal: 4,
        status: "COMPLETED",
        createdAt: 5,
        kind: "RUN_SUMMARY",
        runStatus: "COMPLETED",
        text: "任务已完成",
      },
    ],
  };
}

describe("TurnPresentationFeed", () => {
  it("keeps ordered public reasoning and Tool facts inside one active process disclosure", () => {
    const html = renderToStaticMarkup(
      <TurnPresentationFeed presentation={presentation()} isActive />,
    );
    expect(html).toContain('class="turn-presentation-process" open=""');
    expect(html.indexOf("我先检查工作区")).toBeLessThan(html.indexOf("安全预览"));
    expect(html).toContain("低风险");
    expect(html).not.toContain("已收敛");
    expect(html).not.toContain(">COMPLETED<");
  });

  it("collapses process detail after completion while leaving the final report visible below it", () => {
    const html = renderToStaticMarkup(
      <TurnPresentationFeed presentation={presentation()} isActive={false} />,
    );
    expect(html).not.toMatch(/class="turn-presentation-process" open=/u);
    expect(html.indexOf("执行过程")).toBeLessThan(html.indexOf("任务结束报告"));
    expect(html.indexOf("任务结束报告")).toBeLessThan(html.indexOf("检查完成，项目结构正常"));
    expect(html).toContain("任务已完成");
  });
});
