import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createInitialLiveActivityState } from "@caelush/client";
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

  it("collapses process detail after completion while leaving the final answer visible below it", () => {
    const html = renderToStaticMarkup(
      <TurnPresentationFeed presentation={presentation()} isActive={false} />,
    );
    expect(html).not.toMatch(/class="turn-presentation-process" open=/u);
    expect(html.indexOf("我先检查工作区")).toBeLessThan(html.indexOf("检查完成，项目结构正常"));
    expect(html).not.toContain("任务结束报告");
    expect(html).not.toContain("任务已完成");
  });

  it("uses the Caelush logo as the process title without the redundant activity kicker", () => {
    const html = renderToStaticMarkup(
      <TurnPresentationFeed presentation={presentation()} isActive={false} />,
    );

    expect(html).toContain('class="turn-presentation-logo"');
    expect(html).toContain('alt="Caelush"');
    expect(html).not.toContain("任务活动");
    expect(html).not.toContain('class="turn-presentation-kicker"');
    expect(html).not.toContain(">执行过程<");
  });

  it("uses the open-source circular success icon for completed durable Tool rows", () => {
    const html = renderToStaticMarkup(
      <TurnPresentationFeed presentation={presentation()} isActive={false} />,
    );

    expect(html).toContain("lucide-circle-check");
    expect(html).not.toContain(
      'turn-presentation-item--completed"><span class="turn-presentation-mark"><svg class="lucide lucide-check',
    );
  });

  it("spins only active live rows and renders explicit completed, failed, and cancelled outcomes", () => {
    const initial = createInitialLiveActivityState(runId);
    const common = {
      streamSequence: 1,
      runId,
      stepId: "step-1",
    };
    const liveActivity = {
      ...initial,
      activities: [
        {
          ...common,
          id: "live-active",
          kind: "MODEL_TEXT" as const,
          status: "ACTIVE" as const,
          text: "正在生成",
          streamKey: "model:active",
        },
        {
          ...common,
          id: "live-completed",
          kind: "MODEL_TOOL_CALL" as const,
          status: "COMPLETED" as const,
          text: "读取文件",
          streamKey: "tool:completed",
        },
        {
          ...common,
          id: "live-failed",
          kind: "TOOL_OUTPUT" as const,
          status: "FAILED" as const,
          text: "执行失败",
          streamKey: "tool:failed",
        },
        {
          ...common,
          id: "live-cancelled",
          kind: "PROCESS_OUTPUT" as const,
          status: "CANCELLED" as const,
          text: "用户取消",
          streamKey: "process:cancelled",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{ capabilityVersion: 1, highWatermark: 0, items: [] }}
        liveActivity={liveActivity}
        isActive
      />,
    );

    expect(html.match(/turn-presentation-spinner/g)).toBeNull();
    expect(html).not.toContain('aria-label="状态：进行中"');
    expect(html).toContain('aria-label="状态：已完成"');
    expect(html).toContain('aria-label="状态：失败"');
    expect(html).toContain('aria-label="状态：已取消"');
    expect(html).toContain("lucide-circle-check");
    expect(html).toContain("lucide-circle-x");
    expect(html).toContain("lucide-circle-minus");
  });

  it("renders active and completed model text in the reply area while keeping other live activity in process", () => {
    const initial = createInitialLiveActivityState(runId);
    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{ capabilityVersion: 2, highWatermark: 0, items: [] }}
        liveActivity={{
          ...initial,
          activities: [
            {
              id: "draft-active",
              kind: "MODEL_TEXT",
              status: "ACTIVE",
              text: "正在生成",
              streamKey: "model:1",
              streamSequence: 1,
              runId,
              stepId: "step-1",
            },
            {
              id: "draft-complete",
              kind: "MODEL_TEXT",
              status: "COMPLETED",
              text: "已生成",
              streamKey: "model:2",
              streamSequence: 1,
              runId,
              stepId: "step-2",
            },
            {
              id: "tool-live",
              kind: "MODEL_TOOL_CALL",
              status: "COMPLETED",
              text: "读取文件",
              streamKey: "tool:1",
              streamSequence: 1,
              runId,
              stepId: "step-1",
            },
          ],
        }}
        isActive
      />,
    );
    const process =
      html.match(/<details class="turn-presentation-process"[\s\S]*?<\/details>/u)?.[0] ?? "";
    const reply =
      html.match(/<section class="turn-presentation-final"[\s\S]*?<\/section>/u)?.[0] ?? "";
    expect(reply).toContain("正在生成");
    expect(reply).toContain("已生成");
    expect(process).not.toContain("正在生成");
    expect(process).not.toContain("已生成");
    expect(process).toContain("读取文件");
  });

  it("reconciles v2 drafts by run and step and places durable assistant text by phase", () => {
    const initial = createInitialLiveActivityState(runId);
    const otherRun = createRunId();
    const items = [
      {
        id: "final",
        runId,
        conversationTurnId: "turn-1",
        ordinal: 0,
        status: "COMPLETED" as const,
        createdAt: 1,
        kind: "ASSISTANT" as const,
        phase: "FINAL_ANSWER" as const,
        text: "durable final",
        sourceStepId: "step-final",
      },
      {
        id: "commentary",
        runId,
        conversationTurnId: "turn-1",
        ordinal: 1,
        status: "COMPLETED" as const,
        createdAt: 2,
        kind: "ASSISTANT" as const,
        phase: "COMMENTARY" as const,
        text: "durable commentary",
        sourceStepId: "step-commentary",
      },
      {
        id: "unknown",
        runId,
        conversationTurnId: "turn-1",
        ordinal: 2,
        status: "COMPLETED" as const,
        createdAt: 3,
        kind: "ASSISTANT" as const,
        phase: "UNKNOWN" as const,
        text: "durable unknown",
        sourceStepId: "step-unknown",
      },
    ];
    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{ capabilityVersion: 2, highWatermark: 0, items }}
        liveActivity={{
          ...initial,
          activities: [
            {
              id: "draft-final",
              kind: "MODEL_TEXT",
              status: "COMPLETED",
              text: "duplicate final",
              streamKey: "m:1",
              streamSequence: 1,
              runId,
              stepId: "step-final",
            },
            {
              id: "draft-commentary",
              kind: "MODEL_TEXT",
              status: "COMPLETED",
              text: "duplicate commentary",
              streamKey: "m:2",
              streamSequence: 1,
              runId,
              stepId: "step-commentary",
            },
            {
              id: "draft-other-run",
              kind: "MODEL_TEXT",
              status: "COMPLETED",
              text: "other run draft",
              streamKey: "m:3",
              streamSequence: 1,
              runId: otherRun,
              stepId: "step-unknown",
            },
          ],
        }}
        isActive
      />,
    );
    const process =
      html.match(/<details class="turn-presentation-process"[\s\S]*?<\/details>/u)?.[0] ?? "";
    const reply =
      html.match(/<section class="turn-presentation-final"[\s\S]*?<\/section>/u)?.[0] ?? "";
    expect(reply).toContain("durable final");
    expect(reply).not.toContain("duplicate final");
    expect(process).toContain("durable commentary");
    expect(process).toContain("durable unknown");
    expect(reply).toContain("other run draft");
    expect(process).not.toContain("duplicate commentary");
  });

  it("hides failed and cancelled model drafts but retains non-success terminal summaries", () => {
    const initial = createInitialLiveActivityState(runId);
    const summaries = ["FAILED", "CANCELLED", "TIMEOUT", "COMPLETED"].map((runStatus) => ({
      id: `summary-${runStatus}`,
      runId,
      conversationTurnId: "terminal",
      ordinal: 0,
      status: "COMPLETED" as const,
      createdAt: 1,
      kind: "RUN_SUMMARY" as const,
      runStatus: runStatus as "FAILED" | "CANCELLED" | "TIMEOUT" | "COMPLETED",
      text: `summary ${runStatus}`,
    }));
    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{ capabilityVersion: 2, highWatermark: 0, items: summaries }}
        liveActivity={{
          ...initial,
          terminal: true,
          activities: [
            {
              id: "draft-failed",
              kind: "MODEL_TEXT",
              status: "FAILED",
              text: "failed partial",
              streamKey: "m:1",
              streamSequence: 1,
              runId,
              stepId: "step-1",
            },
            {
              id: "draft-cancelled",
              kind: "MODEL_TEXT",
              status: "CANCELLED",
              text: "cancelled partial",
              streamKey: "m:2",
              streamSequence: 1,
              runId,
              stepId: "step-2",
            },
          ],
        }}
      />,
    );
    expect(html).not.toContain("failed partial");
    expect(html).not.toContain("cancelled partial");
    expect(html).toContain("summary FAILED");
    expect(html).toContain("summary CANCELLED");
    expect(html).toContain("summary TIMEOUT");
    expect(html).toContain("summary COMPLETED");
  });

  it("keeps a completed summary when no durable final answer exists", () => {
    const initial = createInitialLiveActivityState(runId);
    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{
          capabilityVersion: 2,
          highWatermark: 0,
          items: [
            {
              id: "summary",
              runId,
              conversationTurnId: "terminal",
              ordinal: 0,
              status: "COMPLETED",
              createdAt: 1,
              kind: "RUN_SUMMARY",
              runStatus: "COMPLETED",
              text: "完成但无最终答复",
            },
          ],
        }}
        liveActivity={{
          ...initial,
          activities: [
            {
              id: "completed-draft",
              kind: "MODEL_TEXT",
              status: "COMPLETED",
              text: "完成摘要之后的答复草稿",
              streamKey: "model:completed-without-final",
              streamSequence: 1,
              runId,
              stepId: "step-completed-without-final",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("任务结束报告");
    expect(html).toContain("完成但无最终答复");
    expect(html).toContain("完成摘要之后的答复草稿");
  });

  it("renders durable final answers and live drafts as safe Markdown", () => {
    const initial = createInitialLiveActivityState(runId);
    const markdown = [
      "## 结果",
      "",
      "已修改 `apps/web/src/file.ts`。访问 https://example.com/docs 后继续。",
      "",
      "- 第一项",
      "- [外部链接](https://example.com)",
      "",
      "> 引用说明",
      "",
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| 构建 | 通过 |",
      "",
      "```ts",
      "const answer = true;",
      "```",
    ].join("\n");
    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{
          ...presentation(),
          items: presentation().items.map((item) =>
            item.id === "assistant:final" && item.kind === "ASSISTANT"
              ? { ...item, text: markdown }
              : item,
          ),
        }}
        liveActivity={{
          ...initial,
          activities: [
            {
              id: "markdown-draft",
              kind: "MODEL_TEXT",
              status: "ACTIVE",
              text: "### 草稿\n\n运行 `pnpm build`。",
              streamKey: "model:markdown",
              streamSequence: 1,
              runId,
              stepId: "step-draft",
            },
          ],
        }}
      />,
    );
    const reply =
      html.match(/<section class="turn-presentation-final"[\s\S]*?<\/section>/u)?.[0] ?? "";
    const process =
      html.match(/<details class="turn-presentation-process"[\s\S]*?<\/details>/u)?.[0] ?? "";

    expect(reply).toContain("<h2>结果</h2>");
    expect(reply).toContain("<ul>");
    expect(reply).toContain("<blockquote>");
    expect(reply).toContain("<table>");
    expect(reply).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">外部链接</a>',
    );
    expect(reply).toContain('target="_blank"');
    expect(reply).toContain('rel="noopener noreferrer"');
    expect(reply).toContain('<a href="https://example.com/docs"');
    expect(reply).toContain("<code>apps/web/src/file.ts</code>");
    expect(reply).toContain('<pre><code class="language-ts">const answer = true;\n</code></pre>');
    expect(reply).toContain("<h3>草稿</h3>");
    expect(reply).toContain("<code>pnpm build</code>");
    expect(process).toContain("读取 src/index.ts");
    expect(process).toContain('class="turn-presentation-preview">安全预览</pre>');
    expect(process).not.toContain("<h2>");
  });

  it("keeps raw HTML inert and does not create links for unsafe protocols", () => {
    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{
          capabilityVersion: 1,
          highWatermark: 1,
          items: [
            {
              id: "unsafe-final",
              runId,
              conversationTurnId: "turn-unsafe",
              ordinal: 0,
              status: "COMPLETED",
              createdAt: 1,
              kind: "ASSISTANT",
              phase: "FINAL_ANSWER",
              text: '<img src=x onerror="alert(1)"> [危险](javascript:alert%281%29)',
            },
          ],
        }}
      />,
    );
    const reply =
      html.match(/<section class="turn-presentation-final"[\s\S]*?<\/section>/u)?.[0] ?? "";

    expect(reply).not.toContain("<img");
    expect(reply).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(reply).not.toContain('href="javascript:');
    expect(reply).toContain("危险");
  });

  it("opens protocol-relative Markdown links with safe external-link attributes", () => {
    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{
          capabilityVersion: 1,
          highWatermark: 1,
          items: [
            {
              id: "protocol-relative-final",
              runId,
              conversationTurnId: "turn-protocol-relative",
              ordinal: 0,
              status: "COMPLETED",
              createdAt: 1,
              kind: "ASSISTANT",
              phase: "FINAL_ANSWER",
              text: "[协议相对链接](//example.com/protocol)",
            },
          ],
        }}
      />,
    );
    const reply =
      html.match(/<section class="turn-presentation-final"[\s\S]*?<\/section>/u)?.[0] ?? "";

    expect(reply).toContain(
      '<a href="//example.com/protocol" target="_blank" rel="noopener noreferrer">协议相对链接</a>',
    );
  });
});
