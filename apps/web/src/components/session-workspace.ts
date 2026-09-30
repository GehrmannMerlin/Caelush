import { createElement, type ReactElement } from "react";
import type { ClientAgentRun } from "@caelush/protocol";
import {
  canCancelRunStatus,
  type LiveActivityState,
  type TimelineState,
  type TranscriptEntry,
} from "@caelush/client";
import type { ApprovalResolution, RunId } from "@caelush/protocol";
import type { ApprovalView } from "@caelush/client";
import type { WebControlMode } from "../application/session-manager.js";
import { runStatusClass, runStatusLabel } from "./run-status.js";
import { Timeline } from "./timeline.js";
import { ApprovalCard } from "./approval-card.js";
import { RecoveryPanel, type RecoveryRunView } from "./recovery-panel.js";
import caelushLogo from "../assets/logo/caelush-logo.png";

export interface SessionWorkspaceProps {
  readonly title: string;
  readonly activeRun?: ClientAgentRun | undefined;
  readonly history: readonly TranscriptEntry[];
  readonly timeline: TimelineState;
  readonly liveActivity?: LiveActivityState;
  readonly composer: ReactElement;
  readonly controlMode?: WebControlMode | undefined;
  readonly approvals?: readonly ApprovalView[] | undefined;
  readonly recoveryRuns?: readonly RecoveryRunView[] | undefined;
  readonly onCancel?: (() => Promise<boolean> | void) | undefined;
  readonly onContinueResource?: (() => Promise<boolean> | void) | undefined;
  readonly onResolveApproval?:
    | ((approvalId: ApprovalView["id"], resolution: ApprovalResolution) => Promise<boolean> | void)
    | undefined;
  readonly onSelectRecoveryRun?: ((runId: RunId) => Promise<boolean> | void) | undefined;
  readonly onConfirmPendingRun?: ((runId: RunId) => Promise<boolean> | void) | undefined;
}

export function SessionWorkspace(props: SessionWorkspaceProps): ReactElement {
  const isPristineSession =
    props.history.length === 0 &&
    props.activeRun === undefined &&
    (props.approvals?.length ?? 0) === 0 &&
    !hasRecoveryControl(props);

  return createElement(
    "section",
    {
      className: `session-workspace${isPristineSession ? " session-workspace--empty" : ""}`,
      ...(isPristineSession
        ? { "aria-label": "新会话" }
        : { "aria-labelledby": "session-workspace-title" }),
    },
    isPristineSession
      ? null
      : createElement(
          "header",
          { className: "session-workspace-header" },
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
    createElement(
      "div",
      { className: "session-scroll" },
      props.approvals?.map((approval) =>
        createElement(ApprovalCard, {
          key: approval.id,
          approval,
          onResolve: props.onResolveApproval ?? (() => undefined),
        }),
      ),
      (props.controlMode === "RECOVERY_PICKER" ||
        props.controlMode === "PENDING_RUN_CONFIRMATION") &&
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
        {
          className: `conversation-history${isPristineSession ? " conversation-history--empty" : ""}`,
          "aria-live": "polite",
        },
        isPristineSession
          ? createElement(
              "div",
              { className: "conversation-welcome" },
              createElement("img", { src: caelushLogo, alt: "Caelush" }),
              createElement("p", null, "保持对未知的探索热情"),
            )
          : props.history.map((entry) =>
              createElement(
                "article",
                {
                  className: `conversation-entry conversation-entry--${entry.kind.toLowerCase()}${
                    entry.kind === "RUN_TERMINAL" ? " conversation-entry--report" : ""
                  }`,
                  key: entry.id,
                },
                entry.kind === "USER"
                  ? null
                  : createElement(
                      "p",
                      { className: "conversation-author" },
                      historyAuthor(entry.kind),
                    ),
                createElement(
                  "p",
                  {
                    className:
                      entry.kind === "USER"
                        ? "conversation-bubble conversation-bubble--user"
                        : entry.kind === "RUN_TERMINAL"
                          ? "conversation-text conversation-report-text"
                          : "conversation-text",
                  },
                  entry.text,
                ),
              ),
            ),
      ),
      props.history.length === 0 && props.activeRun === undefined
        ? null
        : createElement(Timeline, {
            timeline: props.timeline,
            liveActivity: props.liveActivity,
            isActive: props.activeRun !== undefined && isActiveRun(props.activeRun.status),
          }),
      props.activeRun !== undefined &&
        (props.onCancel !== undefined || props.onContinueResource !== undefined)
        ? createElement(
            "div",
            { className: "run-action-tray", role: "status" },
            createElement(
              "span",
              { className: "run-action-label" },
              props.controlMode === "CANCELLING"
                ? "正在取消任务……"
                : props.controlMode === "RESOURCE_GUARD"
                  ? "任务需要资源决策"
                  : "Caelush 正在执行任务……",
            ),
            props.controlMode === "CANCELLING"
              ? createElement(
                  "button",
                  { type: "button", className: "cancel-button", disabled: true },
                  "正在取消",
                )
              : props.controlMode === "RESOURCE_GUARD"
                ? createElement(
                    "div",
                    { className: "resource-guard-card", role: "alert" },
                    createElement("span", null, "检测到重复或低进展路径。"),
                    props.timeline.resourceGuard === undefined
                      ? null
                      : createElement(
                          "div",
                          { className: "resource-guard-details" },
                          createElement(
                            "span",
                            null,
                            `已重新规划：${props.timeline.resourceGuard.replanCount} 次`,
                          ),
                          createElement(
                            "span",
                            null,
                            `本阶段已请求工具：${props.timeline.resourceGuard.requestedToolCalls} 次`,
                          ),
                        ),
                    props.onContinueResource === undefined
                      ? null
                      : createElement(
                          "button",
                          {
                            type: "button",
                            className: "continue-button",
                            onClick: props.onContinueResource,
                          },
                          "继续任务",
                        ),
                    props.onCancel === undefined
                      ? null
                      : createElement(
                          "button",
                          { type: "button", className: "cancel-button", onClick: props.onCancel },
                          "取消任务",
                        ),
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
    ),
    props.composer,
  );
}

function hasRecoveryControl(props: SessionWorkspaceProps): boolean {
  return (
    (props.controlMode === "RECOVERY_PICKER" || props.controlMode === "PENDING_RUN_CONFIRMATION") &&
    (props.recoveryRuns?.length ?? 0) > 0
  );
}

function canShowCancel(status: Parameters<typeof canCancelRunStatus>[0]): boolean {
  return canCancelRunStatus(status);
}

function historyAuthor(kind: TranscriptEntry["kind"]): string {
  switch (kind) {
    case "USER":
      return "你";
    case "ASSISTANT":
      return "Caelush";
    case "TOOL_RESULT":
      return "Tool result";
    case "CUSTOM":
      return "Caelush";
    case "RUN_TERMINAL":
      return "任务结束报告";
  }
}

function isActiveRun(status: ClientAgentRun["status"]): boolean {
  return (
    status === "PENDING" ||
    status === "RUNNING" ||
    status === "WAITING_APPROVAL" ||
    status === "WAITING_RESOURCE" ||
    status === "VERIFYING"
  );
}
