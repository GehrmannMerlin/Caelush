import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { WorkspaceSettingsMenu, WorkspaceSidebar } from "../src/components/workspace-sidebar.js";

describe("WorkspaceSidebar", () => {
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
        onForgetWorkspace={vi.fn()}
      />,
    );

    expect(html).toContain("项目");
    expect(html).toContain('class="workspace-sidebar-brand"');
    expect(html).toContain('class="workspace-sidebar-logo"');
    expect(html).toContain('alt="Caelush"');
    expect(html).not.toContain('class="brand-symbol"');
    expect(html).not.toContain('class="brand-name"');
    expect(html).toContain("新建会话");
    expect(html).toContain("从 Caelush 中移除");
    expect(html).toContain("添加工作区");
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
        onForgetWorkspace={vi.fn()}
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
        onForgetWorkspace={vi.fn()}
      />,
    );

    expect(html).toContain('class="workspace-card"');
    expect(html).toContain('data-folder-path="D:/Develop/Caelush"');
    expect(html).toContain('aria-label="从 Caelush 中移除"');
    expect(html).not.toContain(">D:/Develop/Caelush</small>");
  });
});
