import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopFileExplorer } from "../../../web/src/components/desktop-file-explorer.js";
import { DesktopWorkspacePanel } from "../../../web/src/components/desktop-workspace-panel.js";
import {
  detectDesktopPanelApi,
  type DesktopPanelApi,
} from "../../../web/src/host/desktop-panel-api.js";

const emptyApi = {} as DesktopPanelApi;

describe("Desktop WebHost panel integration", () => {
  it("starts with the right panel collapsed and keeps its tabs as a Desktop-only addition", () => {
    const markup = renderToStaticMarkup(
      createElement(DesktopWorkspacePanel, {
        api: emptyApi,
        workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    );

    expect(markup).toContain("desktop-workspace-panel is-collapsed");
    expect(markup).toContain('aria-label="展开桌面面板"');
    expect(markup).toContain('aria-label="展开文件面板"');
    expect(markup).not.toContain("xterm");
  });

  it("shows an explicit empty state when Files has no Workspace", () => {
    const markup = renderToStaticMarkup(
      createElement(DesktopFileExplorer, {
        api: emptyApi,
        workspaceId: null,
      }),
    );

    expect(markup).toContain("未选择工作区");
    expect(markup).toContain("选择一个工作区后即可浏览文件");
  });

  it("does not infer Desktop authority from URL or query data in an ordinary Web Host", async () => {
    await expect(detectDesktopPanelApi()).resolves.toBeNull();
  });
});
