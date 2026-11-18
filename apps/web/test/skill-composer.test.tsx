import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceId,
  type SkillCatalogItemV1,
  type SkillSelectionV1,
} from "@caelush/protocol";
import { PromptComposer } from "../src/components/prompt-composer.js";

const selectedSkill: SkillCatalogItemV1 = {
  skillId: "user:review-notes",
  name: "review-notes",
  description: "Review notes manually.",
  displayName: "Review notes",
  selectionToken: "opaque-private-selection-token",
  enabled: true,
  userInvocable: true,
  modelInvocable: false,
};
const workspaceId = createWorkspaceId();

function pickerProps() {
  return {
    skillsEnabled: true,
    workspaceId,
    selectedSkills: [],
    onSelectSkill: vi.fn<(selection: SkillSelectionV1) => void>(),
    onRemoveSkill: vi.fn<(skillId: string) => void>(),
    listSkills: vi.fn(async () => ({
      schemaVersion: 1 as const,
      catalogRevision: "revision-1",
      items: [selectedSkill],
      complete: true,
      diagnostics: [],
    })),
    onSubmitDraft: vi.fn(async () => undefined),
  };
}

describe("Skill composer integration", () => {
  it("keeps the add button available for Skills when file upload is unavailable", () => {
    const skillProps = pickerProps();
    const html = renderToStaticMarkup(
      <PromptComposer
        disabled={false}
        submission="IDLE"
        onSubmit={async () => false}
        {...skillProps}
      />,
    );

    expect(html).toContain('aria-label="添加内容"');
    const plusButton = html.match(/<button[^>]*aria-label="添加内容"[^>]*>/)?.[0] ?? "";
    expect(plusButton).not.toContain("disabled");
  });

  it("hides the Skill picker and keeps the add button disabled without catalog capability", () => {
    const html = renderToStaticMarkup(
      <PromptComposer disabled={false} submission="IDLE" onSubmit={async () => false} />,
    );

    expect(html).toContain('aria-label="添加附件"');
    const plusButton = html.match(/<button[^>]*aria-label="添加附件"[^>]*>/)?.[0] ?? "";
    expect(plusButton).toContain("disabled");
    expect(html).not.toContain("选择技能");
  });

  it("shows selected Skills as removable tags without exposing selection tokens", () => {
    const skillProps = {
      ...pickerProps(),
      selectedSkills: [selectedSkill, { ...selectedSkill, displayName: "Review notes copy" }],
    };
    const html = renderToStaticMarkup(
      <PromptComposer
        disabled={false}
        submission="IDLE"
        onSubmit={async () => false}
        {...skillProps}
      />,
    );

    expect(html).toContain("Review notes");
    expect(html.match(/class="selected-skill-tag"/gu)).toHaveLength(1);
    expect(html).toContain('aria-label="移除技能 Review notes"');
    expect(html).not.toContain(selectedSkill.selectionToken);
  });
});
