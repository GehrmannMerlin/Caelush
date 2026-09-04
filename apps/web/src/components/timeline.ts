import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  TimelineEntry,
  TimelineEntryStatus,
  TimelineState,
  TimelineVerificationCheck,
} from "@caelush/client";
import { isNearTimelineBottom, timelineActivityDelta } from "./timeline-scroll.js";

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
const MAX_PUBLIC_ID_LENGTH = 128;

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
  const activityCount =
    active.length +
    settled.length +
    props.timeline.verification.reduce((count, group) => count + group.checks.length, 0);
  const regionRef = useRef<HTMLDivElement>(null);
  const seenActivityCount = useRef(activityCount);
  const [following, setFollowing] = useState(true);
  const [newActivityCount, setNewActivityCount] = useState(0);

  const alignToLatest = useCallback(() => {
    const region = regionRef.current;
    if (region === null) return;
    region.scrollTo({ top: region.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const delta = timelineActivityDelta(following, seenActivityCount.current, activityCount);
    seenActivityCount.current = activityCount;
    if (following) {
      setNewActivityCount(0);
      if (delta > 0) alignToLatest();
    } else if (delta > 0) {
      setNewActivityCount((current) => Math.min(99, current + delta));
    }
  }, [activityCount, alignToLatest, following]);

  const handleScroll = useCallback(() => {
    const region = regionRef.current;
    if (region === null) return;
    const nextFollowing = isNearTimelineBottom({
      scrollTop: region.scrollTop,
      clientHeight: region.clientHeight,
      scrollHeight: region.scrollHeight,
    });
    setFollowing((current) => {
      if (current === nextFollowing) return current;
      if (nextFollowing) {
        seenActivityCount.current = activityCount;
        setNewActivityCount(0);
      }
      return nextFollowing;
    });
  }, [activityCount]);

  const jumpToLatest = useCallback(() => {
    seenActivityCount.current = activityCount;
    setFollowing(true);
    setNewActivityCount(0);
    alignToLatest();
  }, [activityCount, alignToLatest]);

  return createElement(
    "section",
    { className: "timeline", "aria-labelledby": "timeline-title" },
    createElement(
      "header",
      { className: "timeline-header" },
      createElement("p", { className: "timeline-kicker" }, "任务活动"),
      createElement("h2", { id: "timeline-title" }, "执行过程"),
    ),
    createElement(
      "div",
      { className: "timeline-feed" },
      createElement(
        "div",
        {
          className: "timeline-scroll-region",
          ref: regionRef,
          onScroll: handleScroll,
          tabIndex: 0,
          "aria-label": "任务活动流",
        },
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
                  renderPublicId("计划 ID", group.planId),
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
      ),
      newActivityCount === 0
        ? null
        : createElement(
            "button",
            {
              type: "button",
              className: "timeline-new-activity",
              onClick: jumpToLatest,
              "aria-label": "跳转到最新活动",
            },
            `${newActivityCount} 条新活动 · 跳转到最新`,
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
      renderEntryPublicIds(entry),
      entry.kind === "TOOL"
        ? entry.filePath === undefined
          ? null
          : createElement("p", { className: "timeline-entry-path" }, entry.filePath)
        : entry.text === undefined
          ? null
          : createElement("p", { className: "timeline-entry-text" }, entry.text),
      renderSafeToolDetail(entry),
      createElement("p", { className: "timeline-entry-status" }, statusLabel(entry.status)),
    ),
  );
}

function renderSafeToolDetail(entry: TimelineEntry): ReactElement | null {
  const detail = safeToolDetail(entry);
  return detail === undefined
    ? null
    : createElement("p", { className: "timeline-entry-detail" }, detail);
}

function safeToolDetail(entry: TimelineEntry): string | undefined {
  if (entry.toolName === "apply_patch" && entry.detail !== undefined) {
    const match = /^([AMDR]) ([^\s]+)(?: \(\+\d+, -\d+\))?$/u.exec(entry.detail);
    if (match !== null) return entry.detail;
  }
  if (
    entry.toolName === "exec_command" &&
    entry.text !== undefined &&
    (/^Command exited with code \d+\.$/u.test(entry.text) ||
      /^Command completed by signal [\w-]+\.$/u.test(entry.text))
  ) {
    return entry.text;
  }
  return undefined;
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
    renderPublicId("检查 ID", check.checkId),
    createElement("span", { className: "timeline-check-status" }, statusLabel(check.status)),
    check.detail === undefined
      ? null
      : createElement("span", { className: "timeline-check-duration" }, check.detail),
  );
}

function entryLabel(entry: TimelineEntry): string {
  if (entry.toolName !== undefined) return WEB_TOOL_LABELS[entry.toolName] ?? entry.toolName;
  if (entry.kind === "REASONING") return "决策摘要";
  return entry.title ?? entry.kind;
}

function renderEntryPublicIds(entry: TimelineEntry): ReactElement | null {
  const ids = [
    renderPublicId("调用 ID", entry.invocationId),
    renderPublicId("进程 ID", entry.processId),
    renderPublicId("计划 ID", entry.planId),
  ].filter((id): id is ReactElement => id !== null);
  return ids.length === 0 ? null : createElement("div", { className: "timeline-public-ids" }, ids);
}

function renderPublicId(label: string, value: string | undefined): ReactElement | null {
  if (value === undefined) return null;
  return createElement(
    "span",
    { className: "timeline-public-id", key: `${label}:${value}` },
    `${label}: ${boundedPublicId(value)}`,
  );
}

function boundedPublicId(value: string): string {
  return value.length <= MAX_PUBLIC_ID_LENGTH
    ? value
    : `${value.slice(0, MAX_PUBLIC_ID_LENGTH - 1)}…`;
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
