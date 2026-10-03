import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import type { LiveActivityState, TimelineState } from "@caelush/client";
import type {
  RunStatus,
  SessionTurnPresentationResponse,
  TurnPresentationItem,
} from "@caelush/protocol";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  LoaderCircle,
} from "lucide-react";
import caelushLogo from "../assets/logo/caelush-logo.png";
import { AssistantMarkdown } from "./assistant-markdown.js";

export interface TurnPresentationFeedProps {
  readonly presentation: SessionTurnPresentationResponse;
  readonly liveActivity?: LiveActivityState | undefined;
  readonly timeline?: TimelineState | undefined;
  readonly isActive?: boolean | undefined;
}

/**
 * Codex-style ordered execution feed.
 *
 * Durable commentary, Tools and verification stay together in one readable process disclosure;
 * final answers and the terminal Run report remain directly below it after the disclosure collapses.
 * Ephemeral deltas are rendered only as bounded live annotations and never become historical facts.
 */
export function TurnPresentationFeed(props: TurnPresentationFeedProps): ReactElement {
  const liveActivities = props.liveActivity?.activities ?? [];
  const durableAssistantItems = props.presentation.items.filter(
    (item) => item.kind === "ASSISTANT",
  );
  const settledStepKeys = new Set(
    durableAssistantItems.flatMap((item) =>
      "sourceStepId" in item && item.sourceStepId !== undefined
        ? [`${item.runId}:${item.sourceStepId}`]
        : [],
    ),
  );
  const processActivities = liveActivities.filter((activity) => activity.kind !== "MODEL_TEXT");
  const finalAnswers = durableAssistantItems.filter(
    (item) => item.kind === "ASSISTANT" && item.phase === "FINAL_ANSWER",
  );
  const unsuccessfulTerminalRunIds = new Set(
    props.presentation.items.flatMap((item) =>
      item.kind === "RUN_SUMMARY" && item.runStatus !== "COMPLETED" ? [item.runId] : [],
    ),
  );
  const modelDrafts = liveActivities.filter(
    (activity) =>
      activity.kind === "MODEL_TEXT" &&
      (activity.status === "ACTIVE" || activity.status === "COMPLETED") &&
      !(props.liveActivity?.terminal === true && activity.status === "ACTIVE") &&
      !unsuccessfulTerminalRunIds.has(activity.runId) &&
      !settledStepKeys.has(`${activity.runId}:${activity.stepId ?? ""}`),
  );
  const summaries = props.presentation.items.filter((item) => {
    if (item.kind !== "RUN_SUMMARY") return false;
    return !(
      item.runStatus === "COMPLETED" && finalAnswers.some((answer) => answer.runId === item.runId)
    );
  });
  const processItems = props.presentation.items.filter(
    (item) =>
      item.kind !== "USER" &&
      item.kind !== "RUN_SUMMARY" &&
      !(item.kind === "ASSISTANT" && item.phase === "FINAL_ANSWER"),
  );
  const userItems = props.presentation.items.filter((item) => item.kind === "USER");
  const finalItems = [...finalAnswers, ...summaries];
  const hasProcess =
    processItems.length > 0 || processActivities.length > 0 || props.isActive === true;
  const regionRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(props.isActive === true);
  const wasActive = useRef(props.isActive === true);

  useEffect(() => {
    const active = props.isActive === true;
    if (active) setExpanded(true);
    else if (wasActive.current) setExpanded(false);
    wasActive.current = active;
  }, [props.isActive]);

  useEffect(() => {
    if (props.isActive !== true || regionRef.current === null) return;
    regionRef.current.scrollTop = regionRef.current.scrollHeight;
  }, [props.isActive, processItems.length, liveActivities.length]);

  return createElement(
    "div",
    { className: "turn-presentation-feed" },
    userItems.length === 0
      ? null
      : createElement(
          "div",
          { className: "turn-presentation-users", "aria-label": "任务" },
          userItems.map((item) => renderItem(item)),
        ),
    hasProcess
      ? createElement(
          "details",
          {
            className: "turn-presentation-process",
            open: expanded,
            onToggle: (event) => setExpanded((event.currentTarget as HTMLDetailsElement).open),
          },
          createElement(
            "summary",
            { className: "turn-presentation-summary" },
            createElement(
              "span",
              { className: "turn-presentation-summary-copy" },
              createElement("img", {
                className: "turn-presentation-logo",
                src: caelushLogo,
                alt: "Caelush",
              }),
            ),
            createElement(
              "span",
              { className: "turn-presentation-summary-status" },
              processSummary(
                props.isActive === true,
                processItems.length,
                processActivities.length,
              ),
            ),
            createElement(ChevronDown, {
              className: "turn-presentation-chevron",
              size: 17,
              strokeWidth: 2.1,
              "aria-hidden": true,
            }),
          ),
          createElement(
            "div",
            { className: "turn-presentation-body", ref: regionRef, tabIndex: 0 },
            processItems.length === 0 && processActivities.length === 0
              ? createElement("p", { className: "turn-presentation-empty" }, "正在准备任务活动……")
              : null,
            processItems.map((item) => renderItem(item)),
            processActivities.length === 0
              ? null
              : createElement(
                  "section",
                  { className: "turn-presentation-live", "aria-label": "实时活动" },
                  processActivities.map((activity) =>
                    createElement(
                      "div",
                      {
                        className: `turn-presentation-live-item turn-presentation-live-item--${activity.status.toLowerCase()}`,
                        key: activity.id,
                      },
                      createElement(
                        "span",
                        {
                          className: "turn-presentation-live-mark",
                          "aria-label": `状态：${liveActivityStatusLabel(activity.status)}`,
                        },
                        renderLiveActivityStatusIcon(activity.status),
                      ),
                      createElement(
                        "span",
                        null,
                        `${liveActivityLabel(activity.kind)}：${activity.text}`,
                      ),
                    ),
                  ),
                ),
            props.timeline?.resourceGuard === undefined
              ? null
              : createElement(
                  "div",
                  { className: "turn-presentation-guard", role: "alert" },
                  `检测到重复或低进展路径，已重新规划 ${props.timeline.resourceGuard.replanCount} 次。`,
                ),
          ),
        )
      : null,
    finalItems.length === 0 && modelDrafts.length === 0
      ? null
      : createElement(
          "section",
          {
            className: "turn-presentation-final",
            "aria-label": summaries.length > 0 ? "任务结束报告" : "最终答复",
          },
          finalItems.map((item) => renderItem(item)),
          modelDrafts.map((activity) =>
            createElement(
              "article",
              {
                className:
                  "turn-presentation-item turn-presentation-item--assistant turn-presentation-item--final_answer",
                key: activity.id,
              },
              createElement("p", { className: "turn-presentation-item-label" }, "最终答复"),
              createElement(AssistantMarkdown, null, activity.text),
            ),
          ),
        ),
  );
}

