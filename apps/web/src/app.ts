import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactElement,
} from "react";
import type { SessionId, WorkspaceId, WorkspaceRecord, WorkspaceRef } from "@caelush/protocol";
import { createInitialLiveActivityState, createInitialTimelineState } from "@caelush/client";
import { PanelLeft } from "lucide-react";
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
import {
  WebWorkspaceManager,
  WorkspaceSelectionStore,
  type WorkspaceManagerClient,
  type WorkspaceManagerState,
} from "./application/workspace-manager.js";
import { derivePromptTitle } from "./application/prompt.js";
import { PromptComposer } from "./components/prompt-composer.js";
import { SessionWorkspace } from "./components/session-workspace.js";
import { SessionSelectionStore } from "./application/session-persistence.js";
import { ReconnectBanner } from "./components/reconnect-banner.js";
import { WorkspaceSidebar } from "./components/workspace-sidebar.js";
import { WorkspaceEmptyState } from "./components/workspace-empty-state.js";
import { WorkspaceDialog } from "./components/workspace-dialog.js";
import { ModelPicker } from "./components/model-picker.js";
import { SettingsSurface } from "./components/settings-surface.js";

const sessionSelectionStore = new SessionSelectionStore();
const workspaceSelectionStore = new WorkspaceSelectionStore();

const EMPTY_SESSION_SNAPSHOT: WebSessionSnapshot = {
  status: "IDLE",
  candidates: [],
  runs: [],
  history: [],
  turnPresentation: undefined,
  activeRuns: [],
  timeline: createInitialTimelineState(),
  liveActivity: createInitialLiveActivityState(),
  isDraft: false,
  composerEnabled: false,
  submission: "IDLE",
  transportState: "CONNECTED",
  controlMode: "NONE",
};

const EMPTY_WORKSPACE_STATE: WorkspaceManagerState = {
  status: "IDLE",
  workspaces: [],
  expandedWorkspaceIds: [],
  sessionSummaries: {},
};

