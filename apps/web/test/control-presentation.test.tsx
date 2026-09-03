import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { approvalResolutionForOption, type ApprovalView } from "@caelush/client";
import { ApprovalCard } from "../src/components/approval-card.js";
import { ReconnectBanner } from "../src/components/reconnect-banner.js";
import { RecoveryPanel } from "../src/components/recovery-panel.js";
import { PromptComposer } from "../src/components/prompt-composer.js";
import { SessionWorkspace } from "../src/components/session-workspace.js";
import { createInitialTimelineState } from "@caelush/client";

vi.mock("@caelush/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@caelush/client")>()),
  approvalResolutionForOption: vi.fn((kind) =>
    kind === "APPROVE_RUN"
      ? { action: "APPROVE", scope: "ONCE" }
      : kind === "APPROVE_ONCE"
        ? { action: "APPROVE", scope: "RUN" }
        : { action: "REJECT" },
  ),
}));

const approval: ApprovalView = {
  id: "approval-1",
  runId: "run-1",
  createdAt: 1700000000000,
  title: "需要批准访问工作区",
  reason: "该动作会修改项目文件",
  riskLevel: "HIGH",
  scope: "RUN",
  toolName: "apply_patch",
  summary: "应用经过验证的补丁",
  requiredCapabilities: ["workspace.write", "filesystem.patch"],
  options: [
    { kind: "APPROVE_ONCE", label: "Approve once" },
    { kind: "APPROVE_RUN", label: "Approve this action for this Run" },
    { kind: "REJECT", label: "Reject" },
  ],
};

describe("Web control presentation", () => {
  it("renders only the public approval projection and gates Run approval by scope", () => {
    const html = renderToStaticMarkup(
      <ApprovalCard approval={approval} onResolve={vi.fn(async () => true)} />,
    );

    expect(html).toContain("需要审批");
    expect(html).toContain("HIGH");
    expect(html).toContain("该动作会修改项目文件");
    expect(html).toContain("应用经过验证的补丁");
    expect(html).toContain("apply_patch");
    expect(html).toContain("workspace.write");
    expect(html).toContain("filesystem.patch");
    expect(html).toContain("拒绝");
    expect(html).toContain("仅本次允许");
    expect(html).toContain("本次运行内允许");
    expect(html).not.toContain("raw-args-sentinel");
    expect(html).not.toContain("SECRET_ENV_SENTINEL");
    expect(html).not.toContain("hidden-reasoning-sentinel");
    expect(html).not.toContain("tool-output-sentinel");

    const onceOnly = {
      ...approval,
      scope: "ONCE" as const,
      options: approval.options.slice(0, 1).concat(approval.options[2]!),
    };
    const onceHtml = renderToStaticMarkup(
      <ApprovalCard approval={onceOnly} onResolve={vi.fn(async () => true)} />,
    );
    expect(onceHtml).toContain("拒绝");
    expect(onceHtml).toContain("仅本次允许");
    expect(onceHtml).not.toContain("本次运行内允许");
  });

  it("uses the shared resolution helper result when an approval option is clicked", () => {
    const onResolve = vi.fn(() => true);
    const element = ApprovalCard({ approval, onResolve });
    const buttons = findElements(element, "button");

    buttons[1]?.props.onClick();

    expect(approvalResolutionForOption).toHaveBeenCalledWith("APPROVE_ONCE");
    expect(onResolve).toHaveBeenCalledWith(approval.id, {
      action: "APPROVE",
      scope: "RUN",
    });
  });

  it("shows exactly one cancel control for cancellable statuses and presents cancelling", () => {
    for (const status of ["RUNNING", "WAITING_APPROVAL", "VERIFYING"] as const) {
      const html = renderToStaticMarkup(
        <SessionWorkspace
          title="控制台"
          activeRun={{ id: "run-1", status } as never}
          history={[]}
          timeline={createInitialTimelineState()}
          onCancel={vi.fn(async () => true)}
          composer={
            <PromptComposer disabled submission="IDLE" onSubmit={vi.fn(async () => true)} />
          }
        />,
      );
      expect((html.match(/取消/g) ?? []).length).toBe(1);
      expect(html).toContain("取消");
    }

    const cancellingHtml = renderToStaticMarkup(
      <SessionWorkspace
        title="控制台"
        activeRun={{ id: "run-1", status: "RUNNING" } as never}
        controlMode="CANCELLING"
        history={[]}
        timeline={createInitialTimelineState()}
        onCancel={vi.fn(async () => true)}
        composer={
          <PromptComposer disabled submission="ACTIVE" onSubmit={vi.fn(async () => true)} />
        }
      />,
    );
    expect(cancellingHtml).toContain("正在取消");
    expect((cancellingHtml.match(/取消/g) ?? []).length).toBe(1);
  });

  it("renders technical reconnect states and one manual retry", () => {
    expect(renderToStaticMarkup(<ReconnectBanner state="CONNECTED" />)).toContain("CONNECTED");
    expect(renderToStaticMarkup(<ReconnectBanner state="RECONNECTING" attempt={3} />)).toContain(
      "第 3 / 6 次",
    );
    const disconnected = renderToStaticMarkup(
      <ReconnectBanner state="DISCONNECTED" onReconnect={vi.fn()} />,
    );
    expect(disconnected).toContain("DISCONNECTED");
    expect((disconnected.match(/重新连接/g) ?? []).length).toBe(1);
  });

  it("renders pending confirmation and a bounded multiple-run picker without sensitive panels", () => {
    const oversizedGoal = "g".repeat(9000);
    const html = renderToStaticMarkup(
      <RecoveryPanel
        mode="RECOVERY_PICKER"
        runs={[
          { id: "run-a", goal: oversizedGoal, status: "RUNNING", createdAt: 1700000000000 },
          { id: "run-b", goal: "检查部署", status: "VERIFYING", createdAt: 1700000001000 },
        ]}
        onSelectRun={vi.fn(async () => true)}
        onConfirmPending={vi.fn(async () => true)}
      />,
    );
    expect(html).toContain("选择要恢复的任务");
    expect(html).not.toContain(oversizedGoal);
    expect(html).toContain("gggg");
    expect(html).toContain("RUNNING");
    expect(html).toContain("run-a");

    const pending = renderToStaticMarkup(
      <RecoveryPanel
        mode="PENDING_RUN_CONFIRMATION"
        runs={[{ id: "run-p", goal: "等待确认", status: "PENDING", createdAt: 1700000002000 }]}
        onSelectRun={vi.fn(async () => true)}
        onConfirmPending={vi.fn(async () => true)}
      />,
    );
    expect(pending).toContain("确认启动任务");
    expect(pending).not.toContain("Inspector");
    expect(pending).not.toContain("Terminal");
    expect(pending).not.toContain("SECRET_ENV_SENTINEL");
    expect(pending).not.toContain("shell-output-sentinel");
    expect(pending).not.toContain("hidden-reasoning-sentinel");
    expect(pending).not.toContain("evidence");
    expect(pending).not.toContain("diff");
  });
});

function findElements(element: unknown, type: string): Array<{ props: Record<string, any> }> {
  if (!element || typeof element !== "object") return [];
  const candidate = element as { type?: unknown; props?: Record<string, any> };
  const found = candidate.type === type && candidate.props ? [{ props: candidate.props }] : [];
  const children = candidate.props?.children;
  return found.concat(
    (Array.isArray(children) ? children : [children]).flatMap((child) => findElements(child, type)),
  );
}
