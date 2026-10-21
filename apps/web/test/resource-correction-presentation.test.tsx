import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type ApprovalView, createInitialTimelineState } from "@caelush/client";
import { SessionWorkspace } from "../src/components/session-workspace.js";

const approval: ApprovalView = {
  id: "approval-1",
  runId: "run-1",
  createdAt: 1,
  title: "需要批准访问工作区",
  reason: "该操作需要工作区写入权限",
  riskLevel: "HIGH",
  scope: "ONCE",
  toolName: "apply_patch",
  summary: "应用补丁",
  requiredCapabilities: ["workspace.write"],
  options: [
    { kind: "APPROVE_ONCE", label: "仅本次允许" },
    { kind: "REJECT", label: "拒绝" },
  ],
};

describe("resource correction presentation", () => {
  it("keeps an automatic correction factual and removes ordinary blocker controls", () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="工作区"
        activeRun={{ id: "run-1", status: "WAITING_RESOURCE" } as never}
        history={[]}
        timeline={{
          ...createInitialTimelineState(),
          resourceGuard: { reason: "NO_PROGRESS", replanCount: 2, requestedToolCalls: 17 },
        }}
        composer={<div>COMPOSER</div>}
      />,
    );

    expect(html).toContain("Agent 正在自动调整");
    expect(html).toContain("Agent 自动调整了执行路径");
    expect(html).not.toContain("继续任务");
    expect(html).not.toContain("需要资源决策");
    expect(html).not.toContain('class="resource-guard-card"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="dialog"');
  });

  it("keeps real safety approval available during automatic correction", () => {
    const html = renderToStaticMarkup(
      <SessionWorkspace
        title="工作区"
        activeRun={{ id: "run-1", status: "WAITING_APPROVAL" } as never}
        history={[]}
        timeline={createInitialTimelineState()}
        approvals={[approval]}
        onResolveApproval={vi.fn(async () => true)}
        composer={<div>COMPOSER</div>}
      />,
    );

    expect(html).toContain('aria-label="待审批操作"');
    expect(html).toContain('class="approval-action approval-action--reject"');
    expect(html).toContain("仅本次允许");
  });
});
