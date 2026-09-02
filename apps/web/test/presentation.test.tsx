import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createSessionId, createWorkspaceId, type WorkspaceRef } from "@caelush/protocol";
import { SessionSidebar, sessionDisplayTitle } from "../src/components/session-sidebar.js";
import { PromptComposer, shouldSubmitPrompt } from "../src/components/prompt-composer.js";
import type { SessionCandidate } from "@caelush/client";

const workspace: WorkspaceRef = {
  id: createWorkspaceId(),
  path: "C:\\workspace\\project",
};

describe("Web presentation", () => {
  it("maps keyboard input so Enter submits and Shift+Enter stays multiline", () => {
    expect(shouldSubmitPrompt({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSubmitPrompt({ key: "Enter", shiftKey: true })).toBe(false);
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
});