export function WebHostApp(props: {
  readonly client: WebSessionClient;
  readonly launchContext?: unknown | undefined;
  readonly initialWorkspaceId?: WorkspaceId | undefined;
}): ReactElement {
  const [state, setState] = useState<WebHostState>(createInitialWebHostState);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspacePickerBusy, setWorkspacePickerBusy] = useState(false);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pendingDraftWorkspaceId = useRef<WorkspaceId | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void bootstrapWebHost({
      client: props.client,
      launchContext: props.launchContext,
      initialWorkspaceId: props.initialWorkspaceId,
      onState: (nextState) => {
        if (active) setState(nextState);
      },
    });
    return () => {
      active = false;
    };
  }, [props.client, props.launchContext, props.initialWorkspaceId]);

  const workspaceManager = useMemo(() => {
    if (state.bootstrap !== "READY") return undefined;
    return new WebWorkspaceManager({
      client: props.client as unknown as WorkspaceManagerClient,
      selectionStore: workspaceSelectionStore,
      initialWorkspaceId: state.initialWorkspaceId,
    });
  }, [props.client, state.bootstrap, state.initialWorkspaceId]);

  useEffect(() => {
    if (workspaceManager === undefined) return;
    void workspaceManager.loadWorkspaces();
    return () => workspaceManager.dispose();
  }, [workspaceManager]);

  const workspaceSubscribe = useCallback(
    (listener: () => void) => workspaceManager?.subscribe(() => listener()) ?? (() => undefined),
    [workspaceManager],
  );
  const workspaceGetSnapshot = useCallback(
    () => workspaceManager?.getSnapshot() ?? EMPTY_WORKSPACE_STATE,
    [workspaceManager],
  );
  const workspaceState = useSyncExternalStore(
    workspaceSubscribe,
    workspaceGetSnapshot,
    workspaceGetSnapshot,
  );

  const selectedWorkspace = workspaceState.workspaces.find(
    (workspace) => workspace.id === workspaceState.selectedWorkspaceId,
  );
  const selectedWorkspaceRef = useMemo<WorkspaceRef | undefined>(
    () =>
      selectedWorkspace === undefined
        ? undefined
        : { id: selectedWorkspace.id, path: selectedWorkspace.canonicalPath },
    [selectedWorkspace],
  );

  const sessionManager = useMemo(() => {
    if (
      state.bootstrap !== "READY" ||
      state.info === undefined ||
      selectedWorkspaceRef === undefined
    ) {
      return undefined;
    }
    return new WebSessionManager({
      client: props.client,
      info: state.info,
      workspace: selectedWorkspaceRef,
      selectionStore: sessionSelectionStore,
    });
  }, [props.client, selectedWorkspaceRef, state.bootstrap, state.info]);

  useEffect(() => {
    if (sessionManager === undefined) return;
    void sessionManager.loadSessions();
    return () => sessionManager.dispose();
  }, [sessionManager]);

  const sessionSubscribe = useCallback(
    (listener: () => void) => sessionManager?.subscribe(() => listener()) ?? (() => undefined),
    [sessionManager],
  );
  const sessionGetSnapshot = useCallback(
    () => sessionManager?.getSnapshot() ?? EMPTY_SESSION_SNAPSHOT,
    [sessionManager],
  );
  const sessionSnapshot = useSyncExternalStore(
    sessionSubscribe,
    sessionGetSnapshot,
    sessionGetSnapshot,
  );
  const sessionCandidateFingerprint = useMemo(
    () =>
      sessionSnapshot.candidates
        .map(
          (candidate) =>
            `${candidate.session.id}:${candidate.lastActivityAt}:${candidate.latestRun?.status ?? ""}`,
        )
        .join("|"),
    [sessionSnapshot.candidates],
  );

  useEffect(() => {
    if (
      workspaceManager === undefined ||
      selectedWorkspace === undefined ||
      sessionSnapshot.status !== "READY" ||
      workspaceState.status !== "READY"
    ) {
      return;
    }
    void workspaceManager.loadWorkspaceSessions(selectedWorkspace.id);
  }, [
    selectedWorkspace?.id,
    sessionCandidateFingerprint,
    sessionSnapshot.status,
    workspaceManager,
    workspaceState.status,
  ]);

  useEffect(() => {
    const pending = pendingDraftWorkspaceId.current;
    if (
      pending === undefined ||
      selectedWorkspace?.id !== pending ||
      sessionManager === undefined ||
      sessionSnapshot.status !== "READY"
    ) {
      return;
    }
    pendingDraftWorkspaceId.current = undefined;
    sessionManager.beginDraft();
  }, [selectedWorkspace?.id, sessionManager, sessionSnapshot.status]);

  if (state.bootstrap !== "READY" || workspaceManager === undefined) {
    return renderHostBootstrap(state);
  }

  const closeSidebar = () => setSidebarOpen(false);
  const selectedWorkspaceId = selectedWorkspace?.id;
  const onSelectWorkspace = (workspaceId: WorkspaceId) => {
    setWorkspaceActionError(undefined);
    void workspaceManager.selectWorkspace(workspaceId);
    closeSidebar();
  };
  const onNewSession = (workspaceId: WorkspaceId) => {
    if (workspaceId !== selectedWorkspaceId) {
      pendingDraftWorkspaceId.current = workspaceId;
      void workspaceManager.selectWorkspace(workspaceId);
    } else {
      sessionManager?.beginDraft();
    }
    closeSidebar();
  };
  const onSelectSession = (workspaceId: WorkspaceId, sessionId: SessionId) => {
    pendingDraftWorkspaceId.current = undefined;
    if (workspaceId !== selectedWorkspaceId) {
      void workspaceManager.selectWorkspace(workspaceId);
    } else {
      void sessionManager?.selectSession(sessionId);
    }
    closeSidebar();
  };
  const onForgetWorkspace = (workspaceId: WorkspaceId) => {
    const target = workspaceState.workspaces.find((workspace) => workspace.id === workspaceId);
    if (
      typeof window !== "undefined" &&
      target !== undefined &&
      !window.confirm(`从 ${target.displayName} 中移除？这不会删除磁盘文件。`)
    ) {
      return;
    }
    setWorkspaceActionError(undefined);
    void workspaceManager.forgetWorkspace(workspaceId).catch(() => {
      const error = workspaceManager.getSnapshot().error;
      setWorkspaceActionError(error?.message ?? "工作区移除失败。");
    });
  };
  const onAddWorkspace = () => {
    setWorkspaceActionError(undefined);
    setWorkspacePath("");
    setWorkspacePickerBusy(false);
    setWorkspaceDialogOpen(true);
  };
  const onPickWorkspaceDirectory = async () => {
    setWorkspaceActionError(undefined);
    setWorkspacePickerBusy(true);
    try {
      const result = await workspaceManager.pickWorkspaceDirectory();
      if (result.status === "SELECTED") {
        setWorkspacePath(result.path);
      } else if (result.status === "TIMEOUT") {
        setWorkspaceActionError("文件夹选择器等待超时，请重试。");
      } else if (result.status === "UNAVAILABLE") {
        setWorkspaceActionError("本机文件夹选择器暂不可用，请检查本地 Caelush 服务。");
      }
    } catch {
      setWorkspaceActionError("无法打开本机文件夹选择器，请稍后重试。");
    } finally {
      setWorkspacePickerBusy(false);
    }
  };
  const onRegisterWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = workspacePath.trim();
    if (path.length === 0) {
      setWorkspaceActionError("请先选择一个本机文件夹。");
      return;
    }
    try {
      const created = await workspaceManager.registerWorkspace(path);
      pendingDraftWorkspaceId.current = created.id;
      setWorkspaceDialogOpen(false);
      setWorkspacePath("");
      setWorkspaceActionError(undefined);
    } catch {
      setWorkspaceActionError(workspaceManager.getSnapshot().error?.message ?? "工作区注册失败。");
    }
  };

  return renderWorkspaceApp({
    host: state,
    workspaceState,
    selectedWorkspace,
    sessionManager,
    snapshot: sessionSnapshot,
    sidebarOpen,
    workspaceDialogOpen,
    workspacePath,
    workspacePickerBusy,
    workspaceActionError,
    onToggleSidebar: () => setSidebarOpen((open) => !open),
    onCloseSidebar: closeSidebar,
    onToggleWorkspace: (workspaceId) => workspaceManager.toggleWorkspaceExpanded(workspaceId),
    onSelectWorkspace,
    onNewSession,
    onSelectSession,
    onAddWorkspace,
    onForgetWorkspace,
    onCloseWorkspaceDialog: () => setWorkspaceDialogOpen(false),
    onPickWorkspaceDirectory,
    onRegisterWorkspace,
    settingsOpen,
    onOpenSettings: () => {
      setSettingsOpen(true);
      setSidebarOpen(false);
    },
    onCloseSettings: () => setSettingsOpen(false),
  });
}