function renderItem(item: TurnPresentationItem): ReactElement {
  switch (item.kind) {
    case "USER":
      return createElement(
        "article",
        { className: "turn-presentation-item turn-presentation-item--user", key: item.id },
        createElement("p", { className: "turn-presentation-user-bubble" }, item.text),
      );
    case "ASSISTANT":
      return createElement(
        "article",
        {
          className: `turn-presentation-item turn-presentation-item--assistant turn-presentation-item--${item.phase.toLowerCase()}`,
          key: item.id,
        },
        createElement(
          "p",
          { className: "turn-presentation-item-label" },
          assistantLabel(item.phase),
        ),
        item.phase === "FINAL_ANSWER"
          ? createElement(AssistantMarkdown, null, item.text)
          : createElement("p", { className: "turn-presentation-item-text" }, item.text),
      );
    case "TOOL":
      return createElement(
        "article",
        {
          className: `turn-presentation-item turn-presentation-item--tool turn-presentation-item--${item.status.toLowerCase()}`,
          key: item.id,
        },
        createElement(
          "span",
          { className: "turn-presentation-mark", "aria-hidden": true },
          renderPresentationStatusIcon(item.status),
        ),
        createElement(
          "div",
          { className: "turn-presentation-item-main" },
          createElement("p", { className: "turn-presentation-item-label" }, item.title),
          createElement("p", { className: "turn-presentation-item-text" }, item.summary),
          createElement(
            "div",
            { className: "turn-presentation-facts" },
            item.facts.map((fact) =>
              createElement(
                "span",
                { key: `${item.id}:${fact.key}` },
                `${fact.key}：${fact.value}`,
              ),
            ),
          ),
          item.preview === undefined
            ? null
            : createElement("pre", { className: "turn-presentation-preview" }, item.preview),
        ),
      );
    case "VERIFICATION":
      return createElement(
        "article",
        {
          className: `turn-presentation-item turn-presentation-item--verification turn-presentation-item--${item.status.toLowerCase()}`,
          key: item.id,
        },
        createElement(
          "span",
          { className: "turn-presentation-mark", "aria-hidden": true },
          renderPresentationStatusIcon(item.status, true),
        ),
        createElement(
          "div",
          { className: "turn-presentation-item-main" },
          createElement("p", { className: "turn-presentation-item-label" }, item.title),
          createElement("p", { className: "turn-presentation-item-text" }, item.summary),
          item.evidence === undefined
            ? null
            : createElement("p", { className: "turn-presentation-item-evidence" }, item.evidence),
        ),
      );
    case "RUN_SUMMARY":
      return createElement(
        "article",
        {
          className: `turn-presentation-item turn-presentation-item--run-summary turn-presentation-item--${item.status.toLowerCase()}`,
          key: item.id,
        },
        createElement("p", { className: "turn-presentation-final-kicker" }, "任务结束报告"),
        createElement(
          "h3",
          { className: "turn-presentation-final-title" },
          runStatusLabel(item.runStatus),
        ),
        createElement("p", { className: "turn-presentation-item-text" }, item.text),
      );
  }
}

