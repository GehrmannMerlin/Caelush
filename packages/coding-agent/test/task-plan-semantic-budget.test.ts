import { describe, expect, it } from "vitest";
import type { ResolvedTaskPlanEvidence } from "../src/tools/plan/task-plan-evidence.js";
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

  it("keeps the evidence section above the discretionary sections in a long plan", () => {
    const steps: TaskPlanSnapshot["steps"] = Array.from({ length: 12 }, (_, index) => ({
      id: `s${String(index + 1)}`,
      step: `里程碑 ${String(index + 1)} ${"需要核对产物 ".repeat(20)}`,
      status: index === 0 ? "in_progress" : index < 4 ? "completed" : "pending",
      acceptance: [`验收 ${"检查工作结果 ".repeat(20)}`],
      ...(index < 4 ? { evidenceRefs: [`verification:check-${String(index + 1)}`] } : {}),
    }));
    const evidence: readonly ResolvedTaskPlanEvidence[] = [
      { reference: "verification:check-1", kind: "VERIFICATION", state: "PASSED" },
      { reference: "verification:check-2", kind: "VERIFICATION", state: "FAILED" },
      { reference: "verification:check-3", kind: "VERIFICATION", state: "STALE" },
      { reference: "verification:check-4", kind: "VERIFICATION", state: "PASSED" },
    ];
    const plan: TaskPlanSnapshot = {
      revision: "plan-evidence-budget",
      sourceStepId: "step-plan",
      planVersion: 2,
      steps,
      execution: {
        goal: `EVIDENCE_GOAL_SENTINEL ${"保留项目目标 ".repeat(30)}`,
        unresolved: ["EVIDENCE_UNRESOLVED_SENTINEL：仍需确认构建产物"],
        nextAction: "EVIDENCE_NEXT_SENTINEL：执行并核对最终构建",
        decisions: Array.from({ length: 8 }, () => `决定 ${"实现选择 ".repeat(40)}`),
      },
      resultsSincePlan: 2,
    };

    const result = renderBoundedTaskPlan(plan, {
      maxBytes: 8 * 1024,
      evidence,
      availableEvidenceRefs: Array.from({ length: 6 }, (_, index) => ({
        reference: `observation:obs-${String(index + 1)}`,
        description: `最近的工具观察 ${String(index + 1)}`,
      })),
    });

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(result.includedSections).toContain("evidence");
    expect(result.text).toContain("EVIDENCE_GOAL_SENTINEL");
    expect(result.text).toContain("EVIDENCE_UNRESOLVED_SENTINEL");
    expect(result.text).toContain("EVIDENCE_NEXT_SENTINEL");
    expect(result.text).toContain("revision=plan-evidence-budget");
    // At most four deduplicated references, and the failing one survives the competition for space.
    const listed = result.text.split("\n").filter((line) => line.startsWith("- "));
    expect(listed.length).toBeLessThanOrEqual(4);
    expect(new Set(listed).size).toBe(listed.length);
    expect(result.text).toContain("verification:check-2");
    // A long plan's discretionary tail is what gives up space, not the evidence.
    expect(result.omittedCounts.remaining).toBeGreaterThan(0);
  });

  it("bounds each evidence description to 80 UTF-8 bytes without splitting a character", () => {
    const description = "汉".repeat(60);
    const result = renderBoundedTaskPlan(
      {
        revision: "plan-description",
        planVersion: 2,
        steps: [
          {
            id: "check",
            step: "run the check",
            status: "in_progress",
            evidenceRefs: ["verification:check-1"],
          },
        ],
        resultsSincePlan: 1,
      },
      {
        evidence: [{ reference: "verification:check-1", kind: "VERIFICATION", state: "PASSED" }],
        availableEvidenceRefs: [{ reference: "verification:check-1", description }],
      },
    );

    // 27 Chinese characters are 81 bytes: keeping them would break the bound.
    expect(result.text).not.toContain("汉".repeat(27));
    expect(result.text).toContain("汉".repeat(25));
  });
});
