import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopApp } from "../../src/renderer/App.js";

describe("desktop page chrome", () => {
  it("omits the shared top and bottom bars while rendering the active screen", () => {
    const html = renderToStaticMarkup(createElement(DesktopApp));

    expect(html).toContain('class="auth-layout"');
    expect(html).not.toContain('class="app-topbar"');
    expect(html).not.toContain('class="topbar-brand"');
    expect(html).not.toContain('class="topbar-state"');
    expect(html).not.toContain('class="app-footer"');
    expect(html).not.toContain("凭据受 Windows 安全存储保护");
  });
});
