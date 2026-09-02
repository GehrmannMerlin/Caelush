import { createElement, type ReactElement } from "react";
import type {
  TimelineEntry,
  TimelineEntryStatus,
  TimelineState,
  TimelineVerificationCheck,
} from "@caelush/client";

const WEB_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  read_file: "读取文件",
  list_directory: "查看目录",
  find_files: "查找文件",
  search_text: "搜索文本",
  apply_patch: "修改文件",
  exec_command: "执行命令",
  write_stdin: "与进程交互",
  git_status: "检查 Git 状态",
  git_diff: "查看 Git 变更",
});

export interface TimelineProps {
  readonly timeline: TimelineState;
}

export function Timeline(props: TimelineProps): ReactElement {
  const active = [
    ...props.timeline.activeLlm,
    ...props.timeline.activeTools,
    ...props.timeline.activeProcesses,
    ...props.timeline.activeApprovals,
  ];
  const settled = props.timeline.settled.filter((entry) => entry.title !== "Tool output");

  return createElement(
    "section",
    { className: "timeline", "aria-labelledby": "timeline-title", tabIndex: 0 },
    createElement(
      "header",
      { className: "timeline-header" },
      createElement("p", { className: "timeline-kicker" }, "任务活动"),
      createElement("h2", { id: "timeline-title" }, "执行过程"),
    ),
    active.length === 0 && settled.length === 0 && props.timeline.verification.length === 0
      ? createElement("p", { className: "timeline-empty" }, "等待任务活动。")
      : null,
    active.length === 0
      ? null
      : createElement(
          "ol",
          { className: "timeline-list timeline-list--active", "aria-label": "进行中的活动" },
          active.map((entry) => renderEntry(entry, "active")),
        ),
    settled.length === 0
      ? null
      : createElement(
          "ol",
          { className: "timeline-list", "aria-label": "已完成的活动" },
          settled.map((entry) => renderEntry(entry, "settled")),
        ),
    props.timeline.verification.length === 0
      ? null
      : createElement(
          "section",
          { className: "timeline-verification", "aria-label": "验证" },
          createElement("h3", null, "验证"),
          props.timeline.verification.map((group) =>
            createElement(
              "section",
              { className: "timeline-verification-group", key: group.id },
              createElement(
                "p",
                { className: "timeline-verification-status" },
                group.label,
                " · ",
                statusLabel(group.status),
              ),
              group.checks.length === 0
                ? null
                : createElement(
                    "ol",
                    { className: "timeline-check-list" },
                    group.checks.map(renderVerificationCheck),
                  ),
            ),
          ),
        ),
  );
}

function renderEntry(entry: TimelineEntry, phase: "active" | "settled"): ReactElement {
  const failed = isFailure(entry.status);
  return createElement(
    "li",
    {
      className: `timeline-entry timeline-entry--${phase} timeline-entry--${entry.status.toLowerCase()}`,
      key: entry.id,
    },
    createElement(
      "span",
      { className: "timeline-entry-mark", "aria-hidden": "true" },
      phase === "active" ? "●" : failed ? "!" : "✓",
    ),
    createElement(
      "div",
      { className: "timeline-entry-content" },
      createElement("p", { className: "timeline-entry-title" }, entryLabel(entry)),
      entry.text === undefined
        ? null
        : createElement("p", { className: "timeline-entry-text" }, entry.text),
      createElement("p", { className: "timeline-entry-status" }, statusLabel(entry.status)),
    ),
  );
}

function renderVerificationCheck(check: TimelineVerificationCheck): ReactElement {
  return createElement(
    "li",
    { className: `timeline-check timeline-check--${check.status.toLowerCase()}`, key: check.id },
    createElement(
      "span",
      { className: "timeline-check-mark", "aria-hidden": "true" },
      checkMark(check.status),
    ),
    createElement("span", { className: "timeline-check-label" }, check.label),
    createElement("span", { className: "timeline-check-status" }, statusLabel(check.status)),
    check.detail === undefined
      ? null
      : createElement("span", { className: "timeline-check-duration" }, check.detail),
  );
}

function entryLabel(entry: TimelineEntry): string {
  if (entry.toolName !== undefined) return WEB_TOOL_LABELS[entry.toolName] ?? entry.toolName;
  if (entry.kind === "REASONING") return "推理摘要";
  return entry.title ?? entry.kind;
}

function checkMark(status: TimelineEntryStatus): string {
  return status === "RUNNING" || status === "PENDING" ? "●" : isFailure(status) ? "!" : "✓";
}

function isFailure(status: TimelineEntryStatus): boolean {
  return (
    status === "FAILED" || status === "ERROR" || status === "CANCELLED" || status === "INTERRUPTED"
  );
}

function statusLabel(status: TimelineEntryStatus): string {
  const labels: Readonly<Record<TimelineEntryStatus, string>> = {
    ACTIVE: "进行中",
    REQUESTED: "已请求",
    RUNNING: "进行中",
    COMPLETED: "已完成",
    FAILED: "失败",
    CANCELLED: "已取消",
    PENDING: "等待中",
    SKIPPED: "已跳过",
    INTERRUPTED: "已中断",
    RESOLVED: "已处理",
    FINALIZED: "已结束",
    PASSED: "通过",
    ERROR: "错误",
  };
  return labels[status];
}
