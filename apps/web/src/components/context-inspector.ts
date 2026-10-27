import { createElement, useState, type ReactElement } from "react";
import type {
  ContextUsageProjection,
  HistoryLookupQuery,
  HistoryLookupResponse,
  RunProcessProjection,
  RunId,
} from "@caelush/protocol";

export function ContextInspector(props: {
  readonly usage: ContextUsageProjection;
  readonly process?: RunProcessProjection | undefined;
  readonly onReadHistory?:
    ((runId: RunId, query: HistoryLookupQuery) => Promise<HistoryLookupResponse>) | undefined;
  readonly onContinueResourceGuard?: (() => Promise<boolean>) | undefined;
}): ReactElement {
  const usage = props.usage;
  const contextWindowTokens = usage.rawContextWindowTokens ?? usage.contextWindowTokens;
  const estimateTokens = usage.fullRequestInputEstimateTokens ?? usage.estimatedInputTokens;
  const isLegacyEstimate = usage.fullRequestInputEstimateTokens === undefined;
  const rawRatio =
    usage.fullWindowUsedRatio ??
    (contextWindowTokens === 0 ? 0 : estimateTokens / contextWindowTokens);
  const ratio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio)) : 0;
  const percentage = Math.round(ratio * 100);
  const runCacheHitRate = usage.promptCache?.metricsV2?.fullRun.mainAgent.hitRate;
  const cacheHitRate = runCacheHitRate ?? usage.promptCache?.latestHitRate;

  return createElement(
    "div",
    { className: "context-inspector", role: "dialog", "aria-label": "工作上下文用量详情" },
    createElement(
      "div",
      { className: "context-inspector-heading" },
      createElement(
        "div",
        { className: "context-inspector-heading-copy" },
        createElement("strong", null, "工作上下文"),
        createElement(
          "span",
          {
            className: `context-inspector-pressure context-inspector-pressure--${usage.pressureState}`,
          },
          pressureLabel(usage.pressureState),
        ),
      ),
      createElement("strong", { className: "context-inspector-percentage" }, `${percentage}%`),
    ),
    createElement(
      "div",
      {
        className: `context-inspector-progress context-inspector-progress--${usage.pressureState}`,
        role: "progressbar",
        "aria-label": "上下文容量使用率",
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": percentage,
        "aria-valuetext": `${percentage}% 已用，${estimateTokens.toLocaleString()} / ${contextWindowTokens.toLocaleString()} tokens`,
      },
      createElement("span", { style: { width: `${percentage}%` } }),
    ),
    createElement(
      "div",
      { className: "context-inspector-capacity context-inspector-capacity--window" },
      createElement("span", null, isLegacyEstimate ? "旧版估算" : "估算已用"),
      createElement(
        "strong",
        null,
        `${estimateTokens.toLocaleString()} / ${contextWindowTokens.toLocaleString()} tokens`,
      ),
    ),
    createElement(
      "div",
      {
        className: "context-inspector-capacity context-inspector-capacity--remaining",
        title: "为本轮输出和安全余量预留空间；接近预算时才整理旧历史。",
      },
      createElement("span", null, "可用输入预算"),
      createElement("strong", null, `${usage.remainingTokens.toLocaleString()} tokens`),
    ),
    (props.process ?? usage.process) === undefined
      ? null
      : createRunProcessPanel({
          runId: usage.runId,
          process: props.process ?? usage.process,
          onReadHistory: props.onReadHistory,
          onContinueResourceGuard: props.onContinueResourceGuard,
        }),
    createElement(
      "div",
      { className: "context-inspector-metrics", "aria-label": "其他关键指标" },
      createElement(
        "div",
        { className: "context-inspector-metric" },
        createElement("span", null, "缓存命中率"),
        createElement("strong", null, formatRate(cacheHitRate)),
        createElement(
          "small",
          null,
          cacheMetricSource(runCacheHitRate, usage.promptCache?.latestHitRate),
        ),
      ),
      createElement(
        "div",
        { className: "context-inspector-metric" },
        createElement("span", null, "本会话压缩"),
        createElement("strong", null, `${usage.compactionCount.toLocaleString()} 次`),
        usage.lastCompaction === undefined
          ? null
          : createElement(
              "small",
              null,
              `${compactionReasonLabel(usage.lastCompaction.reason)} · ${
                usage.lastCompaction.quality === "DEGRADED" ? "降级摘要" : "语义摘要已通过校验"
              }`,
            ),
        usage.lastCompaction?.tokensBefore === undefined ||
          usage.lastCompaction.tokensAfter === undefined
          ? null
          : createElement(
              "small",
              null,
              `最近：${formatTokens(usage.lastCompaction.tokensBefore)} → ${formatTokens(
                usage.lastCompaction.tokensAfter,
              )}（−${compactionSavedPercent(
                usage.lastCompaction.tokensBefore,
                usage.lastCompaction.tokensAfter,
              )}%）`,
            ),
      ),
    ),
  );
}

