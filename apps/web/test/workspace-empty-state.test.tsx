import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceEmptyState } from "../src/components/workspace-empty-state.js";

describe("WorkspaceEmptyState", () => {
  it("guides an empty registry to add a workspace", () => {
    const html = renderToStaticMarkup(
      <WorkspaceEmptyState hasWorkspaces={false} onAddWorkspace={vi.fn()} />,
    );

    expect(html).toContain("还没有工作区");
    expect(html).toContain("添加工作区");
    expect(html).not.toContain("WORKSPACE_MISSING");
  });
});
