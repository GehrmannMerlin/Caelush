import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialLiveActivityState,
  createInitialTimelineState,
  type ModelWaitState,
} from "@caelush/client";
import {
  createRunId,
  createStepId,
  createToolInvocationId,
  type SessionTurnPresentationResponse,
} from "@caelush/protocol";

import {
  flattenTurnsForLegacyRenderer,
  TurnPresentationFeed,
} from "../src/components/turn-presentation-feed.js";
import { ReconnectBanner } from "../src/components/reconnect-banner.js";
import { modelWaitMessage } from "../src/components/model-wait-presentation.js";

const runId = createRunId();
const toolInvocationId = createToolInvocationId();
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
  it("renders a live non-streaming Tool as an invocation activity and durable file effects", () => {
    const liveActivity = {
      ...createInitialLiveActivityState(runId),
      activities: [
        {
          id: `tool-activity:${toolInvocationId}`,
          kind: "TOOL_ACTIVITY" as const,
          status: "ACTIVE" as const,
          toolPhase: "RUNNING" as const,
          category: "EDIT" as const,
          toolName: "apply_patch",
          title: "编辑文件",
          text: "应用已验证的工作区补丁",
          streamKey: "durable:run",
          streamSequence: 0,
          runId,
          toolInvocationId,
          effects: [
            {
              type: "FILE_CHANGE" as const,
              path: "login.html",
              changeType: "CREATED" as const,
              additions: 214,
              deletions: 0,
            },
          ],
        },
      ],
    };
    const liveHtml = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{
          capabilityVersion: 3,
          turns: [
            {
              runId,
              conversationTurnId: "turn-1",
              runStatus: "RUNNING",
              openedAt: 1,
              highWatermark: 0,
              items: [],
            },
          ],
        }}
        liveActivity={liveActivity}
      />,
    );

    expect(liveHtml).toContain("正在编辑文件");
    expect(liveHtml).toContain('data-conversation-turn-id="turn-1"');
    expect(liveHtml).toContain("login.html");
    expect(liveHtml).toContain("新建");
    expect(liveHtml).toContain("+214");

    const durable = {
      capabilityVersion: 3,
      turns: [
        {
          runId,
          conversationTurnId: "turn-1",
          runStatus: "COMPLETED",
          openedAt: 1,
          highWatermark: 4,
          items: [
            {
              id: `tool-activity:${toolInvocationId}`,
              runId,
              conversationTurnId: "turn-1",
              ordinal: 0,
              status: "COMPLETED",
              createdAt: 1,
              kind: "TOOL",
              toolInvocationId,
              toolName: "apply_patch",
              category: "EDIT",
              phase: "COMPLETED",
              title: "编辑文件",
              summary: "补丁已应用",
              facts: [],
              effects: [
                {
                  type: "FILE_CHANGE",
                  path: "login.html",
                  changeType: "CREATED",
                  additions: 214,
                  deletions: 0,
                },
              ],
            },
          ],
        },
      ],
    } as SessionTurnPresentationResponse;
    const durableHtml = renderToStaticMarkup(<TurnPresentationFeed presentation={durable} />);
    expect(durableHtml).toContain("login.html");
    expect(durableHtml).toContain("新建");
    expect(durableHtml).toContain("+214");
    expect(durableHtml).not.toContain("*** Begin Patch");

    const reconciledHtml = renderToStaticMarkup(
      <TurnPresentationFeed presentation={durable} liveActivity={liveActivity} />,
    );
    expect(reconciledHtml).toContain("login.html");
    expect(reconciledHtml).not.toContain("turn-presentation-live-item");
    expect(reconciledHtml).not.toContain("正在编辑文件");
  });

  it("keeps durable approval waiting visible after the live row is reconciled", () => {
    const waitingPresentation = {
      capabilityVersion: 3,
      turns: [
        {
          runId,
          conversationTurnId: "turn-approval",
          runStatus: "WAITING_APPROVAL",
          openedAt: 1,
          highWatermark: 2,
          items: [
            {
              id: "tool-approval",
              runId,
              conversationTurnId: "turn-approval",
              ordinal: 0,
              status: "STREAMING",
              createdAt: 1,
              kind: "TOOL",
              toolInvocationId: "invocation-approval",
              toolName: "apply_patch",
              category: "EDIT",
              phase: "WAITING_APPROVAL",
              title: "编辑文件",
              summary: "等待批准后执行",
              facts: [],
              effects: [],
            },
          ],
        },
      ],
    } as SessionTurnPresentationResponse;

    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={waitingPresentation}
        activeRun={{ id: runId, status: "WAITING_APPROVAL" }}
      />,
    );

    expect(html).toContain("等待批准：编辑文件");
    expect(html).toContain("等待批准后执行");
  });

  it("adapts V3 Turns for the legacy renderer without changing their Run grouping order", () => {
    const runOneId = createRunId();
    const runTwoId = createRunId();
    const response = {
      capabilityVersion: 3,
      turns: [
        {
          runId: runOneId,
          conversationTurnId: "turn-one",
          runStatus: "COMPLETED",
          openedAt: 1,
          closedAt: 2,
          highWatermark: 85,
          items: [
            {
              id: "run-one-user",
              runId: runOneId,
              conversationTurnId: "turn-one",
              ordinal: 0,
              status: "COMPLETED",
              createdAt: 1,
              kind: "USER",
              text: "first",
            },
            {
              id: "run-one-final",
              runId: runOneId,
              conversationTurnId: "turn-one",
              ordinal: 1,
              status: "COMPLETED",
              createdAt: 2,
              kind: "ASSISTANT",
              phase: "FINAL_ANSWER",
              text: "first done",
            },
          ],
        },
        {
          runId: runTwoId,
          conversationTurnId: "turn-two",
          runStatus: "COMPLETED",
          openedAt: 3,
          closedAt: 4,
          highWatermark: 7,
          items: [
            {
              id: "run-two-user",
              runId: runTwoId,
              conversationTurnId: "turn-two",
              ordinal: 0,
              status: "COMPLETED",
              createdAt: 3,
              kind: "USER",
              text: "second",
            },
            {
              id: "run-two-final",
              runId: runTwoId,
              conversationTurnId: "turn-two",
              ordinal: 1,
              status: "COMPLETED",
              createdAt: 4,
              kind: "ASSISTANT",
              phase: "FINAL_ANSWER",
              text: "second done",
            },
          ],
        },
      ],
    } as SessionTurnPresentationResponse;

    expect(flattenTurnsForLegacyRenderer(response).map((item) => item.id)).toEqual([
      "run-one-user",
      "run-one-final",
      "run-two-user",
      "run-two-final",
    ]);
  });

  it("shows animated thinking text while an LLM is active without transient output", () => {
    const timeline = {
      ...createInitialTimelineState(runId),
      activeLlm: [
        {
          id: "llm:step-thinking:deepseek:deepseek-flash",
          kind: "LLM" as const,
          title: "Model",
          text: "deepseek/deepseek-flash",
          status: "RUNNING" as const,
          stepId: "step-thinking",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{ capabilityVersion: 2, highWatermark: 1, items: [] }}
        liveActivity={createInitialLiveActivityState(runId)}
        timeline={timeline}
        isActive
      />,
    );
    const thinking =
      html.match(/<section class="turn-presentation-thinking"[\s\S]*?<\/section>/u)?.[0] ?? "";

    expect(thinking).toContain('class="turn-presentation-thinking-title"');
    expect(thinking).toContain(">思考中<");
    expect(thinking).not.toContain('class="turn-presentation-thinking-detail"');
    expect(thinking).not.toContain("正在等待模型响应");
    expect(thinking).toContain('role="status"');
    expect(thinking).toContain('aria-live="polite"');
    expect(thinking).not.toContain("<svg");
  });

  it("shows accurate Provider silence timing without conflating local SSE reconnect", () => {
    const now = new Date(2026, 9, 4, 12, 0, 35).getTime();
    const startedAt = new Date(2026, 9, 4, 12, 0, 0).getTime();
    const liveActivity = {
      ...createInitialLiveActivityState(runId),
      modelWait: {
        runId,
        stepId: createStepId(),
        phase: "NO_RECENT_ACTIVITY" as const,
        lastActivityAt: startedAt,
        idleForMs: 35_000,
        idleTimeoutMs: 300_000,
        providerEventReceived: false,
      },
    };
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const html = renderToStaticMarkup(
        <>
          <ReconnectBanner state="RECONNECTING" attempt={1} />
          <TurnPresentationFeed
            presentation={{ capabilityVersion: 2, highWatermark: 1, items: [] }}
            liveActivity={liveActivity}
            timeline={createInitialTimelineState(runId)}
            isActive
          />
        </>,
      );

      expect(html).toContain("正在重新连接本地 Agent 服务");
      expect(html).toContain("模型近期没有返回新数据，仍在等待");
      expect(html).not.toContain("请求开始时间");
      expect(html).not.toContain("已等待");
      expect(html).not.toContain("连接不健康");
      expect(html).not.toContain("Provider 连接异常");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the concise thinking label until 30 seconds, then labels the model wait", () => {
    const startedAt = new Date(2026, 9, 4, 12, 0, 0).getTime();
    const wait: ModelWaitState = {
      runId,
      phase: "WAITING_PROVIDER",
      lastActivityAt: startedAt,
      idleForMs: 0,
      idleTimeoutMs: 300_000,
      providerEventReceived: false,
    };

    expect(modelWaitMessage(wait, startedAt + 29_999)).toEqual({ title: "思考中", detail: "" });
    expect(modelWaitMessage(wait, startedAt + 30_000)).toEqual({
      title: "正在等待模型响应",
      detail: "",
    });
  });

  it("shows the five-minute idle termination notice as text, not a loading mark", () => {
    const liveActivity = {
      ...createInitialLiveActivityState(runId),
      modelWait: {
        runId,
        stepId: createStepId(),
        phase: "CANCELLING_IDLE_STREAM" as const,
        lastActivityAt: 1_700_000_000_000,
        idleForMs: 300_000,
        idleTimeoutMs: 300_000,
        providerEventReceived: false,
      },
    };
    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={{ capabilityVersion: 2, highWatermark: 1, items: [] }}
        liveActivity={liveActivity}
        timeline={createInitialTimelineState(runId)}
        isActive
      />,
    );
    const thinking =
      html.match(/<section class="turn-presentation-thinking"[\s\S]*?<\/section>/u)?.[0] ?? "";

    expect(thinking).toContain("Provider 连续 5 分钟没有返回数据，正在终止本次请求");
    expect(thinking).toContain('role="status"');
    expect(thinking).not.toContain("<svg");
  });

  it("uses the configured idle duration in the termination notice", () => {
    const wait: ModelWaitState = {
      runId,
      phase: "CANCELLING_IDLE_STREAM",
      lastActivityAt: 1_700_000_000_000,
      idleForMs: 1_250,
      idleTimeoutMs: 1_250,
      providerEventReceived: false,
    };

    expect(modelWaitMessage(wait, wait.lastActivityAt).detail).toBe(
      "Provider 连续 1.3 秒没有返回数据，正在终止本次请求",
    );
  });

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

  it("places task elapsed time beside the logo and freezes it at the matching Run summary", () => {
    const startedAt = new Date(2026, 9, 4, 12, 0, 0).getTime();
    const completedAt = startedAt + 125_000;
    const completedPresentation = {
      ...presentation(),
      items: presentation().items.map((item) =>
        item.kind === "USER"
          ? { ...item, createdAt: startedAt }
          : item.kind === "RUN_SUMMARY"
            ? { ...item, createdAt: completedAt }
            : item,
      ),
    };

    vi.useFakeTimers();
    vi.setSystemTime(completedAt + 60_000);
    try {
      const html = renderToStaticMarkup(
        <TurnPresentationFeed presentation={completedPresentation} isActive={false} />,
      );
      const summary =
        html.match(/<summary class="turn-presentation-summary">[\s\S]*?<\/summary>/u)?.[0] ?? "";

      expect(summary.indexOf('alt="Caelush"')).toBeLessThan(
        summary.indexOf('class="turn-presentation-task-elapsed"'),
      );
      expect(summary).toContain('class="turn-presentation-task-elapsed"');
      expect(summary).toContain("用时 2分5秒");
      expect(summary).not.toContain("请求开始时间");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats the matching Run summary as the end time even while the active flag lags", () => {
    const startedAt = new Date(2026, 9, 4, 12, 0, 0).getTime();
    const completedAt = startedAt + 125_000;
    const completedPresentation = {
      ...presentation(),
      items: presentation().items.map((item) =>
        item.kind === "USER"
          ? { ...item, createdAt: startedAt }
          : item.kind === "RUN_SUMMARY"
            ? { ...item, createdAt: completedAt }
            : item,
      ),
    };

    vi.useFakeTimers();
    vi.setSystemTime(completedAt + 60_000);
    try {
      const html = renderToStaticMarkup(
        <TurnPresentationFeed presentation={completedPresentation} isActive />,
      );
      const summary =
        html.match(/<summary class="turn-presentation-summary">[\s\S]*?<\/summary>/u)?.[0] ?? "";

      expect(summary).toContain("用时 2分5秒");
      expect(summary).not.toContain("用时 3分5秒");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows that a final answer is still waiting for verification while the server Run is VERIFYING", () => {
    const verifyingPresentation = {
      ...presentation(),
      items: presentation().items.filter((item) => item.kind !== "RUN_SUMMARY"),
    };

    const html = renderToStaticMarkup(
      <TurnPresentationFeed
        presentation={verifyingPresentation}
        activeRun={{ id: runId, status: "VERIFYING" }}
        isActive
      />,
    );

    expect(html).toContain("检查完成，项目结构正常。");
    expect(html).toContain("回复已生成，正在等待校验结果");
  });

  it("shows the elapsed time beside a running verification item", () => {
    const startedAt = new Date(2026, 9, 4, 12, 0, 0).getTime();
    const verifyingPresentation = {
      ...presentation(),
      items: [
        ...presentation().items.filter((item) => item.kind !== "RUN_SUMMARY"),
        {
          id: "verification:check-1",
          runId,
          conversationTurnId: "turn-1",
          ordinal: 4,
          status: "STREAMING" as const,
          createdAt: startedAt,
          kind: "VERIFICATION" as const,
          verificationId: "check-1",
          title: "类型检查",
          summary: "正在运行包类型检查",
        },
      ],
    };

    vi.useFakeTimers();
    vi.setSystemTime(startedAt + 65_000);
    try {
      const html = renderToStaticMarkup(
        <TurnPresentationFeed
          presentation={verifyingPresentation}
          activeRun={{ id: runId, status: "VERIFYING" }}
          isActive
        />,
      );
      const verification =
        html.match(
          /class="turn-presentation-item turn-presentation-item--verification[\s\S]*?<\/article>/u,
        )?.[0] ?? "";

      expect(verification).toContain("类型检查");
      expect(verification).toContain('class="turn-presentation-verification-elapsed"');
      expect(verification).toContain("用时 1分5秒");
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes elapsed time from the server FAILED status when the legacy active flag lags", () => {
    const startedAt = new Date(2026, 9, 4, 12, 0, 0).getTime();
    const lastActivityAt = startedAt + 45_000;
    const failedPresentation = {
      ...presentation(),
      items: [
        ...presentation()
          .items.filter((item) => item.kind !== "RUN_SUMMARY")
          .map((item) => (item.kind === "USER" ? { ...item, createdAt: startedAt } : item)),
        {
          id: "verification:failed-check",
          runId,
          conversationTurnId: "turn-1",
          ordinal: 4,
          status: "FAILED" as const,
          createdAt: lastActivityAt,
          kind: "VERIFICATION" as const,
          verificationId: "failed-check",
          title: "类型检查",
          summary: "检查命令无法启动",
        },
      ],
    };

    vi.useFakeTimers();
    vi.setSystemTime(startedAt + 65_000);
    try {
      const html = renderToStaticMarkup(
        <TurnPresentationFeed
          presentation={failedPresentation}
          activeRun={{ id: runId, status: "FAILED" }}
          isActive
        />,
      );
      const summary =
        html.match(/<summary class="turn-presentation-summary">[\s\S]*?<\/summary>/u)?.[0] ?? "";

      expect(summary).toContain("用时 45秒");
      expect(summary).not.toContain("用时 1分5秒");
    } finally {
      vi.useRealTimers();
    }
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

  it("renders active and completed model text in the process disclosure alongside other live activity", () => {
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
    const processStart = html.indexOf('<details class="turn-presentation-process"');
    const replyStart = html.indexOf('<section class="turn-presentation-final"');
    const process =
      processStart < 0
        ? ""
        : html.slice(processStart, replyStart > processStart ? replyStart : html.length);
    const reply =
      html.match(/<section class="turn-presentation-final"[\s\S]*?<\/section>/u)?.[0] ?? "";
    expect(process).toContain("正在生成");
    expect(process).toContain("已生成");
    expect(reply).not.toContain("正在生成");
    expect(reply).not.toContain("已生成");
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
    expect(process).toContain("other run draft");
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
              phase: "COMMENTARY",
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
    const processStart = html.indexOf('<details class="turn-presentation-process"');
    const replyStart = html.indexOf('<section class="turn-presentation-final"');
    const process =
      processStart >= 0 && replyStart > processStart ? html.slice(processStart, replyStart) : "";

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
    expect(process).toContain("<h3>草稿</h3>");
    expect(process).toContain("<code>pnpm build</code>");
    expect(reply).not.toContain("草稿");
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
