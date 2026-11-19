import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createWorkspaceId, type SkillManagementPageV1 } from "@caelush/protocol";
import {
  SkillManager,
  groupSkillPackages,
  type SkillManagerClient,
} from "../src/components/skill-manager.js";

const workspaceId = createWorkspaceId();
const page: SkillManagementPageV1 = {
  schemaVersion: 1,
  catalogRevision: `sha256:${"a".repeat(64)}`,
  complete: true,
  diagnostics: [],
  items: [
    {
      skillId: "project:manual-review",
      name: "manual-review",
      displayName: "Manual review",
      description: "Review changes when selected by the user.",
      enabled: true,
      userInvocable: true,
      modelInvocable: false,
    },
    {
      skillId: "user:disabled-helper",
      name: "disabled-helper",
      description: "A disabled Skill remains manageable.",
      enabled: false,
      userInvocable: false,
      modelInvocable: false,
    },
  ],
};

function managerClient(): SkillManagerClient {
  return {
    async listManagedSkills() {
      return page;
    },
    async updateSkillSettings(_workspaceId, skillId, request) {
      return {
        schemaVersion: 1,
        catalogRevision: request.expectedCatalogRevision,
        settings: {
          skillId: skillId as (typeof page.items)[number]["skillId"],
          enabled: request.enabled ?? true,
          modelInvocable: request.modelInvocable ?? false,
          version: 1,
        },
      };
    },
    async importSkills(_workspaceId, request) {
      return {
        schemaVersion: 1,
        skillId: page.items[0]!.skillId,
        name: page.items[0]!.name,
        target: request.target,
        bundleRevision: `sha256:${"b".repeat(64)}`,
        replaced: false,
      };
    },
  };
}

describe("SkillManager", () => {
  it("shows disabled and manual-only items without exposing source metadata", () => {
    const html = renderToStaticMarkup(
      <SkillManager
        workspaceId={workspaceId}
        initialPage={page}
        client={managerClient()}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("Manual review");
    expect(html).toContain("仅手动");
    expect(html).toContain("disabled-helper");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("不可调用");
    expect(html).not.toMatch(/来源|source|绝对路径|hostPath/iu);
  });

  it("keeps nested resources in the nearest imported Skill package", () => {
    const files = [
      relativeFile("manual-review/SKILL.md", "---\\nname: manual-review\\n---\\nbody"),
      relativeFile("manual-review/references/checklist.md", "safe reference"),
      relativeFile("manual-review/assets/diagram.svg", "<svg />"),
      relativeFile("release-checklist/SKILL.md", "---\\nname: release-checklist\\n---\\nbody"),
      relativeFile("release-checklist/scripts/check.mjs", "export {}"),
    ];

    const packages = groupSkillPackages(files);

    expect(packages).toHaveLength(2);
    expect(packages[0]?.files.map((item) => item.relativePath)).toEqual([
      "SKILL.md",
      "references/checklist.md",
      "assets/diagram.svg",
    ]);
    expect(packages[1]?.files.map((item) => item.relativePath)).toEqual([
      "SKILL.md",
      "scripts/check.mjs",
    ]);
  });

  it("provides shared directory import targets and safe refresh feedback", () => {
    const html = renderToStaticMarkup(
      <SkillManager
        workspaceId={workspaceId}
        initialPage={page}
        client={managerClient()}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain("当前项目");
    expect(html).toContain("所有项目");
    expect(html).toContain("选择技能包文件夹");
    expect(html).toContain("刷新");
    expect(html).toContain('role="status"');
  });
});

function relativeFile(relativePath: string, content: string): File {
  return Object.assign(new Blob([content]), {
    name: relativePath.split("/").at(-1)!,
    webkitRelativePath: relativePath,
  }) as File;
}
