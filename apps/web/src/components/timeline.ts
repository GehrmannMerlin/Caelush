import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  TimelineEntry,
  TimelineEntryStatus,
  TimelineResourceGuard,
  TimelineRetry,
  TimelineState,
  TimelineVerificationCheck,
  LiveActivityState,
} from "@caelush/client";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleDot,
  CircleX,
  Minus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {
  isNearTimelineBottom,
  timelineActivityCount,
  timelineActivityDelta,
} from "./timeline-scroll.js";
import { ModelWaitNotice, usePresentationNow } from "./model-wait-presentation.js";

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
  readonly liveActivity?: LiveActivityState | undefined;
  readonly isActive?: boolean | undefined;
}

export function Timeline(props: TimelineProps): ReactElement {
  const active = [
    ...props.timeline.activeLlm,
    ...props.timeline.activeTools,
    ...props.timeline.activeProcesses,
    ...props.timeline.activeApprovals,
  ];
  const settled = props.timeline.settled.filter((entry) => entry.title !== "Tool output");
  const liveActivities = props.liveActivity?.activities ?? [];
  const activityCount = timelineActivityCount(props.timeline, props.liveActivity);
  const modelWait = props.liveActivity?.modelWait;
  const hasPendingRetry = props.timeline.retries.some((retry) => retry.status === "PENDING");
  const now = usePresentationNow(modelWait !== undefined || hasPendingRetry);
  const regionRef = useRef<HTMLDivElement>(null);
  const seenActivityCount = useRef(activityCount);
  const [following, setFollowing] = useState(true);
  const [newActivityCount, setNewActivityCount] = useState(0);
  const [expanded, setExpanded] = useState(props.isActive === true);
  const wasActive = useRef(props.isActive === true);

  useEffect(() => {
    const activeNow = props.isActive === true;
    if (activeNow) {
      setExpanded(true);
    } else if (wasActive.current) {
      setExpanded(false);
    }
    wasActive.current = activeNow;
  }, [props.isActive]);

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
    "details",
    {
      className: "timeline",
      open: expanded,
      onToggle: (event) => setExpanded((event.currentTarget as HTMLDetailsElement).open),
      "aria-labelledby": "timeline-title",
    },
    createElement(
      "summary",
      { className: "timeline-summary" },
      createElement(
        "span",
        { className: "timeline-summary-copy" },
        createElement("span", { className: "timeline-kicker" }, "任务活动"),
        createElement(
          "span",
          { id: "timeline-title", className: "timeline-summary-title" },
          "执行过程",
        ),
      ),
      createElement(
        "span",
        { className: "timeline-summary-status" },
        timelineSummary(props.isActive === true, active.length, settled.length),
      ),
      createElement(ChevronDown, {
        className: "timeline-summary-chevron",
        size: 17,
        strokeWidth: 2.1,
        "aria-hidden": true,
      }),
    ),
    createElement(
      "div",
      { className: "timeline-body" },
      createElement(
        "div",
        {
          className: "timeline-feed",
        },
        createElement(
          "div",
          {
            className: "timeline-scroll-region",
            ref: regionRef,
            onScroll: handleScroll,
            tabIndex: 0,
            "aria-label": "任务活动流",
          },
          activityCount === 0
            ? createElement("p", { className: "timeline-empty" }, "等待任务活动。")
            : null,
          props.timeline.currentPlan.length === 0
            ? null
            : createElement(
                "section",
                { className: "timeline-plan", "aria-label": "任务计划" },
                createElement("h3", null, "任务计划"),
                createElement(
                  "ol",
                  { className: "timeline-plan-list" },
                  props.timeline.currentPlan.map(renderPlanItem),
                ),
              ),
          createElement(ModelWaitNotice, {
            ...(modelWait === undefined ? {} : { modelWait }),
            isModelActive: props.timeline.activeLlm.length > 0,
            now,
          }),
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
          props.timeline.retries.length === 0
            ? null
            : createElement(
                "section",
                { className: "timeline-retries", "aria-label": "重试活动" },
                createElement("h3", null, "重试活动"),
                createElement(
                  "ul",
                  { className: "timeline-retry-list" },
                  props.timeline.retries.map((retry) => renderRetry(retry, now)),
                ),
              ),
          props.timeline.resourceGuard === undefined
            ? null
            : renderResourceGuard(props.timeline.resourceGuard),
          liveActivities.length === 0
            ? null
            : createElement(
                "section",
                { className: "timeline-live-activity", "aria-label": "实时输出" },
                createElement("h3", null, "实时输出"),
                createElement(
                  "ul",
                  null,
                  liveActivities.map((activity) =>
                    createElement(
                      "li",
                      { key: activity.id },
                      `${liveActivityLabel(activity.kind)}：${activity.text} · ${liveActivityStatusLabel(
                        activity.status,
                      )}`,
                    ),
                  ),
                ),
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

function renderPlanItem(item: TimelineState["currentPlan"][number]): ReactElement {
  return createElement(
    "li",
    {
      className: `timeline-plan-item timeline-plan-item--${item.status.toLowerCase()}`,
      key: item.id,
    },
    createElement(
      "span",
      { className: "timeline-plan-mark", "aria-hidden": "true" },
      planMark(item.status),
    ),
    createElement(
      "span",
      { className: "timeline-plan-title" },
      item.title,
      createElement(
        "span",
        { className: "timeline-plan-status" },
        ` · ${planStatusLabel(item.status)}`,
      ),
    ),
  );
}

function renderRetry(retry: TimelineRetry, now: number): ReactElement {
  const retryCount = `${retry.retryOrdinal}/${retry.maxRetries}`;
  const isExhausted = retry.exhaustedReason !== undefined;
  const remainingSeconds = Math.ceil(Math.max(0, (retry.nextAttemptAt ?? now) - now) / 1_000);
  const text = isExhausted
    ? `重试已耗尽：${retry.maxRetries}/${retry.maxRetries} 次重试后模型请求失败`
    : retry.status === "FAILED"
      ? `模型重试失败 ${retryCount}`
      : retry.status === "PENDING"
        ? `将在 ${remainingSeconds} 秒后重新连接 ${retryCount}`
        : retry.status === "RUNNING"
          ? `正在重新连接 ${retryCount}`
          : `重试完成 ${retryCount}`;
  const fallbackTransport = safeTransportId(retry.toTransportId);
  return createElement(
    "li",
    {
      className: `timeline-retry timeline-retry--${retry.status.toLowerCase()}`,
      key: retry.id,
      ...(isExhausted || retry.status === "FAILED"
        ? { role: "alert" }
        : { role: "status", "aria-live": "polite" }),
    },
    createElement(
      "span",
      { className: "timeline-entry-mark", "aria-hidden": "true" },
      createElement(RefreshCw, { size: 14, strokeWidth: 2.1 }),
    ),
    createElement(
      "span",
      { className: "timeline-retry-text" },
      text,
      fallbackTransport === undefined
        ? null
        : createElement("span", null, ` · 已切换备用传输 ${fallbackTransport}`),
    ),
  );
}

function safeTransportId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = value.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 64);
  return safe.length === 0 ? undefined : safe;
}

function renderResourceGuard(guard: TimelineResourceGuard): ReactElement {
  return createElement(
    "section",
    { className: "timeline-resource-guard", "aria-label": "资源决策" },
    createElement("h3", null, "任务需要资源决策"),
    createElement("p", null, "原因：连续低进展"),
    createElement("p", null, `已重新规划：${guard.replanCount} 次`),
    createElement("p", null, `本阶段已请求工具：${guard.requestedToolCalls} 次`),
  );
}

function planMark(status: TimelineState["currentPlan"][number]["status"]): ReactElement {
  switch (status) {
    case "COMPLETED":
      return createElement(Check, { size: 14, strokeWidth: 2.1, "aria-hidden": true });
    case "IN_PROGRESS":
      return createElement(CircleDot, { size: 14, strokeWidth: 2.1, "aria-hidden": true });
    case "FAILED":
      return createElement(CircleAlert, { size: 14, strokeWidth: 2.1, "aria-hidden": true });
    case "SKIPPED":
      return createElement(Minus, { size: 14, strokeWidth: 2.1, "aria-hidden": true });
    case "PENDING":
      return createElement(CircleDot, { size: 14, strokeWidth: 1.7, "aria-hidden": true });
  }
}

function timelineSummary(isActive: boolean, activeCount: number, settledCount: number): string {
  if (isActive) return activeCount > 0 ? `${activeCount} 项活动进行中` : "正在启动";
  if (settledCount > 0) return `${settledCount} 项活动已完成`;
  return "等待任务活动";
}

function planStatusLabel(status: TimelineState["currentPlan"][number]["status"]): string {
  switch (status) {
    case "COMPLETED":
      return "已完成";
    case "IN_PROGRESS":
      return "进行中";
    case "FAILED":
      return "失败";
    case "SKIPPED":
      return "已跳过";
    case "PENDING":
      return "待执行";
  }
}

function liveActivityLabel(kind: LiveActivityState["activities"][number]["kind"]): string {
  switch (kind) {
    case "MODEL_TEXT":
      return "助手输出";
    case "MODEL_REASONING":
      return "推理摘要";
    case "MODEL_TOOL_CALL":
      return "工具调用";
    case "TOOL_OUTPUT":
      return "工具输出";
    case "SHELL_OUTPUT":
      return "Shell 输出";
    case "PROCESS_OUTPUT":
      return "进程输出";
  }
}

function liveActivityStatusLabel(
  status: LiveActivityState["activities"][number]["status"],
): string {
  switch (status) {
    case "ACTIVE":
      return "执行中";
    case "COMPLETED":
      return "已完成";
    case "FAILED":
      return "失败";
    case "CANCELLED":
      return "已取消";
  }
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
      phase === "active"
        ? createElement(CircleDot, { size: 14, strokeWidth: 2.1 })
        : failed
          ? createElement(TriangleAlert, { size: 14, strokeWidth: 2.1 })
          : createElement(Check, { size: 14, strokeWidth: 2.1 }),
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

function checkMark(status: TimelineEntryStatus): ReactElement {
  if (status === "RUNNING" || status === "PENDING") {
    return createElement(CircleDot, { size: 14, strokeWidth: 2.1, "aria-hidden": true });
  }
  if (isFailure(status)) {
    return createElement(CircleX, { size: 14, strokeWidth: 2.1, "aria-hidden": true });
  }
  return createElement(Check, { size: 14, strokeWidth: 2.1, "aria-hidden": true });
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
