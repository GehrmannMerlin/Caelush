import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopApp } from "../../src/renderer/App.js";

describe("desktop window chrome", () => {
  it("keeps the product header without drawing controls already provided by Windows", () => {
    const html = renderToStaticMarkup(createElement(DesktopApp));

    expect(html).toContain('class="topbar-brand"');
    expect(html).toContain('class="topbar-state"');
    expect(html).not.toContain('class="native-controls"');
    expect(html).not.toContain("最小化窗口");
    expect(html).not.toContain("最大化或还原窗口");
    expect(html).not.toContain("关闭窗口");
  });
});
