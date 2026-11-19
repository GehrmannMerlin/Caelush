import { describe, expect, it } from "vitest";
import { createRunId } from "@caelush/protocol";
import { ActivityStatus } from "../src/components/ActivityStatus.js";

describe("CLI ActivityStatus Skill usage", () => {
  it("renders terminal V4 usage with safe selected names and statuses", () => {
    const html = collectText(
      ActivityStatus({
        activity: "Completed",
        skillPreparation: {
          schemaVersion: 1,
          runId: createRunId(),
          userText: "Review this change.",
          preparationStatus: "CONTENT_READY",
          selectedSkills: [{ skillId: "project:review-notes", name: "review-notes" }],
        },
        skillRunStatuses: [
          { skillId: "project:review-notes", name: "review-notes", status: "LOADED" },
        ],
      }),
    );

    expect(html).toContain("Skill 已加入上下文：review-notes");
    expect(html).not.toContain("正文已准备，尚未确认读取");
    expect(html).not.toContain("selectionToken");
  });
});

function collectText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node !== "object" || node === null || !("props" in node)) return "";
  return collectText((node as { readonly props: { readonly children?: unknown } }).props.children);
}
