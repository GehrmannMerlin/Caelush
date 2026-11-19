import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  SkillCatalogPageV1,
  SkillSelectionV1,
  WorkspaceId,
  SkillCatalogQuery,
} from "@caelush/protocol";
import type { CaelushClientRequestOptions } from "@caelush/client";
import { createSkillCatalogStore } from "../src/application/skill-catalog-store.js";
import {
  AttachmentMenu,
  resolveMobileSkillMenuMaxHeight,
  resolveSkillPanelPlacement,
  resolveSkillPanelVerticalShift,
} from "../src/components/attachment-menu.js";
import { SkillPicker } from "../src/components/skill-picker.js";

const workspaceId = "ws_skillpicker12345678901234567890" as WorkspaceId;

const catalogPage: SkillCatalogPageV1 = {
  schemaVersion: 1,
  catalogRevision: "revision-1",
  complete: true,
  diagnostics: [],
  items: [
    {
      skillId: "user:review-notes",
      name: "review-notes",
      description: "Review notes manually.",
      displayName: "Review notes",
      selectionToken: "opaque-manual-token",
      enabled: true,
      userInvocable: true,
      modelInvocable: false,
    },
    {
      skillId: "project:format-code",
      name: "format-code",
      description: "Format code automatically.",
      selectionToken: "opaque-model-token",
      enabled: true,
      userInvocable: true,
      modelInvocable: true,
    },
  ],
};

describe("Skill picker", () => {
  it("does not mount an interactive picker before the menu is opened", () => {
    const html = renderToStaticMarkup(
      <AttachmentMenu
        skillsEnabled
        workspaceId={workspaceId}
        listSkills={vi.fn(async () => catalogPage)}
        onSelectSkill={vi.fn()}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('id="prompt-skill-picker"');
    expect(html).not.toContain('id="skill-picker-search"');
  });

  it("keeps a flipped picker within the workspace beside the fixed sidebar", () => {
    expect(
      resolveSkillPanelPlacement({
        viewportWidth: 1440,
        panelWidth: 352,
        menuLeft: 437,
        menuRight: 1295,
        contentLeft: 292,
      }),
    ).toEqual({ side: "left", shiftX: 227 });
  });

  it("keeps the picker panel within the viewport above or below its anchor", () => {
    expect(
      resolveSkillPanelVerticalShift({ panelTop: -66, panelHeight: 480, viewportHeight: 900 }),
    ).toBe(78);
    expect(
      resolveSkillPanelVerticalShift({ panelTop: 620, panelHeight: 480, viewportHeight: 900 }),
    ).toBe(-212);
  });

  it("limits the mobile picker to the space above the composer", () => {
    expect(resolveMobileSkillMenuMaxHeight({ composerTop: 356, viewportHeight: 844 })).toBe(332);
  });

  it("renders an accessible search and explicit loading state", () => {
    const html = renderToStaticMarkup(
      <SkillPicker
        workspaceId={workspaceId}
        listSkills={vi.fn(async () => catalogPage)}
        selectedSkills={[]}
        onSelect={vi.fn<(selection: SkillSelectionV1) => void>()}
      />,
    );

    expect(html).toContain('for="skill-picker-search"');
    expect(html).toContain('type="search"');
    expect(html).toContain('role="status"');
    expect(html).toContain("正在加载技能");
  });

  it("passes the workspace, query, cursor, and abort signal to the catalog", async () => {
    const listSkills = vi.fn(
      async (
        workspace: WorkspaceId,
        query: Partial<SkillCatalogQuery>,
        options: CaelushClientRequestOptions,
      ) => {
        expect(workspace).toBe(workspaceId);
        expect(query).toEqual({ q: "review", cursor: "cursor-1" });
        expect(options).toEqual({ signal });
        return catalogPage;
      },
    );
    const store = createSkillCatalogStore({ listSkills });
    const signal = new AbortController().signal;

    const page = await store.listSkills({
      workspaceId,
      query: "review",
      cursor: "cursor-1",
      signal,
    });

    expect(listSkills).toHaveBeenCalledWith(
      workspaceId,
      { q: "review", cursor: "cursor-1" },
      { signal },
    );
    expect(page.items.map((item) => item.skillId)).toEqual([
      "user:review-notes",
      "project:format-code",
    ]);
    expect(page.items.find((item) => item.skillId === "user:review-notes")?.modelInvocable).toBe(
      false,
    );
  });
});