function renderWorkspaceApp(input: {
  readonly host: WebHostState;
  readonly workspaceState: WorkspaceManagerState;
  readonly selectedWorkspace?: WorkspaceRecord | undefined;
  readonly sessionManager?: WebSessionManager | undefined;
  readonly snapshot: WebSessionSnapshot;
  readonly sidebarOpen: boolean;
  readonly workspaceDialogOpen: boolean;
  readonly workspacePath: string;
  readonly workspacePickerBusy: boolean;
  readonly workspaceActionError?: string | undefined;
  readonly onToggleSidebar: () => void;
  readonly onCloseSidebar: () => void;
  readonly onToggleWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onSelectWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onNewSession: (workspaceId: WorkspaceId) => void;
  readonly onSelectSession: (workspaceId: WorkspaceId, sessionId: SessionId) => void;
  readonly onAddWorkspace: () => void;
  readonly onForgetWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onCloseWorkspaceDialog: () => void;
  readonly onPickWorkspaceDirectory: () => void;
  readonly onRegisterWorkspace: (event: FormEvent<HTMLFormElement>) => void;
  readonly settingsOpen: boolean;
  readonly onOpenSettings: () => void;
  readonly onCloseSettings: () => void;
}): ReactElement {
  const { snapshot, selectedWorkspace } = input;
  const selectedCandidate = snapshot.candidates.find(
    (candidate) => candidate.session.id === snapshot.selectedSessionId,
  );
  const title = snapshot.isDraft
    ? "新会话"
    : selectedCandidate !== undefined
      ? derivePromptTitle(
          selectedCandidate.latestRun?.goal ?? selectedCandidate.session.title ?? "新会话",
        )
      : snapshot.selectedSession?.title !== undefined
        ? derivePromptTitle(snapshot.selectedSession.title)
        : "选择一个会话";
  const composerInteractionDisabled = shouldDisableComposerInteraction(snapshot);
  const hasWorkspace = selectedWorkspace !== undefined && input.sessionManager !== undefined;
  const workspaceColumnClass =
    hasWorkspace && hasScrollableSessionContent(snapshot)
      ? "workspace-column"
      : "workspace-column workspace-column--static";
  const modelSelection = snapshot.modelSelection ?? snapshot.defaultSelection;
  const modelReady =
    modelSelection !== undefined &&
    (snapshot.modelDirectory === undefined ||
      snapshot.modelDirectory.some(
        (model) => model.provider === modelSelection.provider && model.id === modelSelection.model,
      ));

  return createElement(
    "main",
    { className: "web-app-shell" },
    createElement(
      "button",
      {
        type: "button",
        className: "sidebar-toggle-button",
        onClick: input.onToggleSidebar,
        "aria-controls": "caelush-workspace-sidebar",
        "aria-expanded": input.sidebarOpen,
        "aria-label": input.sidebarOpen ? "关闭项目栏" : "打开项目栏",
      },
      createElement(PanelLeft, { size: 18, strokeWidth: 2.1, "aria-hidden": true }),
    ),
    input.sidebarOpen
      ? createElement("button", {
          type: "button",
          className: "sidebar-backdrop",
          onClick: input.onCloseSidebar,
          "aria-label": "关闭项目栏",
        })
      : null,
    createElement(
      "div",
      { className: "workspace-frame" },
      createElement(WorkspaceSidebar, {
        workspaces: input.workspaceState.workspaces,
        selectedWorkspaceId: input.workspaceState.selectedWorkspaceId,
        expandedWorkspaceIds: input.workspaceState.expandedWorkspaceIds,
        sessionSummaries: input.workspaceState.sessionSummaries,
        selectedSessionId: snapshot.selectedSessionId,
        isDraft: snapshot.isDraft,
        canNavigate: input.workspaceState.status === "READY",
        isOpen: input.sidebarOpen,
        onToggleWorkspace: input.onToggleWorkspace,
        onSelectWorkspace: input.onSelectWorkspace,
        onNewSession: input.onNewSession,
        onSelectSession: input.onSelectSession,
        onAddWorkspace: input.onAddWorkspace,
        onForgetWorkspace: input.onForgetWorkspace,
        onOpenSettings: input.onOpenSettings,
      }),
      createElement(
        "div",
        { className: workspaceColumnClass },
        input.workspaceActionError === undefined
          ? null
          : createElement(
              "p",
              { className: "workspace-action-error", role: "alert" },
              input.workspaceActionError,
            ),
        hasWorkspace
          ? createElement(
              "div",
              { className: "workspace-notices" },
              snapshot.transportState === "CONNECTED"
                ? null
                : createElement(ReconnectBanner, {
                    state: snapshot.transportState,
                    attempt: snapshot.transportAttempt,
                    onReconnect: () => input.sessionManager?.reconnectActiveRun(),
                  }),
            )
          : null,
        hasWorkspace
          ? createElement(SessionWorkspace, {
              title,
              activeRun: snapshot.activeRun,
              controlMode: snapshot.controlMode,
              approvals: snapshot.approvalState?.requests,
              recoveryRuns: snapshot.activeRuns.map((run) => ({
                id: run.id,
                goal: run.goal,
                status: run.status,
                createdAt: run.createdAt,
              })),
              history: snapshot.history,
              turnPresentation: snapshot.turnPresentation,
              timeline: snapshot.timeline,
              liveActivity: snapshot.liveActivity,
              composer: createElement(PromptComposer, {
                disabled: composerInteractionDisabled,
                modelReady,
                modelPicker: createElement(ModelPicker, {
                  providers: snapshot.aiProviders ?? [],
                  models: snapshot.modelDirectory ?? [],
                  selection: modelSelection,
                  disabled: composerInteractionDisabled,
                  onSelect: (selection) => void input.sessionManager?.selectModel(selection),
                  onOpenSettings: input.onOpenSettings,
                }),
                submission: snapshot.submission,
                error: snapshot.error,
                contextUsage: snapshot.contextUsage ?? null,
                onSubmit: async (prompt) =>
                  (await input.sessionManager?.submitPrompt(prompt)) ?? false,
              }),
              onCancel: async () => (await input.sessionManager?.cancelRun()) ?? false,
              onContinueResource: async () =>
                (await input.sessionManager?.continueResourceGuard()) ?? false,
              onResolveApproval: async (approvalId, resolution) =>
                (await input.sessionManager?.resolveApproval(approvalId, resolution)) ?? false,
              onSelectRecoveryRun: async (runId) =>
                (await input.sessionManager?.selectRecoveryRun(runId)) ?? false,
              onConfirmPendingRun: async (runId) =>
                (await input.sessionManager?.confirmPendingRun(runId)) ?? false,
            })
          : createElement(WorkspaceEmptyState, {
              hasWorkspaces: input.workspaceState.workspaces.length > 0,
              onAddWorkspace: input.onAddWorkspace,
            }),
      ),
    ),
    input.workspaceDialogOpen
      ? createElement(WorkspaceDialog, {
          path: input.workspacePath,
          isPicking: input.workspacePickerBusy,
          error: input.workspaceActionError,
          onClose: input.onCloseWorkspaceDialog,
          onPick: input.onPickWorkspaceDirectory,
          onSubmit: input.onRegisterWorkspace,
        })
      : null,
    input.settingsOpen
      ? createElement(SettingsSurface, {
          providers: snapshot.aiProviders ?? [],
          models: snapshot.modelDirectory ?? [],
          onClose: input.onCloseSettings,
          onConnect: (providerId, apiKey) =>
            input.sessionManager?.connectProvider(providerId, apiKey) ?? Promise.resolve(false),
          onDisconnect: (providerId) =>
            input.sessionManager?.disconnectProvider(providerId) ?? Promise.resolve(false),
        })
      : null,
  );
}

