import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopApp } from "../../src/renderer/App.js";

describe("desktop window chrome", () => {
  it("omits the redundant in-app top bar while rendering the active screen", () => {
    const html = renderToStaticMarkup(createElement(DesktopApp));

    expect(html).toContain('class="auth-layout"');
    expect(html).not.toContain('class="app-topbar"');
    expect(html).not.toContain('class="topbar-brand"');
    expect(html).not.toContain('class="topbar-state"');
  });
});
