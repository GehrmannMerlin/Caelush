import { describe, expect, it } from "vitest";
import {
  boundPlanBlock,
  renderBoundedTaskPlan,
  renderTaskPlanBlock,
  type TaskPlanSnapshot,
} from "../src/tools/plan/task-plan-projection.js";

function longPlan(): TaskPlanSnapshot {
  return {
    revision: "plan-result-1",
    sourceStepId: "step-1",
    planVersion: 2,
    steps: Array.from({ length: 20 }, (_, index) => ({
      id: `step-${String(index + 1)}`,
      step: `实现阶段 ${String(index + 1)} ${"详细内容🙂 ".repeat(90)}`,
      status: index === 0 ? "in_progress" : "pending",
      acceptance: [`验收项 ${String(index + 1)} ${"检查工作结果 ".repeat(30)}`],
    })),
    execution: {
      goal: `可靠性目标 ${"保留项目目标 ".repeat(40)}`,
      constraints: [`不能丢失关键约束 ${"约束 ".repeat(80)}`],
      discoveries: [`发现 ${"环境信息 ".repeat(80)}`],
      decisions: [`决定 ${"实现选择 ".repeat(80)}`],
      unresolved: [`UNRESOLVED_SENTINEL：仍需确认真实产物`, "第二项未解决问题"],
      nextAction: "NEXT_ACTION_SENTINEL：执行并核对最终构建",
    },
    resultsSincePlan: 3,
  };
}

describe("task plan semantic budget", () => {
  it("preserves unresolved work and next action when a valid long plan exceeds the Context budget", () => {
    const result = renderBoundedTaskPlan(longPlan(), { maxBytes: 8 * 1024 });

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(result.text).toContain("UNRESOLVED_SENTINEL");
    expect(result.text).toContain("NEXT_ACTION_SENTINEL");
    expect(result.text).toContain("Full snapshot reference: revision=plan-result-1");
    expect(result.includedSections).toEqual(
      expect.arrayContaining(["meta", "current", "unresolved", "next", "constraints"]),
    );
    expect(result.omittedCounts.remaining).toBeGreaterThan(0);
    expect(result.text).toContain("🙂");
  });

  it("keeps the existing UTF-8 safe prefix helper available for compatibility", () => {
    const rendered = boundPlanBlock(renderTaskPlanBlock(longPlan()), 1024);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(1024);
    expect(rendered).toContain("[plan truncated to fit the context budget]");
  });

  it("fits a deliberately small render budget without emitting invalid UTF-8 boundaries", () => {
    const result = renderBoundedTaskPlan(longPlan(), { maxBytes: 512 });
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(512);
    expect(result.text).toContain("summarized/truncated");
  });
});