function assistantLabel(phase: "COMMENTARY" | "FINAL_ANSWER" | "UNKNOWN"): string {
  switch (phase) {
    case "COMMENTARY":
      return "工作说明";
    case "FINAL_ANSWER":
      return "最终答复";
    case "UNKNOWN":
      return "助手消息";
  }
}

function liveActivityLabel(kind: string): string {
  switch (kind) {
    case "MODEL_REASONING":
      return "推理摘要";
    case "MODEL_TOOL_CALL":
      return "工具调用";
    case "TOOL_OUTPUT":
      return "工具输出";
    case "SHELL_OUTPUT":
      return "命令输出";
    case "PROCESS_OUTPUT":
      return "进程输出";
    default:
      return "助手消息";
  }
}

function liveActivityStatusLabel(
  status: NonNullable<TurnPresentationFeedProps["liveActivity"]>["activities"][number]["status"],
): string {
  switch (status) {
    case "ACTIVE":
      return "进行中";
    case "COMPLETED":
      return "已完成";
    case "FAILED":
      return "失败";
    case "CANCELLED":
      return "已取消";
  }
}

function renderLiveActivityStatusIcon(
  status: NonNullable<TurnPresentationFeedProps["liveActivity"]>["activities"][number]["status"],
): ReactElement {
  switch (status) {
    case "ACTIVE":
      return createElement(LoaderCircle, {
        size: 14,
        className: "turn-presentation-spinner",
        "aria-hidden": true,
      });
    case "COMPLETED":
      return createElement(CircleCheck, { size: 14, "aria-hidden": true });
    case "FAILED":
      return createElement(CircleX, { size: 14, "aria-hidden": true });
    case "CANCELLED":
      return createElement(CircleMinus, { size: 14, "aria-hidden": true });
  }
}

function renderPresentationStatusIcon(
  status: TurnPresentationItem["status"],
  warning = false,
): ReactElement {
  switch (status) {
    case "STREAMING":
      return createElement(LoaderCircle, {
        size: 15,
        className: "turn-presentation-spinner",
        "aria-hidden": true,
      });
    case "COMPLETED":
      return createElement(CircleCheck, { size: 15, "aria-hidden": true });
    case "FAILED":
      return createElement(warning ? CircleAlert : CircleX, { size: 15, "aria-hidden": true });
    case "CANCELLED":
      return createElement(CircleMinus, { size: 15, "aria-hidden": true });
  }
}

function processSummary(active: boolean, durableCount: number, liveCount: number): string {
  if (active) return liveCount > 0 ? `${liveCount} 条活动进行中` : "正在执行";
  if (durableCount > 0) return `${durableCount} 条活动`;
  return "无活动";
}

function runStatusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    PENDING: "任务准备中",
    RUNNING: "任务运行中",
    WAITING_APPROVAL: "等待审批",
    WAITING_RESOURCE: "等待资源决策",
    VERIFYING: "验证中",
    COMPLETED: "任务已完成",
    FAILED: "任务失败",
    CANCELLED: "任务已取消",
    TIMEOUT: "任务超时",
    MAX_STEPS_REACHED: "达到步骤上限",
    BUDGET_EXCEEDED: "达到预算限制",
  };
  return labels[status];
}
