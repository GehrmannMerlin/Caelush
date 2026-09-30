import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createSessionId, createWorkspaceId, type WorkspaceRef } from "@caelush/protocol";
import { SessionSidebar, sessionDisplayTitle } from "../src/components/session-sidebar.js";
import { PromptComposer, shouldSubmitPrompt } from "../src/components/prompt-composer.js";
import { SettingsSurface } from "../src/components/settings-surface.js";
import { createInitialTimelineState, type SessionCandidate } from "@caelush/client";
import type { ProviderView } from "@caelush/protocol";
import { SessionWorkspace } from "../src/components/session-workspace.js";
import { hasScrollableSessionContent } from "../src/app.js";

const workspace: WorkspaceRef = {
  id: createWorkspaceId(),
  path: "C:\\workspace\\project",
};

describe("Web presentation", () => {
  it("locks the workspace rail until a session has visible conversation content", () => {
    expect(
      hasScrollableSessionContent({
        history: [],
        turnPresentation: undefined,
        activeRun: undefined,
        activeRuns: [],
        approvalState: undefined,
        controlMode: "NONE",
      }),
    ).toBe(false);

    expect(
      hasScrollableSessionContent({
        history: [{ id: "history-1", kind: "USER", text: "检查项目" }],
        turnPresentation: undefined,
        activeRun: undefined,
        activeRuns: [],
        approvalState: undefined,
        controlMode: "NONE",
      }),
    ).toBe(true);
  });

  it("maps keyboard input so Enter submits and Shift+Enter stays multiline", () => {
    expect(shouldSubmitPrompt({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSubmitPrompt({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmitPrompt({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitPrompt({ key: "Escape", shiftKey: false })).toBe(false);
  });

  it("renders a real-data session sidebar without product areas from later phases", () => {
    const session = {
      id: createSessionId(),
      defaultWorkspace: workspace,
      createdAt: 1,
      updatedAt: 2,
      metadata: {},
    };
    const candidate: SessionCandidate = {
      session,
      latestRun: { goal: "修复登录接口偶发 500", status: "COMPLETED", finishedAt: 2 },
      lastActivityAt: 2,
    };
    const html = renderToStaticMarkup(
      <SessionSidebar
        candidates={[candidate]}
        selectedSessionId={session.id}
        isDraft={false}
        canInteract
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );

    expect(html).toContain("新建会话");
    expect(html).toContain("修复登录接口偶发 500");
    expect(html).not.toContain("Inspector");
    expect(html).not.toContain("Timeline");
  });

  it("uses latest Run goal before Session title and bounds the displayed title", () => {
    const candidate: SessionCandidate = {
      session: {
        id: createSessionId(),
        title: "Session title",
        defaultWorkspace: workspace,
        createdAt: 1,
        updatedAt: 2,
        metadata: {},
      },
      latestRun: { goal: "first line\nsecond line", status: "RUNNING", createdAt: 2 },
      lastActivityAt: 2,
    };

    expect(sessionDisplayTitle(candidate)).toBe("first line");
  });

  it.each([
    ["RUNNING", "运行中"],
    ["WAITING_APPROVAL", "等待审批"],
    ["COMPLETED", "已完成"],
    ["FAILED", "失败"],
  ] as const)(
    "renders %s as an accessible open-source SVG icon without a visible status subtitle",
    (status, label) => {
      const session = {
        id: createSessionId(),
        defaultWorkspace: workspace,
        createdAt: 1,
        updatedAt: 2,
        metadata: {},
      };
      const html = renderToStaticMarkup(
        <SessionSidebar
          candidates={[
            {
              session,
              latestRun: { goal: "状态测试", status },
              lastActivityAt: 2,
            },
          ]}
          selectedSessionId={session.id}
          isDraft={false}
          canInteract
          onNewSession={vi.fn()}
          onSelectSession={vi.fn()}
        />,
      );

      expect(html).toContain(`class="session-status-icon`);
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain("<svg");
      expect(html).not.toContain(`>${label}<`);
    },
  );

  it("keeps the sidebar compact and exposes only one new-session action", () => {
    const session = {
      id: createSessionId(),
      defaultWorkspace: workspace,
      createdAt: 1,
      updatedAt: 2,
      metadata: {},
    };
    const html = renderToStaticMarkup(
      <SessionSidebar
        candidates={[]}
        selectedSessionId={undefined}
        isDraft={false}
        canInteract
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );

    expect((html.match(/新建会话/g) ?? []).length).toBe(1);
    expect(html).toContain("还没有会话");
    expect(html).not.toContain("Inspector");
    expect(html).not.toContain("Terminal");
  });

  it("renders an icon-only send control inside the prompt composer", () => {
    const html = renderToStaticMarkup(
      <PromptComposer
        disabled={false}
        submission="IDLE"
        error={undefined}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(html).toContain("输入任务");
    expect(html).toContain('aria-label="发送任务"');
    expect(html).toContain("prompt-submit-button--icon");
    expect(html).toContain("<svg");
    expect(html).not.toContain("运行 →");
    expect(html).not.toContain("附件");
    expect(html).not.toContain("@引用");
  });

  it("keeps the prompt editable and the model control available before a model is selected", () => {
    const html = renderToStaticMarkup(
      <PromptComposer
        disabled={false}
        modelReady={false}
        submission="IDLE"
        modelPicker={<button type="button">配置模型</button>}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(html).toContain("配置模型");
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(
      /<button[^>]*class="prompt-submit-button prompt-submit-button--icon"[^>]*disabled/,
    );
  });

  it("keeps model selection immediately before the send control", () => {
    const html = renderToStaticMarkup(
      <PromptComposer
        disabled={false}
        modelReady={true}
        submission="IDLE"
        modelPicker={<button type="button">MODEL_PICKER</button>}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(html.indexOf("prompt-hint")).toBeLessThan(html.indexOf("MODEL_PICKER"));
    expect(html.indexOf("MODEL_PICKER")).toBeLessThan(html.indexOf('aria-label="发送任务"'));
  });

  it("renders Settings as one modal panel with the provider chooser inside it", () => {
    const provider: ProviderView = {
      id: "deepseek",
      displayName: "DeepSeek",
      credentialConfigured: false,
      credentialSource: "NONE",
      credentialWritable: true,
      discoveryState: "NOT_CONFIGURED",
    };
    const html = renderToStaticMarkup(
      <SettingsSurface
        providers={[provider]}
        models={[]}
        onClose={vi.fn()}
        onConnect={vi.fn(async () => true)}
        onDisconnect={vi.fn(async () => true)}
      />,
    );

    expect(html).toContain('class="settings-surface-panel"');
    expect(html).toContain("模型与 API");
    expect(html).toContain("DeepSeek");
  });

  it("keeps the sidebar Settings control readable with black text and icon", () => {
    const styles = readFileSync(
      fileURLToPath(new URL("../src/styles.css", import.meta.url)),
      "utf8",
    );
    const finalSettingsRule = styles.slice(
      styles.lastIndexOf(".workspace-sidebar .workspace-settings-button"),
    );

    expect(finalSettingsRule).toMatch(/color:\s*#111827/);
  });

  it("renders user messages as right-aligned bubble content", () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="认证修复"
        history={[{ id: "history-1", kind: "USER", text: "修复登录" }]}
        timeline={createInitialTimelineState()}
        composer={<div>COMPOSER_MARKER</div>}
      />,
    );

    expect(html).toContain('class="conversation-bubble conversation-bubble--user"');
    expect(html).toContain("修复登录");
  });

  it("does not render an author label above user message bubbles", () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="认证修复"
        history={[
          { id: "history-user", kind: "USER", text: "修复登录" },
          { id: "history-report", kind: "RUN_TERMINAL", text: "任务结束报告" },
        ]}
        timeline={createInitialTimelineState()}
        composer={<div>COMPOSER_MARKER</div>}
      />,
    );

    expect(html).not.toContain('class="conversation-author">你</p>');
    expect(html).toContain('class="conversation-author">任务结束报告</p>');
  });

  it("does not show an empty execution process before the first task", () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="新会话"
        history={[]}
        timeline={createInitialTimelineState()}
        composer={<div>COMPOSER_MARKER</div>}
      />,
    );

    expect(html).not.toContain("执行过程");
  });

  it("renders a centered branded welcome state for a pristine session", () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="新会话"
        history={[]}
        timeline={createInitialTimelineState()}
        composer={<div>COMPOSER_MARKER</div>}
      />,
    );

    expect(html).toContain('class="conversation-welcome"');
    expect(html).toContain('alt="Caelush"');
    expect(html).toContain("保持对未知的探索热情");
    expect(html).not.toContain("在这个会话中输入第一条任务。");
    expect(html).not.toContain('id="session-workspace-title"');
  });

  it("keeps the session title once a conversation has started", () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="认证修复"
        history={[{ id: "history-user", kind: "USER", text: "修复登录" }]}
        timeline={createInitialTimelineState()}
        composer={<div>COMPOSER_MARKER</div>}
      />,
    );

    expect(html).toContain('id="session-workspace-title"');
    expect(html).toContain("认证修复");
    expect(html).not.toContain("保持对未知的探索热情");
  });

  it("places the projected timeline after history and before the composer", () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="认证修复"
        history={[{ id: "history-1", kind: "USER", text: "修复登录" }]}
        timeline={createInitialTimelineState()}
        composer={<div>COMPOSER_MARKER</div>}
      />,
    );

    expect(html.indexOf("修复登录")).toBeLessThan(html.indexOf("执行过程"));
    expect(html.indexOf("执行过程")).toBeLessThan(html.indexOf("COMPOSER_MARKER"));
  });

  it("keeps conversation content inside its own scroll region", () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="长上下文"
        history={[{ id: "history-1", kind: "USER", text: "检查项目" }]}
        timeline={createInitialTimelineState()}
        composer={<div>COMPOSER_MARKER</div>}
      />,
    );

    expect(html).toContain('class="session-scroll"');
    expect(html.indexOf('class="session-scroll"')).toBeLessThan(html.indexOf("COMPOSER_MARKER"));
  });
});
