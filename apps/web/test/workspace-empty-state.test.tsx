import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceEmptyState } from "../src/components/workspace-empty-state.js";

describe("WorkspaceEmptyState", () => {
  it("renders the branded landing state when no workspace exists", () => {
    const html = renderToStaticMarkup(
      <WorkspaceEmptyState hasWorkspaces={false} onAddWorkspace={vi.fn()} />,
    );

    expect(html).toContain('class="workspace-empty-state workspace-empty-state--no-workspace"');
    expect(html).toContain('class="workspace-empty-logo"');
    expect(html).toContain('alt="Caelush"');
    expect(html).toContain("保持对未知的探索热情");
    expect(html).toContain("创建工作区");
    expect(html).not.toContain("还没有工作区");
    expect(html).not.toContain("输入任务");
    expect(html).not.toContain("workspace-dialog");
    expect(html).not.toContain("WORKSPACE_MISSING");
  });

  it("keeps workspace selection guidance when workspaces exist", () => {
    const html = renderToStaticMarkup(
      <WorkspaceEmptyState hasWorkspaces onAddWorkspace={vi.fn()} />,
    );

    expect(html).toContain("请选择一个工作区");
    expect(html).toContain("添加工作区");
    expect(html).not.toContain("workspace-empty-state--no-workspace");
  });
});
