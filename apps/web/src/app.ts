import { createElement, useEffect, useState, type ReactElement } from "react";
import {
  bootstrapWebHost,
  createInitialWebHostState,
  type WebHostClient,
  type WebHostState,
} from "./host/bootstrap.js";

export function WebHostApp(props: {
  readonly client: WebHostClient;
  readonly launchContext: unknown;
}): ReactElement {
  const [state, setState] = useState<WebHostState>(createInitialWebHostState);

  useEffect(() => {
    let active = true;
    void bootstrapWebHost({
      ...props,
      onState: (nextState) => {
        if (active) setState(nextState);
      },
    });
    return () => {
      active = false;
    };
  }, [props.client, props.launchContext]);

  return createElement(
    "main",
    { className: "host-shell" },
    createElement(
      "section",
      { className: "host-card", "aria-labelledby": "host-title" },
      createElement(
        "div",
        { className: "host-mark", "aria-hidden": "true" },
        createElement("span"),
        createElement("span"),
        createElement("span"),
      ),
      createElement("p", { className: "host-kicker" }, "PRODUCTION WEB HOST"),
      createElement("h1", { id: "host-title" }, "Caelush"),
      createElement("p", { className: "host-intro" }, "由本地 daemon 驱动的安全工作区入口。"),
      createElement(
        "div",
        { className: `host-status host-status--${state.bootstrap.toLowerCase()}`, role: "status" },
        createElement("span", { className: "host-status-dot", "aria-hidden": "true" }),
        createElement("span", null, statusLabel(state)),
      ),
      state.workspace === undefined
        ? null
        : createElement(
            "dl",
            { className: "host-details" },
            createElement("dt", null, "工作区"),
            createElement("dd", null, state.workspace.path),
            state.info === undefined
              ? null
              : createElement(
                  "div",
                  { className: "host-meta" },
                  createElement("dt", null, "服务版本"),
                  createElement("dd", null, state.info.daemonVersion),
                  createElement("dt", null, "协议版本"),
                  createElement("dd", null, `v${state.info.protocolVersion}`),
                ),
          ),
      state.error === undefined
        ? null
        : createElement("p", { className: "host-error" }, state.error.message),
      state.bootstrap === "READY"
        ? createElement("p", { className: "host-ready" }, "Production Web Host Ready")
        : null,
    ),
  );
}

function statusLabel(state: WebHostState): string {
  switch (state.bootstrap) {
    case "BOOTING":
      return "正在启动";
    case "CONNECTING":
      return "正在连接";
    case "CHECKING_PROTOCOL":
      return "正在检查协议";
    case "READY":
      return "已连接";
    case "DAEMON_UNAVAILABLE":
      return "服务不可用";
    case "PROTOCOL_INCOMPATIBLE":
      return "协议不兼容";
    case "WORKSPACE_MISSING":
      return "工作区上下文缺失";
    case "BOOTSTRAP_INVALID":
      return "启动上下文无效";
  }
}
