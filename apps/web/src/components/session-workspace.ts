import { createElement, type ReactElement } from "react";
import type { ClientAgentRun } from "@caelush/protocol";
import { canCancelRunStatus, type SessionHistoryEntry, type TimelineState } from "@caelush/client";
import type { ApprovalResolution, RunId } from "@caelush/protocol";
import type { ApprovalView } from "@caelush/client";
import type { WebControlMode } from "../application/session-manager.js";
import { runStatusClass, runStatusLabel } from "./run-status.js";
import { Timeline } from "./timeline.js";
import { ApprovalCard } from "./approval-card.js";
import { RecoveryPanel, type RecoveryRunView } from "./recovery-panel.js";

export interface SessionWorkspaceProps {
  readonly title: string;
  readonly activeRun?: ClientAgentRun | undefined;
  readonly history: readonly SessionHistoryEntry[];
  readonly timeline: TimelineState;
  readonly composer: ReactElement;
  readonly controlMode?: WebControlMode | undefined;
  readonly approvals?: readonly ApprovalView[] | undefined;
  readonly recoveryRuns?: readonly RecoveryRunView[] | undefined;
  readonly onCancel?: (() => Promise<boolean> | void) | undefined;
  readonly onResolveApproval?:
    | ((approvalId: ApprovalView["id"], resolution: ApprovalResolution) => Promise<boolean> | void)
    | undefined;
  readonly onSelectRecoveryRun?: ((runId: RunId) => Promise<boolean> | void) | undefined;
  readonly onConfirmPendingRun?: ((runId: RunId) => Promise<boolean> | void) | undefined;
}

export function SessionWorkspace(props: SessionWorkspaceProps): ReactElement {
  return createElement(
    "section",
    { className: "session-workspace", "aria-labelledby": "session-workspace-title" },
    createElement(
      "header",
      { className: "session-workspace-header" },
      createElement("p", { className: "workspace-kicker" }, "当前会话"),
      createElement("h1", { id: "session-workspace-title" }, props.title),
      props.activeRun === undefined
        ? null
        : createElement(
            "div",
            {
              className: `active-run-status ${runStatusClass(props.activeRun.status)}`,
              role: "status",
            },
            createElement("span", { className: "status-pulse", "aria-hidden": "true" }),
            createElement("span", null, runStatusLabel(props.activeRun.status)),
          ),
    ),
    props.approvals?.map((approval) =>
      createElement(ApprovalCard, {
        key: approval.id,
        approval,
        onResolve: props.onResolveApproval ?? (() => undefined),
      }),
    ),
    (props.controlMode === "RECOVERY_PICKER" || props.controlMode === "PENDING_RUN_CONFIRMATION") &&
      props.recoveryRuns !== undefined
      ? createElement(RecoveryPanel, {
          mode: props.controlMode,
          runs: props.recoveryRuns,
          onSelectRun: props.onSelectRecoveryRun ?? (() => undefined),
          onConfirmPending: props.onConfirmPendingRun ?? (() => undefined),
        })
      : null,
    createElement(
      "div",
      { className: "conversation-history", "aria-live": "polite" },
      props.history.length === 0
        ? createElement(
            "div",
            { className: "conversation-empty" },
            createElement("p", null, "在这个会话中输入第一条任务。"),
          )
        : props.history.map((entry) =>
            createElement(
              "article",
              {
                className: `conversation-entry conversation-entry--${entry.kind.toLowerCase()}`,
                key: entry.id,
              },
              createElement("p", { className: "conversation-author" }, historyAuthor(entry.kind)),
              createElement("p", { className: "conversation-text" }, entry.text),
            ),
          ),
    ),
    createElement(Timeline, { timeline: props.timeline }),
    props.activeRun !== undefined && props.onCancel !== undefined
      ? createElement(
          "div",
          { className: "run-action-tray", role: "status" },
          createElement(
            "span",
            { className: "run-action-label" },
            props.controlMode === "CANCELLING" ? "正在取消任务……" : "Caelush 正在执行任务……",
          ),
          props.controlMode === "CANCELLING"
            ? createElement(
                "button",
                { type: "button", className: "cancel-button", disabled: true },
                "正在取消",
              )
            : canShowCancel(props.activeRun.status)
              ? createElement(
                  "button",
                  { type: "button", className: "cancel-button", onClick: props.onCancel },
                  "取消任务",
                )
              : null,
        )
      : null,
    props.composer,
  );
}

function canShowCancel(status: Parameters<typeof canCancelRunStatus>[0]): boolean {
  return canCancelRunStatus(status);
}

function historyAuthor(kind: SessionHistoryEntry["kind"]): string {
  switch (kind) {
    case "USER":
      return "你";
    case "ASSISTANT":
      return "Caelush";
    case "RUN_TERMINAL":
      return "任务状态";
  }
}
