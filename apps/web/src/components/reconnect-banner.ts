import { createElement, type ReactElement } from "react";
import type { WebTransportState } from "../application/session-manager.js";

export interface ReconnectBannerProps {
  readonly state: WebTransportState;
  readonly attempt?: number | undefined;
  readonly onReconnect?: (() => void) | undefined;
}

export function ReconnectBanner({
  state,
  attempt,
  onReconnect,
}: ReconnectBannerProps): ReactElement | null {
  if (state === "CONNECTED") return null;
  return createElement(
    "div",
    { className: `reconnect-banner reconnect-banner--${state.toLowerCase()}`, role: "status" },
    createElement(
      "span",
      null,
      state === "RECONNECTING" ? "正在重新连接本地 Agent 服务……" : "连接已断开。",
    ),
    state === "RECONNECTING" && attempt !== undefined
      ? createElement("span", null, `第 ${attempt} / 6 次`)
      : null,
    state === "DISCONNECTED" ? createElement("span", null, "任务可能仍在后台运行。") : null,
    state === "DISCONNECTED" && onReconnect !== undefined
      ? createElement("button", { type: "button", onClick: onReconnect }, "重新连接")
      : null,
  );
}
