import { createElement, useEffect, useState, type ReactElement } from "react";
import type { ModelWaitState } from "@caelush/client";

export interface ModelWaitNoticeProps {
  readonly modelWait?: ModelWaitState | undefined;
  readonly isModelActive: boolean;
  readonly now: number;
}

export function ModelWaitNotice(props: ModelWaitNoticeProps): ReactElement | null {
  const wait = props.modelWait;
  if (wait === undefined && !props.isModelActive) return null;

  const message = modelWaitMessage(wait, props.now);
  const isExhausted = wait?.phase === "RETRY_EXHAUSTED";
  const activity = wait === undefined ? undefined : activityDescription(wait);
  return createElement(
    "section",
    {
      className: "turn-presentation-thinking",
      role: isExhausted ? "alert" : "status",
      "aria-live": isExhausted ? "assertive" : "polite",
      "aria-label": isExhausted ? "模型请求失败" : "模型正在思考",
    },
    createElement("span", { className: "turn-presentation-thinking-title" }, message.title),
    message.detail.length === 0
      ? null
      : createElement("span", { className: "turn-presentation-thinking-detail" }, message.detail),
    activity === undefined
      ? null
      : createElement("span", { className: "model-wait-activity", "aria-hidden": true }, activity),
  );
}

export function usePresentationNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const refresh = (): void => setNow(Date.now());
    const timer = globalThis.setInterval(refresh, 1_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      globalThis.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [active]);

  return now;
}

export function modelWaitMessage(
  wait: ModelWaitState | undefined,
  now: number,
): { readonly title: string; readonly detail: string } {
  if (wait === undefined) return { title: "思考中", detail: "" };

  const retryOrdinal = wait.retryOrdinal ?? Math.max(0, (wait.attempt ?? 1) - 1);
  const maxRetries = wait.maxRetries ?? Math.max(0, (wait.maxAttempts ?? 1) - 1);
  const retryCount = `${retryOrdinal}/${maxRetries}`;
  switch (wait.phase) {
    case "WAITING_PROVIDER": {
      const waitingForFirstResponse = wait.providerEventReceived !== true;
      const hasWaitedThirtySeconds = now - wait.lastActivityAt >= 30_000;
      if (waitingForFirstResponse && hasWaitedThirtySeconds) {
        return { title: "正在等待模型响应", detail: "" };
      }
      return { title: "思考中", detail: "" };
    }
    case "RECEIVING_PROVIDER_DATA":
      return { title: "思考中", detail: "正在接收模型响应" };
    case "NO_RECENT_ACTIVITY":
      return { title: "思考中", detail: "模型近期没有返回新数据，仍在等待" };
    case "CANCELLING_IDLE_STREAM": {
      const idleTimeoutMs =
        wait.idleTimeoutMs !== undefined &&
        Number.isSafeInteger(wait.idleTimeoutMs) &&
        wait.idleTimeoutMs > 0
          ? wait.idleTimeoutMs
          : 300_000;
      return {
        title: "正在停止本次请求",
        detail: `Provider 连续 ${formatDuration(idleTimeoutMs)}没有返回数据，正在终止本次请求`,
      };
    }
    case "ATTEMPT_FAILED":
      return { title: "模型调用暂时失败", detail: "正在确定恢复方式" };
    case "RETRY_SCHEDULED": {
      const remainingMs = Math.max(0, (wait.nextAttemptAt ?? now) - now);
      const remainingSeconds = Math.ceil(remainingMs / 1_000);
      return {
        title: "正在等待重试",
        detail: `将在 ${remainingSeconds} 秒后重新连接 ${retryCount}`,
      };
    }
    case "RETRYING":
      return { title: "正在重新连接", detail: `正在重新连接 ${retryCount}` };
    case "FALLBACK_SELECTED": {
      const transport = safeTransportId(wait.toTransportId);
      return {
        title: "已切换备用传输",
        detail:
          transport === undefined
            ? `正在重新连接 ${retryCount}`
            : `已切换备用传输 ${transport} · 正在重新连接 ${retryCount}`,
      };
    }
    case "RETRY_EXHAUSTED":
      return {
        title: "模型请求失败",
        detail: `重试已耗尽：${maxRetries}/${maxRetries} 次重试后模型请求失败`,
      };
  }
}

function activityDescription(wait: ModelWaitState): string | undefined {
  if (wait.providerEventReceived !== true) return undefined;

  const timestamp = new Date(wait.lastActivityAt);
  const time = Number.isNaN(timestamp.getTime())
    ? "未知"
    : timestamp.toLocaleTimeString("zh-CN", { hour12: false });
  return `最后活动时间：${time}`;
}

function safeTransportId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = value.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 64);
  return safe.length === 0 ? undefined : safe;
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 3_600_000) return `${formatDecimal(durationMs / 3_600_000)} 小时`;
  if (durationMs >= 60_000) return `${formatDecimal(durationMs / 60_000)} 分钟`;
  return `${formatDecimal(durationMs / 1_000)} 秒`;
}

function formatDecimal(value: number): string {
  return Number(value.toFixed(1)).toString();
}
