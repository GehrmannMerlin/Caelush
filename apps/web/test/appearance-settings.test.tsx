import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsSurface } from "../src/components/settings-surface.js";
import { WorkspaceSidebar } from "../src/components/workspace-sidebar.js";

describe("appearance settings", () => {
  it("keeps the model configuration dialog focused on models and API", () => {
    const html = renderToStaticMarkup(
      <SettingsSurface
        providers={[]}
        models={[]}
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).toContain("模型与 API");
    expect(html).not.toContain("外观");
    expect(html).not.toContain("颜色模式");
    expect(html).not.toContain('type="radio"');
  });

  it("uses the white Caelush logo in the dark workbench without changing its brand slot", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSidebar
        workspaces={[]}
        expandedWorkspaceIds={[]}
        sessionSummaries={{}}
        isDraft={false}
        canNavigate
        theme="dark"
        onToggleWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
        onAddWorkspace={vi.fn()}
        onArchiveWorkspace={vi.fn()}
        onArchiveSession={vi.fn()}
      />,
    );

    expect(html).toContain('class="workspace-sidebar-brand"');
    expect(html).toContain('class="caelush-brand workspace-sidebar-logo"');
    expect(html).toContain('data-caelush-brand-theme="dark"');
    expect(html).toContain("caelush-logo-white");
  });
});
