import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import type { SessionId } from "@caelush/protocol";
import { createInitialTimelineState } from "@caelush/client";
import {
  bootstrapWebHost,
  createInitialWebHostState,
  type WebHostState,
} from "./host/bootstrap.js";
import {
  WebSessionManager,
  type WebSessionClient,
  type WebSessionSnapshot,
} from "./application/session-manager.js";
import { derivePromptTitle } from "./application/prompt.js";
import { PromptComposer } from "./components/prompt-composer.js";
import { SessionSidebar, sessionDisplayTitle } from "./components/session-sidebar.js";
import { SessionWorkspace } from "./components/session-workspace.js";

const EMPTY_SESSION_SNAPSHOT: WebSessionSnapshot = {
  status: "IDLE",
  candidates: [],
  runs: [],
  history: [],
  activeRuns: [],
  timeline: createInitialTimelineState(),
  isDraft: false,
  composerEnabled: false,
  submission: "IDLE",
};

export function WebHostApp(props: {
  readonly client: WebSessionClient;
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

  const sessionManager = useMemo(() => {
    if (state.bootstrap !== "READY" || state.info === undefined || state.workspace === undefined) {
      return undefined;
    }
    return new WebSessionManager({
      client: props.client,
      info: state.info,
      workspace: state.workspace,
    });
  }, [props.client, state.bootstrap, state.info, state.workspace]);

  useEffect(() => {
    if (sessionManager === undefined) return;
    void sessionManager.loadSessions();
    return () => sessionManager.dispose();
  }, [sessionManager]);

  const subscribe = useCallback(
    (listener: () => void) => sessionManager?.subscribe(() => listener()) ?? (() => undefined),
    [sessionManager],
  );
  const getSnapshot = useCallback(
    () => sessionManager?.getSnapshot() ?? EMPTY_SESSION_SNAPSHOT,
    [sessionManager],
  );
  const sessionSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (state.bootstrap !== "READY" || sessionManager === undefined) {
    return renderHostBootstrap(state);
  }
  return renderSessionApp({ manager: sessionManager, snapshot: sessionSnapshot, host: state });
}

function renderSessionApp(input: {
  readonly manager: WebSessionManager;
  readonly snapshot: WebSessionSnapshot;
  readonly host: WebHostState;
}): ReactElement {
  const { manager, snapshot, host } = input;
  const selectedCandidate = snapshot.candidates.find(
    (candidate) => candidate.session.id === snapshot.selectedSessionId,
  );
  const title = snapshot.isDraft
    ? "新会话"
    : selectedCandidate !== undefined
      ? sessionDisplayTitle(selectedCandidate)
      : snapshot.selectedSession?.title !== undefined
        ? derivePromptTitle(snapshot.selectedSession.title)
        : "选择一个会话";
  const canInteract = snapshot.status === "READY" && snapshot.activeRuns.length === 0;
  const onNewSession = () => manager.beginDraft();
  const onSelectSession = (sessionId: SessionId) => {
    void manager.selectSession(sessionId);
  };
  const onSubmit = (prompt: string) => manager.submitPrompt(prompt);

  return createElement(
    "main",
    { className: "web-app-shell" },
    createElement(
      "header",
      { className: "web-topbar" },
      createElement(
        "div",
        { className: "brand-lockup" },
        createElement("span", { className: "brand-symbol", "aria-hidden": "true" }, "C"),
        createElement("span", { className: "brand-name" }, "Caelush"),
      ),
      createElement(
        "div",
        { className: "connection-summary", role: "status" },
        createElement("span", { className: "connection-dot", "aria-hidden": "true" }),
        "已连接",
      ),
    ),
    createElement(
      "div",
      { className: "workspace-frame" },
      createElement(SessionSidebar, {
        candidates: snapshot.candidates,
        selectedSessionId: snapshot.selectedSessionId,
        isDraft: snapshot.isDraft,
        canInteract,
        onNewSession,
        onSelectSession,
      }),
      createElement(
        "div",
        { className: "workspace-column" },
        createElement(
          "div",
          { className: "workspace-context" },
          createElement("span", null, "工作区"),
          createElement("code", null, host.workspace?.path ?? ""),
        ),
        createElement(SessionWorkspace, {
          title,
          activeRun: snapshot.activeRun,
          history: snapshot.history,
          timeline: snapshot.timeline,
          composer: createElement(PromptComposer, {
            disabled: !snapshot.composerEnabled,
            submission: snapshot.submission,
            error: snapshot.error,
            onSubmit,
          }),
        }),
      ),
    ),
  );
}

function renderHostBootstrap(state: WebHostState): ReactElement {
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
