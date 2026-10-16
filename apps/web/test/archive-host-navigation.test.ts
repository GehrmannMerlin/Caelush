import { describe, expect, it } from "vitest";
import { resolveClientHostIntegration } from "../src/host/desktop-integration.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceSettingsMenu } from "../src/components/workspace-sidebar-footer.js";
describe("archive host navigation", () => {
  it("offers a Web archive action and the injected Desktop archive link", () => {
    const web = renderToStaticMarkup(
      createElement(WorkspaceSettingsMenu, {
        onSelect: () => undefined,
        onOpenArchives: () => undefined,
      }),
    );
    expect(web).toContain("已归档");
    expect(web.match(/role="menuitem"/g)).toHaveLength(2);
    const desktop = renderToStaticMarkup(
      createElement(WorkspaceSettingsMenu, {
        onSelect: () => undefined,
        archiveHref: "caelush-login://app/?view=account&section=archives",
      }),
    );
    expect(desktop).toContain("section=archives");
    expect(desktop).toContain("已归档");
  });
  it("injects the account section URL only for the versioned Desktop bridge", () => {
    const desktop = resolveClientHostIntegration({
      caelushDesktop: {
        protocolVersion: 1,
        account: { logout: async () => ({ serverRevoked: true }) },
      },
    });
    expect(desktop.kind === "DESKTOP" && desktop.account?.archiveHref).toBe(
      "caelush-login://app/?view=account&section=archives",
    );
    expect(resolveClientHostIntegration({}).kind).toBe("WEB");
  });
});
