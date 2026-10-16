import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsSurface } from "../src/components/settings-surface.js";
import { WorkspaceSidebar } from "../src/components/workspace-sidebar.js";

describe("appearance settings", () => {
  it("offers accessible light, dark, and system appearance options beside model settings", () => {
    const html = renderToStaticMarkup(
      <SettingsSurface
        providers={[]}
        models={[]}
        onClose={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        appearanceSnapshot={{ preference: "system", resolvedTheme: "dark", revision: 2 }}
        onPreferenceChange={vi.fn()}
      />,
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain("模型与 API");
    expect(html).toContain("外观");
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('checked="" value="system"');
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain("浅色");
    expect(html).toContain("深色");
    expect(html).toContain("跟随系统");
    expect(html).toContain("当前使用深色");
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
