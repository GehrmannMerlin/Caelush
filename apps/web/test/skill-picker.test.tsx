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
        _workspace: WorkspaceId,
        _query: Partial<SkillCatalogQuery>,
        _options: CaelushClientRequestOptions,
      ) => catalogPage,
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
