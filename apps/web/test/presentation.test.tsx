import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createSessionId, createWorkspaceId, type WorkspaceRef } from "@caelush/protocol";
import { SessionSidebar, sessionDisplayTitle } from "../src/components/session-sidebar.js";
import { PromptComposer, shouldSubmitPrompt } from "../src/components/prompt-composer.js";
import { createInitialTimelineState, type SessionCandidate } from "@caelush/client";
import { SessionWorkspace } from "../src/components/session-workspace.js";

const workspace: WorkspaceRef = {
  id: createWorkspaceId(),
  path: "C:\\workspace\\project",
};

describe("Web presentation", () => {
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
    ["RUNNING", "运行中", "●"],
    ["WAITING_APPROVAL", "等待审批", "!"],
    ["COMPLETED", "已完成", "✓"],
    ["FAILED", "失败", "×"],
  ] as const)(
    "renders %s as an accessible icon without a visible status subtitle",
    (status, label, glyph) => {
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
      expect(html).toContain(`>${glyph}</span>`);
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

  it("renders a text-only prompt composer", () => {
    const html = renderToStaticMarkup(
      <PromptComposer
        disabled={false}
        submission="IDLE"
        error={undefined}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(html).toContain("输入任务");
    expect(html).toContain("运行");
    expect(html).not.toContain("附件");
    expect(html).not.toContain("@引用");
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
});
