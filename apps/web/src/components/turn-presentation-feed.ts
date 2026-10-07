import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import type { LiveActivity, LiveActivityState, TimelineState } from "@caelush/client";
import type {
  RunStatus,
  SessionTurnPresentationResponse,
  TurnPresentationItem,
  TurnPresentationItemV2,
  TurnPresentationItemV3,
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
import { ModelWaitNotice, usePresentationNow } from "./model-wait-presentation.js";

export interface TurnPresentationFeedProps {
  readonly presentation: SessionTurnPresentationResponse;
  readonly activeRun?: { readonly id: string; readonly status: RunStatus } | undefined;
  readonly liveActivity?: LiveActivityState | undefined;
  readonly timeline?: TimelineState | undefined;
  readonly isActive?: boolean | undefined;
}

/** Temporary adapter for the V1/V2 renderer; V3 Turn boundaries remain canonical in Protocol. */
export function flattenTurnsForLegacyRenderer(
  presentation: SessionTurnPresentationResponse,
): readonly (TurnPresentationItem | TurnPresentationItemV2 | TurnPresentationItemV3)[] {
  return presentation.capabilityVersion === 3
    ? presentation.turns.flatMap((turn) => turn.items)
    : presentation.items;
}

export function hasTurnPresentationItems(
  presentation: SessionTurnPresentationResponse | undefined,
): boolean {
  return presentation !== undefined && flattenTurnsForLegacyRenderer(presentation).length > 0;
}

function bindLiveActivitiesToTurns(
  presentation: SessionTurnPresentationResponse,
  activities: readonly LiveActivity[],
): readonly LiveActivity[] {
  if (presentation.capabilityVersion !== 3) return activities;
  const conversationTurnIdByRunId = new Map(
    presentation.turns.map((turn) => [turn.runId, turn.conversationTurnId]),
  );
  return activities.map((activity) => {
    const conversationTurnId = conversationTurnIdByRunId.get(activity.runId);
    return conversationTurnId === undefined ? activity : { ...activity, conversationTurnId };
  });
}

/**
 * Codex-style ordered execution feed.
 *
 * Durable commentary, Tools and verification stay together in one readable process disclosure;
 * final answers and the terminal Run report remain directly below it after the disclosure collapses.
 * Ephemeral deltas are rendered only as bounded live annotations and never become historical facts.
 */
export function TurnPresentationFeed(props: TurnPresentationFeedProps): ReactElement {
  const presentationItems = flattenTurnsForLegacyRenderer(props.presentation);
  const liveActivities = bindLiveActivitiesToTurns(
    props.presentation,
    props.liveActivity?.activities ?? [],
  );
  const isModelThinking = (props.timeline?.activeLlm.length ?? 0) > 0;
  const modelWait = props.liveActivity?.modelWait;
  const isTaskActive =
    props.activeRun === undefined
      ? props.isActive === true
      : isRunStatusActive(props.activeRun.status);
  const now = usePresentationNow(isTaskActive || isModelThinking || modelWait !== undefined);
  const verifyingRunId = props.activeRun?.status === "VERIFYING" ? props.activeRun.id : undefined;
  const latestUserItem = [...presentationItems].reverse().find((item) => item.kind === "USER");
  const taskElapsed =
    latestUserItem === undefined
      ? undefined
      : formatTaskElapsed(
          taskElapsedMs(
            latestUserItem.runId,
            latestUserItem.createdAt,
            presentationItems,
            isTaskActive,
            now,
          ),
        );
  const durableAssistantItems = presentationItems.filter((item) => item.kind === "ASSISTANT");
  const settledStepKeys = new Set(
    durableAssistantItems.flatMap((item) =>
      "sourceStepId" in item && item.sourceStepId !== undefined
        ? [`${item.runId}:${item.sourceStepId}`]
        : [],
    ),
  );
  const settledAssistantItemKeys = new Set(
    durableAssistantItems.flatMap((item) =>
      item.kind === "ASSISTANT" && "assistantItemId" in item && item.assistantItemId !== undefined
        ? [`${item.runId}:${item.assistantItemId}`]
        : [],
    ),
  );
  const processActivities = liveActivities.filter(
    (activity) =>
      activity.kind !== "MODEL_TEXT" &&
      !(
        activity.kind === "TOOL_ACTIVITY" &&
        activity.toolInvocationId !== undefined &&
        presentationItems.some(
          (item) =>
            item.kind === "TOOL" &&
            item.toolInvocationId === activity.toolInvocationId &&
            item.runId === activity.runId &&
            (activity.conversationTurnId === undefined ||
              item.conversationTurnId === activity.conversationTurnId),
        )
      ),
  );
  const finalAnswers = durableAssistantItems.filter(
    (item) => item.kind === "ASSISTANT" && item.phase === "FINAL_ANSWER",
  );
  const unsuccessfulTerminalRunIds = new Set(
    presentationItems.flatMap((item) =>
      item.kind === "RUN_SUMMARY" && item.runStatus !== "COMPLETED" ? [item.runId] : [],
    ),
  );
  const modelDrafts = liveActivities.filter(
    (activity) =>
      activity.kind === "MODEL_TEXT" &&
      (activity.status === "ACTIVE" || activity.status === "COMPLETED") &&
      !(props.liveActivity?.terminal === true && activity.status === "ACTIVE") &&
      !unsuccessfulTerminalRunIds.has(activity.runId) &&
      (activity.assistantItemId === undefined
        ? !settledStepKeys.has(`${activity.runId}:${activity.stepId ?? ""}`)
        : !settledAssistantItemKeys.has(`${activity.runId}:${activity.assistantItemId}`)),
  );
  const summaries = presentationItems.filter((item) => {
    if (item.kind !== "RUN_SUMMARY") return false;
    return !(
      item.runStatus === "COMPLETED" && finalAnswers.some((answer) => answer.runId === item.runId)
    );
  });
  const processItems = presentationItems.filter(
    (item) =>
      item.kind !== "USER" &&
      item.kind !== "RUN_SUMMARY" &&
      !(item.kind === "ASSISTANT" && item.phase === "FINAL_ANSWER"),
  );
  const userItems = presentationItems.filter((item) => item.kind === "USER");
  const finalItems = [...finalAnswers, ...summaries];
  const hasProcess =
    processItems.length > 0 ||
    processActivities.length > 0 ||
    modelDrafts.length > 0 ||
    modelWait !== undefined ||
    isModelThinking ||
    isTaskActive;
  const regionRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(isTaskActive);
  const wasActive = useRef(isTaskActive);

  useEffect(() => {
    const active = isTaskActive;
    if (active) setExpanded(true);
    else if (wasActive.current) setExpanded(false);
    wasActive.current = active;
  }, [isTaskActive]);

  useEffect(() => {
    if (!isTaskActive || regionRef.current === null) return;
    regionRef.current.scrollTop = regionRef.current.scrollHeight;
  }, [isTaskActive, processItems.length, liveActivities.length]);

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
              taskElapsed === undefined
                ? null
                : createElement(
                    "span",
                    { className: "turn-presentation-task-elapsed" },
                    taskElapsed,
                  ),
            ),
            createElement(
              "span",
              { className: "turn-presentation-summary-status" },
              processSummary(isTaskActive, processItems.length, processActivities.length),
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
            processItems.length === 0 &&
              processActivities.length === 0 &&
              modelDrafts.length === 0 &&
              !isModelThinking &&
              modelWait === undefined
              ? createElement("p", { className: "turn-presentation-empty" }, "正在准备任务活动……")
              : null,
            processItems.map((item) => renderItem(item, now, item.runId === verifyingRunId)),
            modelDrafts.length === 0
              ? null
              : createElement(
                  "section",
                  { className: "turn-presentation-model-drafts", "aria-label": "实时助手进度" },
                  modelDrafts.map((activity) =>
                    createElement(
                      "article",
                      {
                        className: `turn-presentation-item turn-presentation-item--assistant turn-presentation-item--${(activity.phase ?? "UNKNOWN").toLowerCase()} turn-presentation-model-draft turn-presentation-model-draft--${activity.status.toLowerCase()}`,
                        key: activity.id,
                      },
                      activity.phase === "COMMENTARY" || activity.phase === "FINAL_ANSWER"
                        ? createElement(AssistantMarkdown, null, activity.text)
                        : createElement(
                            "p",
                            { className: "turn-presentation-item-text" },
                            activity.text,
                          ),
                    ),
                  ),
                ),
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
                        ...(activity.conversationTurnId === undefined
                          ? {}
                          : { "data-conversation-turn-id": activity.conversationTurnId }),
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
                        `${liveActivityLabel(activity)}：${activity.text}`,
                      ),
                      activity.kind === "TOOL_ACTIVITY" && activity.effects !== undefined
                        ? createElement(
                            "ul",
                            {
                              className: "turn-presentation-tool-effects",
                              "aria-label": "文件变化",
                            },
                            activity.effects.map((effect, index) =>
                              createElement(
                                "li",
                                { key: `${activity.id}:effect:${index}` },
                                formatToolEffect(effect),
                              ),
                            ),
                          )
                        : null,
                    ),
                  ),
                ),
            createElement(ModelWaitNotice, {
              ...(modelWait === undefined ? {} : { modelWait }),
              isModelActive: isModelThinking,
              now,
            }),
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
    finalItems.length === 0
      ? null
      : createElement(
          "section",
          {
            className: "turn-presentation-final",
            "aria-label": summaries.length > 0 ? "任务结束报告" : "最终答复",
          },
          finalItems.map((item) => renderItem(item)),
          verifyingRunId !== undefined &&
            finalAnswers.some((answer) => answer.runId === verifyingRunId)
            ? createElement(
                "p",
                { className: "turn-presentation-verification-pending", role: "status" },
                "回复已生成，正在等待校验结果",
              )
            : null,
        ),
  );
}

