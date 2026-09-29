import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceDialog } from "../src/components/workspace-dialog.js";

describe("WorkspaceDialog", () => {
  it("requires choosing a local folder before enabling Add", () => {
    const html = renderToStaticMarkup(
      <WorkspaceDialog
        path=""
        isPicking={false}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain("选择文件夹");
    expect(html).toContain("尚未选择文件夹");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('type="text"');
  });

  it("shows the selected folder and keeps the Add action available", () => {
    const html = renderToStaticMarkup(
      <WorkspaceDialog
        path={"D:\\Develop\\Caelush"}
        isPicking={false}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain("D:\\Develop\\Caelush");
    expect(html).toContain("添加");
    expect(html).not.toContain("尚未选择文件夹");
  });
});