function createRunProcessPanel(props: {
  readonly runId: RunId;
  readonly process: RunProcessProjection | undefined;
  readonly onReadHistory?:
    ((runId: RunId, query: HistoryLookupQuery) => Promise<HistoryLookupResponse>) | undefined;
  readonly onContinueResourceGuard?: (() => Promise<boolean>) | undefined;
}): ReactElement {
  const process = props.process;
  if (process === undefined) return createElement("span");
  if (process.kind === "DEGRADED_CONTINUATION") {
    return createElement(
      "section",
      { className: "context-inspector-process", role: "status", "aria-label": "任务接续状态" },
      createElement("strong", null, "任务正在降级接续"),
      createElement(
        "p",
        null,
        "摘要未能完整恢复，系统保留了原始要求、执行状态和可回查引用。展开引用可读取脱敏后的原文。",
      ),
      ...process.sourceRefs.map((sourceRef) =>
        createElement(HistoryReferenceViewer, {
          key: sourceRef,
          runId: props.runId,
          sourceRef,
          ...(props.onReadHistory === undefined ? {} : { onReadHistory: props.onReadHistory }),
        }),
      ),
    );
  }
  if (process.kind === "ACTION_REQUIRED") {
    return createElement(ResourceReconciliationPanel, {
      toolName: process.toolName,
      reasonCode: process.reasonCode,
      ...(props.onContinueResourceGuard === undefined
        ? {}
        : { onContinue: props.onContinueResourceGuard }),
    });
  }
  if (process.kind === "PROVIDER_WAIT") {
    const resumeAt = new Date(process.nextAttemptAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return createElement(
      "section",
      { className: "context-inspector-process", role: "status", "aria-label": "模型服务等待状态" },
      createElement("strong", null, "模型服务连续不可用，任务已保存并等待自动接续"),
      createElement(
        "p",
        null,
        `预计 ${resumeAt} 开始第 ${process.episode} 段重试` +
          (process.totalAttempts === undefined ? "" : `；此前已失败 ${process.totalAttempts} 次`) +
          `；原因代码 ${process.errorCode}。你可以随时取消任务。`,
      ),
    );
  }
  if (process.kind === "RETRY_WAIT") {
    const delay = Math.max(0, process.nextAttemptAt - Date.now());
    const minutes = Math.floor(delay / 60_000);
    const seconds = Math.ceil((delay % 60_000) / 1_000);
    if (process.errorCode === "LLM_OUTPUT_TRUNCATED") {
      return createElement(
        "section",
        {
          className: "context-inspector-process",
          role: "status",
          "aria-label": "模型输出恢复状态",
        },
        createElement("strong", null, "模型输出已截断，正在进行一次有界恢复"),
        createElement(
          "p",
          null,
          `预计约 ${minutes} 分 ${seconds} 秒后，以第 ${process.attempt}/${process.maxAttempts} 次请求继续。`,
        ),
      );
    }
    return createElement(
      "section",
      { className: "context-inspector-process", role: "status", "aria-label": "模型重试状态" },
      createElement("strong", null, "模型服务暂时不可用，任务正在等待重试"),
      createElement(
        "p",
        null,
        `当前重试段 ${process.episode ?? 1}，本段 ${process.attempt}/${process.maxAttempts} 次` +
          (process.totalAttempts === undefined ? "" : `，累计 ${process.totalAttempts} 次`) +
          `；约 ${minutes} 分 ${seconds} 秒后继续。`,
      ),
    );
  }
  if (process.kind === "COMPACTING") {
    const label =
      process.stage === "PREPARING"
        ? "正在整理历史前保护任务状态"
        : process.stage === "SUMMARIZING"
          ? "正在生成并校验历史摘要"
          : "正在重建后续请求上下文";
    return createElement(
      "section",
      { className: "context-inspector-process", role: "status", "aria-label": "上下文整理状态" },
      createElement("strong", null, label),
      createElement("p", null, `触发原因：${compactionReasonLabel(process.reason)}。`),
    );
  }
  const label =
    process.cause === "TOOL_FEEDBACK"
      ? "工具返回问题，正在根据具体反馈修正"
      : process.cause === "VERIFICATION_FEEDBACK"
        ? "检查未通过，正在根据检查结果修复"
        : "正在调整执行策略并继续";
  return createElement(
    "section",
    { className: "context-inspector-process", role: "status", "aria-label": "任务调整状态" },
    createElement("strong", null, label),
  );
}

export function ContextRunProcessPanel(props: {
  readonly runId: RunId;
  readonly process: RunProcessProjection;
  readonly onReadHistory?:
    ((runId: RunId, query: HistoryLookupQuery) => Promise<HistoryLookupResponse>) | undefined;
  readonly onContinueResourceGuard?: (() => Promise<boolean>) | undefined;
}): ReactElement {
  return createRunProcessPanel(props);
}

export function contextRunProcessShortLabel(process: RunProcessProjection): string {
  switch (process.kind) {
    case "COMPACTING":
      return "正在整理上下文";
    case "RETRY_WAIT":
    case "PROVIDER_WAIT":
      return "正在等待模型服务恢复";
    case "DEGRADED_CONTINUATION":
      return "任务正在降级接续";
    case "ACTION_REQUIRED":
      return "有一步操作需要核对";
    case "CORRECTING":
      return "正在根据反馈修正";
    default:
      return "任务处理中";
  }
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString();
}

function compactionSavedPercent(before: number, after: number): number {
  if (before <= 0) return 0;
  return Math.round((1 - after / before) * 100);
}

function compactionReasonLabel(
  reason: "PROACTIVE_PRESSURE" | "SELECTION_PRESSURE" | "FORCED_PROVIDER_OVERFLOW",
): string {
  switch (reason) {
    case "PROACTIVE_PRESSURE":
      return "空间接近本轮预算，需要整理较早历史";
    case "SELECTION_PRESSURE":
      return "当前可选信息过多，需要整理历史";
    case "FORCED_PROVIDER_OVERFLOW":
      return "模型服务提示本轮输入超出窗口";
  }
}

function ResourceReconciliationPanel(props: {
  readonly toolName: string;
  readonly reasonCode: "UNAVAILABLE" | "DOES_NOT_MATCH" | "INCONCLUSIVE" | "UNSUPPORTED";
  readonly onContinue?: () => Promise<boolean>;
}): ReactElement {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const reason = resourceReasonLabel(props.reasonCode);
  const onClick = async () => {
    if (props.onContinue === undefined || checking) return;
    setChecking(true);
    setMessage(undefined);
    try {
      const continued = await props.onContinue();
      setMessage(
        continued
          ? "已完成一次只读核对。若结果仍无法确认，任务会继续等待，不会重放原操作。"
          : "暂时无法完成核对，请稍后重试。",
      );
    } catch {
      setMessage("暂时无法完成核对，请稍后重试。");
    } finally {
      setChecking(false);
    }
  };
  return createElement(
    "section",
    { className: "context-inspector-process", role: "status", "aria-label": "操作结果待核对" },
    createElement("strong", null, "有一步操作的结果暂时无法确认"),
    createElement("p", null, `工具 ${props.toolName}：${reason}。系统不会自动重放这一步。`),
    props.onContinue === undefined
      ? null
      : createElement(
          "button",
          { type: "button", disabled: checking, onClick },
          checking ? "正在只读核对…" : "只读核对并继续",
        ),
    message === undefined ? null : createElement("small", null, message),
  );
}

function HistoryReferenceViewer(props: {
  readonly runId: RunId;
  readonly sourceRef: string;
  readonly onReadHistory?:
    ((runId: RunId, query: HistoryLookupQuery) => Promise<HistoryLookupResponse>) | undefined;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Extract<HistoryLookupResponse, { kind: "PAGE" }>["items"]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [unavailable, setUnavailable] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const load = async (nextCursor?: string) => {
    if (props.onReadHistory === undefined || loading) return;
    setLoading(true);
    setLoadError(false);
    setUnavailable(undefined);
    try {
      const page = await props.onReadHistory(props.runId, {
        sourceRef: props.sourceRef,
        maxBytes: 8 * 1024,
        ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      });
      setLoaded(true);
      if (page.kind === "UNAVAILABLE") {
        setUnavailable(historyUnavailableLabel(page.reason));
        return;
      }
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) void load();
  };
  return createElement(
    "div",
    { className: "context-history-reference" },
    createElement(
      "button",
      {
        type: "button",
        className: "context-history-reference-toggle",
        disabled: props.onReadHistory === undefined,
        "aria-expanded": open,
        onClick: toggle,
      },
      open ? "收起原文" : "查看原文",
    ),
    createElement("code", null, props.sourceRef),
    open
      ? createElement(
          "div",
          { className: "context-history-reference-content" },
          createElement("p", null, "只展示可见对话文本；隐藏推理和私有 Provider 数据不会返回。"),
          loading ? createElement("p", { role: "status" }, "正在读取原文…") : null,
          loadError
            ? createElement(
                "button",
                { type: "button", onClick: () => void load(cursor) },
                "读取失败，重试",
              )
            : null,
          unavailable === undefined ? null : createElement("p", { role: "alert" }, unavailable),
          ...items.map((item) =>
            createElement(
              "article",
              { className: "context-history-item", key: `${item.sequence}:${item.messageId}` },
              createElement("strong", null, `${historyRoleLabel(item.role)} · #${item.sequence}`),
              createElement("pre", null, item.text),
            ),
          ),
          cursor === undefined || loading
            ? null
            : createElement(
                "button",
                { type: "button", onClick: () => void load(cursor) },
                "继续读取",
              ),
        )
      : null,
  );
}

function resourceReasonLabel(
  reason: "UNAVAILABLE" | "DOES_NOT_MATCH" | "INCONCLUSIVE" | "UNSUPPORTED",
): string {
  switch (reason) {
    case "UNAVAILABLE":
      return "核对工具当前不可用";
    case "DOES_NOT_MATCH":
      return "当前工作区状态与预期不一致";
    case "INCONCLUSIVE":
      return "现有证据不足以判断是否已完成";
    case "UNSUPPORTED":
      return "此类操作暂不支持自动核对";
  }
}

function historyRoleLabel(role: "USER" | "ASSISTANT" | "TOOL"): string {
  switch (role) {
    case "USER":
      return "用户要求";
    case "ASSISTANT":
      return "助手记录";
    case "TOOL":
      return "工具结果";
  }
}

function historyUnavailableLabel(
  reason: Extract<HistoryLookupResponse, { kind: "UNAVAILABLE" }>["reason"],
): string {
  switch (reason) {
    case "UNKNOWN_SOURCE":
      return "引用格式无法识别。";
    case "OUT_OF_SCOPE":
      return "该原文不属于当前会话，无法读取。";
    case "SOURCE_UNAVAILABLE":
      return "原文暂时无法读取。";
    case "UNSUPPORTED_VERSION":
      return "当前版本不支持读取此引用。";
    case "INTEGRITY_MISMATCH":
      return "引用校验未通过，系统拒绝返回内容。";
    case "CURSOR_INVALID":
      return "读取位置无效，请重新展开引用。";
  }
}

function formatRate(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? "暂无数据"
    : `${(value * 100).toFixed(1)}%`;
}

function cacheMetricSource(runRate: number | undefined, latestRate: number | undefined): string {
  if (runRate !== undefined && Number.isFinite(runRate)) return "当前 Run";
  return latestRate === undefined || !Number.isFinite(latestRate) ? "暂无缓存数据" : "最近请求";
}

function pressureLabel(value: ContextUsageProjection["pressureState"]): string {
  switch (value) {
    case "NORMAL":
      return "正常";
    case "PROACTIVE":
      return "接近上限";
    case "EMERGENCY":
      return "紧急";
  }
}