function renderItem(
  item: TurnPresentationItem | TurnPresentationItemV2 | TurnPresentationItemV3,
  now?: number,
  isCurrentVerifyingRun = false,
): ReactElement {
  switch (item.kind) {
    case "USER":
      return createElement(
        "article",
        { className: "turn-presentation-item turn-presentation-item--user", key: item.id },
        createElement("p", { className: "turn-presentation-user-bubble" }, item.text),
      );
    case "ASSISTANT": {
      const label = assistantLabel(item.phase);
      return createElement(
        "article",
        {
          className: `turn-presentation-item turn-presentation-item--assistant turn-presentation-item--${item.phase.toLowerCase()}`,
          key: item.id,
        },
        label === null
          ? null
          : createElement("p", { className: "turn-presentation-item-label" }, label),
        item.phase === "FINAL_ANSWER" || item.phase === "COMMENTARY"
          ? createElement(AssistantMarkdown, null, item.text)
          : createElement("p", { className: "turn-presentation-item-text" }, item.text),
      );
    }
    case "TOOL": {
      const effects = "effects" in item ? item.effects : [];
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
          createElement(
            "p",
            { className: "turn-presentation-item-label" },
            "phase" in item ? durableToolTitle(item.title, item.phase) : item.title,
          ),
          createElement("p", { className: "turn-presentation-item-text" }, item.summary),
          effects.length === 0
            ? null
            : createElement(
                "ul",
                { className: "turn-presentation-tool-effects", "aria-label": "文件变化" },
                effects.map((effect, index) =>
                  createElement(
                    "li",
                    { key: `${item.id}:effect:${index}` },
                    formatToolEffect(effect),
                  ),
                ),
              ),
          item.facts.length === 0 && item.preview === undefined
            ? null
            : createElement(
                "details",
                { className: "turn-presentation-tool-details" },
                createElement("summary", null, "查看工具详情"),
                createElement(
                  "div",
                  { className: "turn-presentation-tool-details-content" },
                  item.facts.length === 0
                    ? null
                    : createElement(
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
                    : createElement(
                        "pre",
                        { className: "turn-presentation-preview" },
                        item.preview,
                      ),
                ),
              ),
        ),
      );
    }
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
          item.status === "STREAMING" && isCurrentVerifyingRun && now !== undefined
            ? createElement(
                "p",
                { className: "turn-presentation-verification-elapsed" },
                formatTaskElapsed(Math.max(0, now - Number(item.createdAt))),
              )
            : null,
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

function assistantLabel(phase: "COMMENTARY" | "FINAL_ANSWER" | "UNKNOWN"): string | null {
  switch (phase) {
    case "COMMENTARY":
      return null;
    case "FINAL_ANSWER":
      return "最终答复";
    case "UNKNOWN":
      return "助手消息";
  }
}

function liveActivityLabel(activity: LiveActivity): string {
  if (activity.kind === "TOOL_ACTIVITY") {
    const title = activity.title ?? toolCategoryTitle(activity.category);
    switch (activity.toolPhase) {
      case "REQUESTED":
        return `正在调用${title}`;
      case "WAITING_APPROVAL":
        return `等待批准：${title}`;
      case "RUNNING":
        return `正在${title}`;
      case "COMPLETED":
        return `${title}已完成`;
      case "FAILED":
        return `${title}失败`;
      case "CANCELLED":
        return `${title}已取消`;
      default:
        return title;
    }
  }
  switch (activity.kind) {
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

function toolCategoryTitle(category: LiveActivity["category"]): string {
  switch (category) {
    case "READ":
      return "读取文件";
    case "SEARCH":
      return "搜索文件";
    case "EDIT":
      return "编辑文件";
    case "COMMAND":
      return "执行命令";
    case "PROCESS":
      return "进程操作";
    case "GIT":
      return "Git 操作";
    default:
      return "使用工具";
  }
}

function durableToolTitle(
  title: string,
  phase: import("@caelush/protocol").ToolPresentationPhase,
): string {
  switch (phase) {
    case "REQUESTED":
      return `正在调用${title}`;
    case "WAITING_APPROVAL":
      return `等待批准：${title}`;
    case "RUNNING":
      return `正在${title}`;
    case "COMPLETED":
    case "FAILED":
    case "CANCELLED":
      return title;
  }
}

function formatToolEffect(effect: import("@caelush/protocol").ToolPresentationEffect): string {
  if (effect.type !== "FILE_CHANGE") return "";
  const change =
    effect.changeType === "CREATED"
      ? "新建"
      : effect.changeType === "MODIFIED"
        ? "修改"
        : effect.changeType === "DELETED"
          ? "删除"
          : "移动";
  const path =
    effect.changeType === "MOVED" && effect.fromPath !== undefined
      ? `${effect.fromPath} → ${effect.path}`
      : effect.path;
  const counts = [
    effect.additions === undefined || effect.additions === 0 ? undefined : `+${effect.additions}`,
    effect.deletions === undefined || effect.deletions === 0 ? undefined : `-${effect.deletions}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  return `${path}　${change}${counts.length === 0 ? "" : `　${counts}`}`;
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

function isRunStatusActive(status: RunStatus): boolean {
  return (
    status === "PENDING" ||
    status === "RUNNING" ||
    status === "WAITING_APPROVAL" ||
    status === "WAITING_RESOURCE" ||
    status === "VERIFYING"
  );
}

function taskElapsedMs(
  runId: string,
  startedAt: number,
  items: readonly TurnPresentationItem[],
  active: boolean,
  now: number,
): number {
  const matchingSummary = items.find((item) => item.kind === "RUN_SUMMARY" && item.runId === runId);
  if (matchingSummary !== undefined) return Math.max(0, matchingSummary.createdAt - startedAt);
  if (active) return Math.max(0, now - startedAt);

  const latestKnownRunActivityAt = items.reduce(
    (latestAt, item) => (item.runId === runId ? Math.max(latestAt, item.createdAt) : latestAt),
    startedAt,
  );
  return Math.max(0, latestKnownRunActivityAt - startedAt);
}

function formatTaskElapsed(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `用时 ${hours}小时${minutes}分${seconds}秒`;
  if (minutes > 0) return `用时 ${minutes}分${seconds}秒`;
  return `用时 ${seconds}秒`;
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
