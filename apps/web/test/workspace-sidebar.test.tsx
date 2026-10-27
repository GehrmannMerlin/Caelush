import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceId, createSessionId } from "@caelush/protocol";
import { WorkspaceSettingsMenu, WorkspaceSidebar } from "../src/components/workspace-sidebar.js";

describe("WorkspaceSidebar", () => {
  it("disables archive affordances for known active tasks without exposing permanent deletion", () => {
    const workspaceId = createWorkspaceId();
    const sessionId = createSessionId();
    const html = renderToStaticMarkup(
      <WorkspaceSidebar
        workspaces={[
          {
            id: workspaceId,
            canonicalPath: "D:/active",
            displayName: "active",
            createdAt: 1,
            updatedAt: 1,
            lastOpenedAt: 1,
          },
        ]}
        expandedWorkspaceIds={[workspaceId]}
        sessionSummaries={{
          [workspaceId]: [
            {
              session: { id: sessionId } as never,
              lastActivityAt: 1 as never,
              latestRun: { status: "RUNNING", goal: "任务" } as never,
            },
          ],
        }}
        isDraft={false}
        canNavigate
        onToggleWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onAddWorkspace={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onArchiveSession={vi.fn()}
      />,
    );
    expect(html).toContain("请先结束任务，再归档");
    expect(html).not.toContain("彻底删除");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  it("renders expandable Workspaces with scoped Sessions and forget wording", () => {
    const workspaceId = createWorkspaceId();
    const html = renderToStaticMarkup(
      <WorkspaceSidebar
        workspaces={[
          {
            id: workspaceId,
            canonicalPath: "D:/Develop/Caelush",
            displayName: "Caelush",
            createdAt: 1,
            updatedAt: 2,
            lastOpenedAt: 2,
          },
        ]}
        selectedWorkspaceId={workspaceId}
        expandedWorkspaceIds={[workspaceId]}
        sessionSummaries={{ [workspaceId]: [] }}
        selectedSessionId={undefined}
        isDraft={false}
        canNavigate
        onToggleWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onAddWorkspace={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onArchiveSession={vi.fn()}
      />,
    );

    expect(html).toContain("项目");
    expect(html).toContain('class="workspace-sidebar-brand"');
    expect(html).toContain('class="caelush-brand workspace-sidebar-logo"');
    expect(html).toContain('alt="Caelush"');
    expect(html).not.toContain('class="brand-symbol"');
    expect(html).not.toContain('class="brand-name"');
    expect(html).toContain("新建会话");
    expect(html).toContain("归档工作区：Caelush");
    expect(html).toContain("添加工作区");
  });

  it("keeps the account and settings footer outside the project-list scroll region", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSidebar
        workspaces={[]}
        expandedWorkspaceIds={[]}
        sessionSummaries={{}}
        isDraft={false}
        canNavigate
        onToggleWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onAddWorkspace={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onArchiveSession={vi.fn()}
      />,
    );

    expect(html).toMatch(
      /<div class="workspace-sidebar-content">[\s\S]*<ol class="workspace-list">[\s\S]*<\/ol><\/div><div class="workspace-sidebar-footer/,
    );
  });

  it("keeps the sidebar Settings button as a menu trigger", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSidebar
        workspaces={[]}
        expandedWorkspaceIds={[]}
        sessionSummaries={{}}
        isDraft={false}
        canNavigate
        onToggleWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onAddWorkspace={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onArchiveSession={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("模型与配置");
  });

  it("offers only model configuration in the Settings menu", () => {
    const html = renderToStaticMarkup(<WorkspaceSettingsMenu onSelect={vi.fn()} />);

    expect(html).toContain('role="menu"');
    expect(html).toContain('role="menuitem"');
    expect(html).toContain("模型与配置");
    expect(html.match(/role="menuitem"/g)).toHaveLength(1);
  });

  it("offers a separate appearance action only when the Web host supplies it", () => {
    const onOpenAppearance = vi.fn();
    const web = renderToStaticMarkup(
      <WorkspaceSettingsMenu onSelect={vi.fn()} onOpenAppearance={onOpenAppearance} />,
    );
    const desktop = renderToStaticMarkup(<WorkspaceSettingsMenu onSelect={vi.fn()} />);

    expect(web).toContain("模型与配置");
    expect(web).toContain("外观");
    expect(web.match(/role="menuitem"/g)).toHaveLength(2);
    expect(desktop).not.toContain("外观");
  });

  it("renders Desktop account and native actions only when the host injects them", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSidebar
        workspaces={[]}
        expandedWorkspaceIds={[]}
        sessionSummaries={{}}
        isDraft={false}
        canNavigate
        onToggleWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onAddWorkspace={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onArchiveSession={vi.fn()}
        desktopActions={{
          accountHref: "caelush-login://app/?view=account",
          accountProfile: { displayName: "霜华", avatarBytes: new Uint8Array([88]) },
          onCheckUpdates: vi.fn(),
          onLogout: vi.fn(),
        }}
      />,
    );

    expect(html).toContain('href="caelush-login://app/?view=account"');
    expect(html).toContain("霜华");
    expect(html).toContain('src="data:image/webp;base64,WA=="');
    expect(html).not.toContain("Desktop account");
    expect(html).toContain('aria-label="桌面端账户与设置"');
  });

  it("keeps the workspace path in a hoverable card tooltip and puts removal inside the card", () => {
    const workspaceId = createWorkspaceId();
    const html = renderToStaticMarkup(
      <WorkspaceSidebar
        workspaces={[
          {
            id: workspaceId,
            canonicalPath: "D:/Develop/Caelush",
            displayName: "Caelush",
            createdAt: 1,
            updatedAt: 2,
            lastOpenedAt: 2,
          },
        ]}
        selectedWorkspaceId={workspaceId}
        expandedWorkspaceIds={[]}
        sessionSummaries={{}}
        selectedSessionId={undefined}
        isDraft={false}
        canNavigate
        onToggleWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onAddWorkspace={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onArchiveSession={vi.fn()}
      />,
    );

    expect(html).toContain('class="workspace-card"');
    expect(html).toContain('data-folder-path="D:/Develop/Caelush"');
    expect(html).toContain('aria-label="归档工作区：Caelush"');
    expect(html).not.toContain(">D:/Develop/Caelush</small>");
  });
});
