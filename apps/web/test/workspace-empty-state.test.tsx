import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceEmptyState } from "../src/components/workspace-empty-state.js";

describe("WorkspaceEmptyState", () => {
  it("renders the centered brand, workspace action, and composer when no workspace exists", () => {
    const html = renderToStaticMarkup(
      <WorkspaceEmptyState
        hasWorkspaces={false}
        onAddWorkspace={vi.fn()}
        composer={<div>COMPOSER_MARKER</div>}
      />,
    );

    expect(html).toContain('class="workspace-empty-state workspace-empty-state--no-workspace"');
    expect(html).toContain('class="conversation-start-brand"');
    expect(html).toContain('alt="Caelush"');
    expect(html).not.toContain("保持对未知的探索热情");
    expect(html).toContain("添加工作区");
    expect(html).toContain("COMPOSER_MARKER");
    expect(html).not.toContain("还没有工作区");
    expect(html).not.toContain("输入任务");
    expect(html).not.toContain("workspace-dialog");
    expect(html).not.toContain("WORKSPACE_MISSING");
  });

  it("keeps the start panel available when no workspace is selected", () => {
    const html = renderToStaticMarkup(
      <WorkspaceEmptyState hasWorkspaces onAddWorkspace={vi.fn()} />,
    );

    expect(html).toContain("选择工作区开始对话");
    expect(html).toContain("添加工作区");
    expect(html).toContain("workspace-empty-state--no-workspace");
  });
});
