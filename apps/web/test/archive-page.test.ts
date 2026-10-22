import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createSessionId, type ArchiveSessionItem } from "@caelush/protocol";
import { ArchivePageView } from "../src/components/archive-page.js";
import { ArchiveHistory } from "../src/components/archive-history.js";
describe("archive page presentation", () => {
  it("shows tabs, search, unknown dates and parent restoration instead of editable controls", () => {
    const sessionId = createSessionId();
    const item = {
      sessionId,
      title: "历史",
      archivedAt: null,
      state: {
        target: { type: "SESSION", sessionId },
        archived: true,
        parentWorkspace: {
          workspaceId: "parent",
          archive: { archiveId: "episode", archivedAt: null, reason: "USER" },
        },
        restoreDisposition: "PARENT_ARCHIVED",
      },
      group: { key: "parent", displayName: "项目", matchedCount: 1 },
    } as ArchiveSessionItem;
    const state = {
      tab: "SESSIONS" as const,
      sessionFilter: {},
      workspaceFilter: {},
      status: "READY" as const,
      sessions: {
        items: [item],
        matchedCount: 1,
        totalCounts: { sessions: 1, workspaces: 1 },
        catalogRevision: 1,
      },
    };
    const html = renderToStaticMarkup(
      createElement(ArchivePageView, {
        state,
        actions: {
          setTab: vi.fn(),
          setFilter: vi.fn(),
          refresh: vi.fn(),
          loadMore: vi.fn(),
          restore: vi.fn(),
          previewDeletion: vi.fn(),
          openHistory: vi.fn(),
        },
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain("已归档");
    expect(html).toContain("搜索已归档会话");
    expect(html).toContain("归档时间未知");
    expect(html).toContain("先恢复工作区");
    expect(html).toContain("彻底删除会话");
    expect(html).toContain("删除全部已归档会话");
  });
  it("renders safe public history without a composer or custom metadata", () => {
    const html = renderToStaticMarkup(
      createElement(ArchiveHistory, {
        title: "历史",
        entries: [
          {
            id: "custom",
            runId: "run" as never,
            conversationTurnId: "turn",
            createdAt: 1 as never,
            kind: "CUSTOM",
            presentationType: "fixture",
            label: "公开标签",
            text: "公开正文",
            metadata: { private: "hidden-marker" },
          },
        ],
        loading: false,
        hasMore: false,
        onLoadMore: vi.fn(),
        onBack: vi.fn(),
      }),
    );
    expect(html).toContain("返回已归档");
    expect(html).toContain("公开正文");
    expect(html).not.toContain("hidden-marker");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("发送");
  });
});
