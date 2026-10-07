import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  LiveActivity,
  LiveActivityState,
  TimelineState,
  TranscriptEntry,
} from "@caelush/client";
import type {
  RunStatus,
  SessionTurnPresentationResponse,
  SessionTurnPresentationTurnV3,
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
import { projectTurnPresentation } from "../application/turn-presentation-view-model.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import { ModelWaitNotice, usePresentationNow } from "./model-wait-presentation.js";

export interface TurnPresentationFeedProps {
  readonly presentation: SessionTurnPresentationResponse;
  readonly activeRun?: { readonly id: string; readonly status: RunStatus } | undefined;
  readonly liveActivity?: LiveActivityState | undefined;
  readonly timeline?: TimelineState | undefined;
  readonly isActive?: boolean | undefined;
}

export interface TurnPresentationProps {
  readonly turn: SessionTurnPresentationTurnV3;
  readonly optimisticUser?: Extract<TranscriptEntry, { kind: "USER" }> | undefined;
  readonly activeRun?: { readonly id: string; readonly status: RunStatus } | undefined;
  readonly liveActivity?: LiveActivityState | undefined;
  readonly timeline?: TimelineState | undefined;
}

export interface SessionConversationProps {
  readonly presentation: Extract<SessionTurnPresentationResponse, { capabilityVersion: 3 }>;
  readonly optimisticUsers?: readonly Extract<TranscriptEntry, { kind: "USER" }>[] | undefined;
  readonly activeRun?: { readonly id: string; readonly status: RunStatus } | undefined;
  readonly liveActivity?: LiveActivityState | undefined;
  readonly timeline?: TimelineState | undefined;
}

/** V1/V2 are item-page contracts, so their isolated fallback reads only their item arrays. */
export function flattenTurnsForLegacyRenderer(
  presentation: Exclude<SessionTurnPresentationResponse, { capabilityVersion: 3 }>,
): readonly (TurnPresentationItem | TurnPresentationItemV2)[] {
  return presentation.items;
}

export function hasTurnPresentationItems(
  presentation: SessionTurnPresentationResponse | undefined,
): boolean {
  if (presentation === undefined) return false;
  return presentation.capabilityVersion === 3
    ? presentation.turns.some((turn) => turn.items.length > 0)
    : presentation.items.length > 0;
}

/** The V3 production path maps one canonical Turn to one React rendering unit. */
export function SessionConversation(props: SessionConversationProps): ReactElement {
  const conversationRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const turnRunIds = new Set(props.presentation.turns.map((turn) => turn.runId));
  const pendingUsers = (props.optimisticUsers ?? []).filter((item) => !turnRunIds.has(item.runId));

  useEffect(() => {
    const conversation = conversationRef.current;
    const scrollContainer =
      conversation?.closest<HTMLElement>(".workspace-column") ??
      conversation?.closest<HTMLElement>(".session-scroll");
    if (scrollContainer === null || scrollContainer === undefined) return;
    const updateNearBottom = (): void => {
      nearBottom.current =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight <=
        120;
    };
    updateNearBottom();
    scrollContainer.addEventListener("scroll", updateNearBottom, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", updateNearBottom);
  }, []);

  useEffect(() => {
    if (!nearBottom.current) return;
    const conversation = conversationRef.current;
    const scrollContainer =
      conversation?.closest<HTMLElement>(".workspace-column") ??
      conversation?.closest<HTMLElement>(".session-scroll");
    if (scrollContainer === null || scrollContainer === undefined) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [props.presentation.turns, props.optimisticUsers, props.activeRun?.id, props.liveActivity]);

  return createElement(
    "div",
    { className: "session-conversation", ref: conversationRef },
    props.presentation.turns.map((turn) => {
      const optimisticUser = (props.optimisticUsers ?? []).find(
        (item) =>
          item.runId === turn.runId && !turn.items.some((turnItem) => turnItem.kind === "USER"),
      );
      return createElement(TurnPresentation, {
        key: turn.runId,
        turn,
        ...(optimisticUser === undefined ? {} : { optimisticUser }),
        ...(props.activeRun === undefined ? {} : { activeRun: props.activeRun }),
        ...(props.liveActivity === undefined ? {} : { liveActivity: props.liveActivity }),
        ...(props.timeline === undefined ? {} : { timeline: props.timeline }),
      });
    }),
    pendingUsers.map((item) =>
      createElement(
        "article",
        {
          className: "turn-presentation-turn turn-presentation-turn--optimistic",
          key: item.runId,
          "data-run-id": item.runId,
          "data-optimistic-run": true,
        },
        createElement(
          "div",
          { className: "turn-presentation-users", "aria-label": "任务" },
          createElement(
            "article",
            { className: "turn-presentation-item turn-presentation-item--user" },
            createElement("p", { className: "turn-presentation-user-bubble" }, item.text),
          ),
        ),
      ),
    ),
  );
}

/**
 * Render one V3 Run as one conversation Turn.
 *
 * Durable commentary, Tools and verification stay together in one readable process disclosure;
 * final answers and the terminal Run report remain directly below it after the disclosure collapses.
 * Ephemeral deltas are rendered only as bounded live annotations and never become historical facts.
 */
export function TurnPresentation(props: TurnPresentationProps): ReactElement {
  const isCurrentRun = props.activeRun?.id === props.turn.runId;
  const isActive =
    props.activeRun !== undefined && isCurrentRun && isRunStatusActive(props.activeRun.status);
  const liveActivity =
    isActive && props.liveActivity?.runId === props.turn.runId ? props.liveActivity : undefined;
  const timeline =
    isActive && (props.timeline?.runId === undefined || props.timeline.runId === props.turn.runId)
      ? props.timeline
      : undefined;
  const matchingActiveRun = isCurrentRun ? props.activeRun : undefined;
  return createElement(
    "article",
    {
      className: "turn-presentation-turn",
      "data-run-id": props.turn.runId,
      "data-conversation-turn-id": props.turn.conversationTurnId,
      "data-run-status": matchingActiveRun?.status ?? props.turn.runStatus,
      ...(props.optimisticUser === undefined ? {} : { "data-optimistic-run": true }),
    },
    createElement(TurnPresentationContent, {
      items: props.turn.items,
      turn: props.turn,
      ...(props.optimisticUser === undefined ? {} : { optimisticUser: props.optimisticUser }),
      runId: props.turn.runId,
      conversationTurnId: props.turn.conversationTurnId,
      openedAt: Number(props.turn.openedAt),
      ...(props.turn.closedAt === undefined ? {} : { closedAt: Number(props.turn.closedAt) }),
      runStatus: matchingActiveRun?.status ?? props.turn.runStatus,
      isActive,
      ...(matchingActiveRun === undefined ? {} : { activeRun: matchingActiveRun }),
      ...(liveActivity === undefined ? {} : { liveActivity }),
      ...(timeline === undefined ? {} : { timeline }),
    }),
  );
}

/** V1/V2 stay on a clearly isolated legacy Session-wide renderer until old daemons retire. */
export function TurnPresentationFeed(props: TurnPresentationFeedProps): ReactElement {
  if (props.presentation.capabilityVersion === 3) {
    return createElement(SessionConversation, {
      presentation: props.presentation,
      ...(props.activeRun === undefined ? {} : { activeRun: props.activeRun }),
      ...(props.liveActivity === undefined ? {} : { liveActivity: props.liveActivity }),
      ...(props.timeline === undefined ? {} : { timeline: props.timeline }),
    });
  }
  const items = flattenTurnsForLegacyRenderer(props.presentation);
  const latestUser = [...items].reverse().find((item) => item.kind === "USER");
  const legacyRunId = latestUser?.runId;
  const openedAt = latestUser === undefined ? undefined : Number(latestUser.createdAt);
  return createElement(TurnPresentationContent, {
    items,
    ...(legacyRunId === undefined ? {} : { runId: legacyRunId }),
    ...(openedAt === undefined ? {} : { openedAt }),
    isActive:
      props.activeRun === undefined
        ? props.isActive === true
        : isRunStatusActive(props.activeRun.status),
    ...(props.activeRun === undefined ? {} : { activeRun: props.activeRun }),
    ...(props.liveActivity === undefined ? {} : { liveActivity: props.liveActivity }),
    ...(props.timeline === undefined ? {} : { timeline: props.timeline }),
  });
}

interface TurnPresentationContentProps {
  readonly items: readonly (
    TurnPresentationItem | TurnPresentationItemV2 | TurnPresentationItemV3
  )[];
  readonly turn?: SessionTurnPresentationTurnV3 | undefined;
  readonly optimisticUser?: Extract<TranscriptEntry, { kind: "USER" }> | undefined;
  readonly runId?: string | undefined;
  readonly conversationTurnId?: string | undefined;
  readonly openedAt?: number | undefined;
  readonly closedAt?: number | undefined;
  readonly runStatus?: RunStatus | undefined;
  readonly isActive: boolean;
  readonly activeRun?: { readonly id: string; readonly status: RunStatus } | undefined;
  readonly liveActivity?: LiveActivityState | undefined;
  readonly timeline?: TimelineState | undefined;
}

function TurnPresentationContent(props: TurnPresentationContentProps): ReactElement {
  const presentationItems = props.items;
  const liveActivities = (props.liveActivity?.activities ?? []).filter(
    (activity) =>
      (props.runId === undefined || activity.runId === props.runId) &&
      (props.conversationTurnId === undefined ||
        activity.conversationTurnId === undefined ||
        activity.conversationTurnId === props.conversationTurnId),
  );
  const isModelThinking = (props.timeline?.activeLlm.length ?? 0) > 0;
  const modelWait = props.liveActivity?.terminal ? undefined : props.liveActivity?.modelWait;
  const isTaskActive = props.isActive;
  const now = usePresentationNow(isTaskActive || isModelThinking || modelWait !== undefined);
  const verifyingRunId =
    props.activeRun !== undefined &&
    props.activeRun.id === props.runId &&
    props.activeRun.status === "VERIFYING"
      ? props.activeRun.id
      : undefined;
  const openedAt =
    props.openedAt ??
    presentationItems.find((item) => item.kind === "USER")?.createdAt ??
    presentationItems[0]?.createdAt;
  const viewModel =
    props.turn === undefined
      ? undefined
      : projectTurnPresentation(
          props.turn,
          props.activeRun?.id === props.turn.runId ? props.activeRun : undefined,
          now,
        );
  const elapsedDuration =
    viewModel?.elapsedMs ??
    (openedAt === undefined
      ? undefined
      : Math.max(
          0,
          (props.closedAt ??
            presentationItems.find((item) => item.kind === "RUN_SUMMARY")?.createdAt ??
            (!isRunStatusActive(props.runStatus ?? props.activeRun?.status ?? "PENDING")
              ? presentationItems.reduce(
                  (latest, item) => Math.max(latest, Number(item.createdAt)),
                  openedAt,
                )
              : now)) - Number(openedAt),
        ));
  const taskElapsed =
    elapsedDuration === undefined ? undefined : formatTaskElapsed(elapsedDuration);
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
  const finalAnswers =
    viewModel?.finalAnswerItems ??
    durableAssistantItems.filter(
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
  const summaries =
    viewModel?.runSummaries.filter(
      (item) =>
        item.runStatus !== "COMPLETED" ||
        !finalAnswers.some((answer) => answer.runId === item.runId),
    ) ??
    presentationItems.filter((item) => {
      if (item.kind !== "RUN_SUMMARY") return false;
      return !(
        item.runStatus === "COMPLETED" && finalAnswers.some((answer) => answer.runId === item.runId)
      );
    });
  const processItems =
    viewModel?.processItems ??
    presentationItems.filter(
      (item) =>
        item.kind !== "USER" &&
        item.kind !== "RUN_SUMMARY" &&
        !(item.kind === "ASSISTANT" && item.phase === "FINAL_ANSWER"),
    );
  const userItems =
    viewModel?.userItems ?? presentationItems.filter((item) => item.kind === "USER");
  const finalItems = [...finalAnswers, ...summaries];
  const activityCount =
    (viewModel?.activityCount ?? processItems.length) +
    processActivities.length +
    modelDrafts.length;
  const hasProcess =
    processItems.length > 0 ||
    processActivities.length > 0 ||
    modelDrafts.length > 0 ||
    modelWait !== undefined ||
    isModelThinking ||
    isTaskActive;
  const [expanded, setExpanded] = useState(isTaskActive);
  const wasActive = useRef(isTaskActive);

  useEffect(() => {
    const active = isTaskActive;
    if (active) setExpanded(true);
    else if (wasActive.current) setExpanded(false);
    wasActive.current = active;
  }, [isTaskActive]);

  return createElement(
    "div",
    {
      className: "turn-presentation-feed",
    },
    userItems.length === 0 && props.optimisticUser === undefined
      ? null
      : createElement(
          "div",
          { className: "turn-presentation-users", "aria-label": "任务" },
          userItems.length === 0
            ? createElement(
                "article",
                { className: "turn-presentation-item turn-presentation-item--user" },
                createElement(
                  "p",
                  { className: "turn-presentation-user-bubble" },
                  props.optimisticUser?.text,
                ),
              )
            : userItems.map((item) => renderItem(item)),
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
              processSummary(isTaskActive, activityCount),
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
            { className: "turn-presentation-body", tabIndex: 0 },
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
                        title: activity.text,
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
                  {
                    className: "turn-presentation-live",
                    "aria-label": "实时活动",
                    ...(props.runId === undefined ? {} : { "data-run-id": props.runId }),
                    ...(props.conversationTurnId === undefined
                      ? {}
                      : { "data-conversation-turn-id": props.conversationTurnId }),
                  },
                  processActivities.map((activity) =>
                    createElement(
                      "div",
                      {
                        className: `turn-presentation-live-item turn-presentation-live-item--${activity.status.toLowerCase()}`,
                        key: activity.id,
                        ...(activity.kind === "TOOL_ACTIVITY"
                          ? { "data-tool-category": activity.category }
                          : {}),
                        ...(activity.kind === "TOOL_ACTIVITY" &&
                        activity.toolInvocationId !== undefined
                          ? { "data-tool-invocation-id": activity.toolInvocationId }
                          : {}),
                        title: activity.text,
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
      const category = "category" in item ? item.category : undefined;
      return createElement(
        "article",
        {
          className: `turn-presentation-item turn-presentation-item--tool turn-presentation-item--${item.status.toLowerCase()}`,
          key: item.id,
          ...(category === undefined ? {} : { "data-tool-category": category }),
          "data-tool-invocation-id": item.toolInvocationId,
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
                    {
                      key: `${item.id}:effect:${index}`,
                      title: formatToolEffect(effect),
                      className: "turn-presentation-tool-effect",
                    },
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

function processSummary(active: boolean, activityCount: number): string {
  if (active && activityCount === 0) return "正在启动任务";
  return active ? `${activityCount} 项活动 · 运行中` : `${activityCount} 项活动`;
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