export function shouldDisableComposerInteraction(
  snapshot: Pick<WebSessionSnapshot, "status" | "submission" | "activeRun" | "controlMode">,
): boolean {
  return (
    snapshot.status !== "READY" ||
    snapshot.submission !== "IDLE" ||
    snapshot.activeRun !== undefined ||
    snapshot.controlMode === "CANCELLING" ||
    snapshot.controlMode === "RECOVERY_PICKER" ||
    snapshot.controlMode === "PENDING_RUN_CONFIRMATION"
  );
}

export function hasScrollableSessionContent(
  snapshot: Pick<
    WebSessionSnapshot,
    "history" | "turnPresentation" | "activeRun" | "activeRuns" | "approvalState" | "controlMode"
  >,
): boolean {
  return (
    snapshot.history.length > 0 ||
    (snapshot.turnPresentation?.items.length ?? 0) > 0 ||
    snapshot.activeRun !== undefined ||
    snapshot.activeRuns.length > 0 ||
    (snapshot.approvalState?.requests.length ?? 0) > 0
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
      state.info === undefined
        ? null
        : createElement(
            "dl",
            { className: "host-details" },
            createElement("dt", null, "服务版本"),
            createElement("dd", null, state.info.daemonVersion),
            createElement("dt", null, "协议版本"),
            createElement("dd", null, `v${state.info.protocolVersion}`),
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
