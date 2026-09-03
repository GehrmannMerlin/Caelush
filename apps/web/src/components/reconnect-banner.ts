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
}: ReconnectBannerProps): ReactElement {
  return createElement(
    "div",
    { className: `reconnect-banner reconnect-banner--${state.toLowerCase()}`, role: "status" },
    createElement("span", null, state),
    state === "RECONNECTING" && attempt !== undefined
      ? createElement("span", null, `第 ${attempt} / 6 次`)
      : null,
    state === "DISCONNECTED" && onReconnect !== undefined
      ? createElement("button", { type: "button", onClick: onReconnect }, "重新连接")
      : null,
  );
}
