import {
  createElement,
  lazy,
  Suspense,
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
import type { AppearanceController } from "@caelush/ui-theme/appearance";
import {
  canCancelRunStatus,
  createInitialLiveActivityState,
  createInitialTimelineState,
} from "@caelush/client";
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
import { importLegacySessionArchives } from "./application/legacy-archive-import.js";
import { sessionArchiveStore } from "./application/session-archive-store.js";
import { archiveErrorMessage } from "./application/archive-errors.js";
import { PromptComposer } from "./components/prompt-composer.js";
import { SessionWorkspace } from "./components/session-workspace.js";
import { WorkbenchAppearanceRoute } from "./components/appearance-page.js";
import {
  PermissionPresetSelectionStore,
  SessionSelectionStore,
} from "./application/session-persistence.js";
import { ReconnectBanner } from "./components/reconnect-banner.js";
import {
  WorkspaceSidebar,
  type WorkspaceSidebarDesktopActions,
} from "./components/workspace-sidebar.js";
import { WorkspaceEmptyState } from "./components/workspace-empty-state.js";
import { ModelPicker } from "./components/model-picker.js";
import { PermissionSelector } from "./components/permission-selector.js";
import { hasTurnPresentationItems } from "./components/turn-presentation-feed.js";
import { observeDesktopPanelApi, type DesktopPanelApi } from "./host/desktop-panel-api.js";
import {
  resolveClientHostIntegration,
  type DesktopSidebarProfile,
} from "./host/desktop-integration.js";

const WorkspaceDialog = lazy(async () => {
  const module = await import("./components/workspace-dialog.js");
  return { default: module.WorkspaceDialog };
});
const SettingsSurface = lazy(async () => {
  const module = await import("./components/settings-surface.js");
  return { default: module.SettingsSurface };
});
const ArchivePage = lazy(async () => ({
  default: (await import("./components/archive-page.js")).ArchivePage,
}));

const DesktopWorkspacePanel = lazy(async () => {
  const module = await import("./components/desktop-workspace-panel.js");
  return { default: module.DesktopWorkspacePanel };
});

const sessionSelectionStore = new SessionSelectionStore();
const permissionPresetSelectionStore = new PermissionPresetSelectionStore();
const workspaceSelectionStore = new WorkspaceSelectionStore();

const EMPTY_SESSION_SNAPSHOT: WebSessionSnapshot = {
  status: "IDLE",
  candidates: [],
  runs: [],
  history: [],
  turnPresentation: undefined,
  activeRuns: [],
  continuityWarning: false,
  timeline: createInitialTimelineState(),
  liveActivity: createInitialLiveActivityState(),
  availablePresets: [],
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
  readonly appearanceController: AppearanceController;
  readonly launchContext?: unknown | undefined;
  readonly initialWorkspaceId?: WorkspaceId | undefined;
  readonly initialSessionId?: SessionId | undefined;
  readonly initialSettingsOpen?: boolean | undefined;
}): ReactElement {
  const clientHost = useMemo(() => resolveClientHostIntegration(), []);
  const desktopHostLoadingUI = clientHost.loadingUi;
  const [state, setState] = useState<WebHostState>(createInitialWebHostState);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspacePickerBusy, setWorkspacePickerBusy] = useState(false);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(props.initialSettingsOpen ?? false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const [desktopPanelApi, setDesktopPanelApi] = useState<DesktopPanelApi | null>(null);
  const [sidebarAccountProfile, setSidebarAccountProfile] = useState<DesktopSidebarProfile | null>(
    null,
  );
  const pendingDraftWorkspaceId = useRef<WorkspaceId | undefined>(undefined);
  const initialSessionLookupId = useRef<SessionId | undefined>(undefined);

  const appearanceSubscribe = useCallback(
    (listener: () => void) => props.appearanceController.subscribe(() => listener()),
    [props.appearanceController],
  );
  const appearanceGetSnapshot = useCallback(
    () => props.appearanceController.getSnapshot(),
    [props.appearanceController],
  );
  const appearanceSnapshot = useSyncExternalStore(
    appearanceSubscribe,
    appearanceGetSnapshot,
    appearanceGetSnapshot,
  );

  useEffect(() => {
    const readSidebarProfile =
      clientHost.kind === "DESKTOP" ? clientHost.account?.getSidebarProfile : undefined;
    if (readSidebarProfile === undefined) {
      setSidebarAccountProfile(null);
      return undefined;
    }

    let active = true;
    void readSidebarProfile()
      .then((profile) => {
        if (active) setSidebarAccountProfile(profile);
      })
      .catch(() => {
        if (active) setSidebarAccountProfile(null);
      });
    return () => {
      active = false;
    };
  }, [clientHost]);

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

  useEffect(() => {
    return observeDesktopPanelApi(
      clientHost.kind === "DESKTOP" ? clientHost.panelApi : null,
      setDesktopPanelApi,
    );
  }, [clientHost]);

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
    [selectedWorkspace?.id, selectedWorkspace?.canonicalPath],
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
      permissionPresetStore: permissionPresetSelectionStore,
      initialSessionId: props.initialSessionId,
    });
  }, [props.client, props.initialSessionId, selectedWorkspaceRef, state.bootstrap, state.info]);

  useEffect(() => {
    if (sessionManager === undefined) return;
    void sessionManager.loadSessions();
    return () => sessionManager.dispose();
  }, [sessionManager]);

  useEffect(() => {
    const refresh = () => {
      void workspaceManager?.loadWorkspaces();
      void sessionManager?.refreshArchiveState();
      if (
        state.info?.capabilities.archiveManagementV1 === true &&
        props.client.importLegacyArchives !== undefined
      )
        void importLegacySessionArchives({
          client: props.client as Required<Pick<WebSessionClient, "importLegacyArchives">>,
          store: sessionArchiveStore,
        })
          .then(() => workspaceManager?.loadWorkspaces())
          .catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [props.client, sessionManager, workspaceManager, state.info]);

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

  useEffect(() => {
    const sessionId = props.initialSessionId;
    if (
      sessionId === undefined ||
      props.client.getSession === undefined ||
      workspaceManager === undefined ||
      workspaceState.status !== "READY" ||
      initialSessionLookupId.current === sessionId
    ) {
      return;
    }
    initialSessionLookupId.current = sessionId;
    void props.client
      .getSession(sessionId)
      .then((session) => {
        const workspaceId = session.workspaceId;
        if (
          workspaceId !== undefined &&
          workspaceState.workspaces.some((workspace) => workspace.id === workspaceId) &&
          workspaceManager.getSnapshot().selectedWorkspaceId !== workspaceId
        ) {
          void workspaceManager.selectWorkspace(workspaceId);
        }
      })
      .catch(() => undefined);
  }, [
    props.client,
    props.initialSessionId,
    workspaceManager,
    workspaceState.status,
    workspaceState.workspaces,
  ]);
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

  const refreshAfterArchiveMutation = useCallback(() => {
    void workspaceManager?.loadWorkspaces();
    void sessionManager?.refreshArchiveState();
  }, [workspaceManager, sessionManager]);

  if (state.bootstrap !== "READY" || workspaceManager === undefined) {
    return renderHostBootstrap(state, desktopHostLoadingUI);
  }

  const closeSidebar = () => setSidebarOpen(false);
  if (archivesOpen) {
    if (state.info?.capabilities.archiveManagementV1 !== true)
      return createElement(
        "main",
        { className: "archive-page" },
        createElement(
          "div",
          { className: "archive-page-content" },
          createElement("h1", null, "已归档"),
          createElement("p", { role: "alert" }, "当前本地服务不支持归档管理，请更新后重试。"),
          createElement("button", { onClick: () => setArchivesOpen(false) }, "返回工作台"),
        ),
      );
    return createElement(
      Suspense,
      { fallback: createElement("p", { role: "status" }, "正在加载归档页…") },
      createElement(ArchivePage, {
        client:
          props.client as unknown as import("./application/archive-manager.js").ArchivePageClient,
        onClose: () => {
          setArchivesOpen(false);
          refreshAfterArchiveMutation();
        },
        onMutation: refreshAfterArchiveMutation,
      }),
    );
  }
  const selectedWorkspaceId = selectedWorkspace?.id;
  const onSelectWorkspace = (workspaceId: WorkspaceId) => {
    setWorkspaceActionError(undefined);
    void workspaceManager.selectWorkspace(workspaceId);
    closeSidebar();
  };
  const onNewSession = (workspaceId: WorkspaceId) => {
    if (workspaceId !== selectedWorkspaceId) {
      pendingDraftWorkspaceId.current = workspaceId;
      void workspaceManager.selectWorkspace(workspaceId, { expand: true });
    } else {
      workspaceManager.expandWorkspace(workspaceId);
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
  const onArchiveWorkspace = (workspaceId: WorkspaceId) => {
    if (state.info?.capabilities.archiveManagementV1 !== true) {
      setWorkspaceActionError("当前本地服务不支持归档管理，请更新后重试。");
      return;
    }
    const target = workspaceState.workspaces.find((workspace) => workspace.id === workspaceId);
    if (
      typeof window !== "undefined" &&
      target !== undefined &&
      !window.confirm(`归档工作区“${target.displayName}”？归档后可在归档页恢复。`)
    ) {
      return;
    }
    setWorkspaceActionError(undefined);
    void workspaceManager.archiveWorkspace(workspaceId).catch(() => {
      const error = workspaceManager.getSnapshot().error;
      setWorkspaceActionError(error?.message ?? "工作区归档失败。");
    });
  };
  const onArchiveSession = (sessionId: SessionId) => {
    if (state.info?.capabilities.archiveManagementV1 !== true) {
      setWorkspaceActionError("当前本地服务不支持归档管理，请更新后重试。");
      return;
    }
    setWorkspaceActionError(undefined);
    const selected = sessionSnapshot.candidates.find(
      (candidate) => candidate.session.id === sessionId,
    );
    const workspaceId =
      selected?.session.workspaceId ??
      workspaceState.workspaces.find((workspace) =>
        workspaceState.sessionSummaries[workspace.id]?.some(
          (summary) => summary.session.id === sessionId,
        ),
      )?.id;
    if (workspaceId === selectedWorkspaceId && sessionManager !== undefined) {
      void sessionManager.archiveSession(sessionId).then((accepted) => {
        if (accepted && workspaceId !== undefined)
          void workspaceManager.loadWorkspaceSessions(workspaceId);
        if (!accepted)
          setWorkspaceActionError(sessionManager.getSnapshot().error?.message ?? "会话归档失败。");
      });
    } else if (props.client.archiveSession !== undefined) {
      void props.client
        .archiveSession(sessionId)
        .then(() =>
          workspaceId === undefined
            ? undefined
            : workspaceManager.loadWorkspaceSessions(workspaceId),
        )
        .catch((error: unknown) => setWorkspaceActionError(archiveErrorMessage(error)));
    }
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

  const desktopActions: WorkspaceSidebarDesktopActions | undefined =
    clientHost.kind === "DESKTOP"
      ? {
          accountHref: clientHost.account?.href,
          archiveHref: clientHost.account?.archiveHref,
          accountProfile: sidebarAccountProfile ?? undefined,
          onCheckUpdates:
            clientHost.updates === undefined
              ? undefined
              : () => void clientHost.updates?.check().catch(() => undefined),
          onLogout:
            clientHost.account === undefined
              ? undefined
              : () =>
                  void logoutDesktopAccount(clientHost.account!.logout, setWorkspaceActionError),
        }
      : undefined;

  return renderWorkspaceApp({
    host: state,
    desktopHostLoadingUI,
    workspaceState,
    selectedWorkspace,
    desktopPanelApi,
    sessionManager,
    snapshot: sessionSnapshot,
    appearanceController: props.appearanceController,
    appearanceSnapshot,
    appearanceOpen,
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
    onArchiveWorkspace,
    onArchiveSession,
    onOpenArchives: () => {
      setArchivesOpen(true);
      closeSidebar();
    },
    onCloseWorkspaceDialog: () => setWorkspaceDialogOpen(false),
    onPickWorkspaceDirectory,
    onRegisterWorkspace,
    settingsOpen,
    onOpenSettings: () => {
      setAppearanceOpen(false);
      setSettingsOpen(true);
      setSidebarOpen(false);
    },
    onOpenAppearance:
      clientHost.kind === "WEB"
        ? () => {
            setSettingsOpen(false);
            setAppearanceOpen(true);
            setSidebarOpen(false);
          }
        : undefined,
    desktopActions,
    onCloseSettings: () => setSettingsOpen(false),
    onCloseAppearance: () => setAppearanceOpen(false),
  });
}

async function logoutDesktopAccount(
  logout: () => Promise<{ readonly serverRevoked: boolean }>,
  reportError: (message: string | undefined) => void,
): Promise<void> {
  reportError(undefined);
  try {
    await logout();
    window.location.assign("caelush-login://app/");
  } catch {
    reportError("退出登录未完成，请稍后重试。");
  }
}

function renderWorkspaceApp(input: {
  readonly host: WebHostState;
  readonly desktopHostLoadingUI: boolean;
  readonly workspaceState: WorkspaceManagerState;
  readonly selectedWorkspace?: WorkspaceRecord | undefined;
  readonly desktopPanelApi: DesktopPanelApi | null;
  readonly sessionManager?: WebSessionManager | undefined;
  readonly snapshot: WebSessionSnapshot;
  readonly appearanceController: AppearanceController;
  readonly appearanceSnapshot: ReturnType<AppearanceController["getSnapshot"]>;
  readonly appearanceOpen: boolean;
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
  readonly onArchiveWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onArchiveSession: (sessionId: SessionId) => void;
  readonly onOpenArchives: () => void;
  readonly onCloseWorkspaceDialog: () => void;
  readonly onPickWorkspaceDirectory: () => void;
  readonly onRegisterWorkspace: (event: FormEvent<HTMLFormElement>) => void;
  readonly settingsOpen: boolean;
  readonly onOpenSettings: () => void;
  readonly onOpenAppearance?: (() => void) | undefined;
  readonly desktopActions?: WorkspaceSidebarDesktopActions | undefined;
  readonly onCloseSettings: () => void;
  readonly onCloseAppearance: () => void;
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
  const canCancelActiveRun =
    snapshot.activeRun !== undefined && canCancelRunStatus(snapshot.activeRun.status);
  const hasWorkspace = selectedWorkspace !== undefined && input.sessionManager !== undefined;
  const workspaceLoading =
    input.workspaceState.status === "IDLE" || input.workspaceState.status === "LOADING";
  const sessionLoading =
    selectedWorkspace !== undefined &&
    (input.sessionManager === undefined ||
      input.snapshot.status === "IDLE" ||
      input.snapshot.status === "LOADING");
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
  const promptComposer = createElement(PromptComposer, {
    key: `${selectedWorkspace?.id ?? "none"}:${snapshot.selectedSessionId ?? "draft"}`,
    disabled: !hasWorkspace || composerInteractionDisabled,
    modelReady: hasWorkspace ? modelReady : false,
    placeholder: hasWorkspace ? undefined : "先添加工作区，再开始对话",
    ...(hasWorkspace
      ? {
          modelPicker: createElement(ModelPicker, {
            providers: snapshot.aiProviders ?? [],
            models: snapshot.modelDirectory ?? [],
            selection: modelSelection,
            disabled: composerInteractionDisabled,
            onSelect: (selection) => void input.sessionManager?.selectModel(selection),
            onOpenSettings: input.onOpenSettings,
          }),
          permissionSelector: createElement(PermissionSelector, {
            presets: snapshot.availablePresets,
            selected:
              snapshot.preparingPreset === undefined
                ? (snapshot.requestedPreset ?? snapshot.selectedPreset)
                : snapshot.selectedPreset,
            preparing: snapshot.preparingPreset,
            disabled: composerInteractionDisabled || snapshot.activeRun !== undefined,
            error: snapshot.permissionPresetError,
            onSelect: (selection) => void input.sessionManager?.selectPermissionPreset(selection),
            onPrepare: async (selection) =>
              (await input.sessionManager?.preparePermissionPreset(selection)) ?? false,
          }),
        }
      : {}),
    submission: snapshot.submission,
    onCancel: canCancelActiveRun
      ? async () => (await input.sessionManager?.cancelRun()) ?? false
      : undefined,
    cancelling: snapshot.controlMode === "CANCELLING",
    error: hasWorkspace ? snapshot.error : undefined,
    contextUsage: hasWorkspace ? (snapshot.contextUsage ?? null) : null,
    onSubmit: async (prompt) => (await input.sessionManager?.submitPrompt(prompt)) ?? false,
  });

  const workbench = createElement(
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
      {
        className:
          input.desktopPanelApi === null
            ? "workspace-frame"
            : "workspace-frame workspace-frame--desktop",
      },
      workspaceLoading
        ? createElement(WorkbenchSidebarSkeleton, null)
        : createElement(WorkspaceSidebar, {
            workspaces: input.workspaceState.workspaces,
            selectedWorkspaceId: input.workspaceState.selectedWorkspaceId,
            expandedWorkspaceIds: input.workspaceState.expandedWorkspaceIds,
            sessionSummaries: input.workspaceState.sessionSummaries,
            selectedSessionId: snapshot.selectedSessionId,
            isDraft: snapshot.isDraft,
            canNavigate: input.workspaceState.status === "READY",
            theme: input.appearanceSnapshot.resolvedTheme,
            isOpen: input.sidebarOpen,
            onToggleWorkspace: input.onToggleWorkspace,
            onSelectWorkspace: input.onSelectWorkspace,
            onNewSession: input.onNewSession,
            onSelectSession: input.onSelectSession,
            onAddWorkspace: input.onAddWorkspace,
            onArchiveWorkspace: input.onArchiveWorkspace,
            onArchiveSession: input.onArchiveSession,
            onOpenArchives: input.onOpenArchives,
            onOpenSettings: input.onOpenSettings,
            onOpenAppearance: input.onOpenAppearance,
            desktopActions: input.desktopActions,
          }),
      createElement(
        "div",
        {
          className:
            input.desktopPanelApi === null
              ? workspaceColumnClass
              : `${workspaceColumnClass} workspace-column--desktop`,
        },
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
        input.desktopHostLoadingUI && (workspaceLoading || sessionLoading)
          ? createElement(
              "div",
              { className: "workbench-loading-region", "aria-busy": true },
              createElement(WorkbenchLoadingContent, null),
              createElement(
                "span",
                { className: "visually-hidden", role: "status" },
                "正在加载工作区和会话",
              ),
            )
          : hasWorkspace
            ? createElement(SessionWorkspace, {
                title,
                theme: input.appearanceSnapshot.resolvedTheme,
                workspaceName: selectedWorkspace.displayName,
                workspaces: input.workspaceState.workspaces,
                selectedWorkspaceId: input.workspaceState.selectedWorkspaceId,
                workspacePickerDisabled: input.workspaceState.status !== "READY",
                onAddWorkspace: input.onAddWorkspace,
                onSelectWorkspace: input.onSelectWorkspace,
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
                continuityWarning: snapshot.continuityWarning,
                composer: promptComposer,
                onContinueResource: async () =>
                  (await input.sessionManager?.continueResourceGuard()) ?? false,
                onResolveApproval: async (approvalId, resolution) =>
                  (await input.sessionManager?.resolveApproval(approvalId, resolution)) ?? false,
                onSelectRecoveryRun: async (runId) =>
                  (await input.sessionManager?.selectRecoveryRun(runId)) ?? false,
                onConfirmPendingRun: async (runId) =>
                  (await input.sessionManager?.confirmPendingRun(runId)) ?? false,
                onCreateContinuitySession: async () =>
                  (await input.sessionManager?.createContinuitySession()) ?? false,
              })
            : createElement(WorkspaceEmptyState, {
                theme: input.appearanceSnapshot.resolvedTheme,
                hasWorkspaces: input.workspaceState.workspaces.length > 0,
                workspaces: input.workspaceState.workspaces,
                selectedWorkspaceId: input.workspaceState.selectedWorkspaceId,
                disabled: input.workspaceState.status !== "READY",
                onAddWorkspace: input.onAddWorkspace,
                onSelectWorkspace: input.onSelectWorkspace,
                composer: promptComposer,
              }),
      ),
      input.desktopPanelApi === null
        ? null
        : createElement(
            Suspense,
            { fallback: null },
            createElement(DesktopWorkspacePanel, {
              api: input.desktopPanelApi,
              workspaceId: input.workspaceState.selectedWorkspaceId ?? null,
              theme: input.appearanceSnapshot.resolvedTheme,
            }),
          ),
    ),
    input.workspaceDialogOpen
      ? createElement(
          Suspense,
          { fallback: null },
          createElement(WorkspaceDialog, {
            path: input.workspacePath,
            isPicking: input.workspacePickerBusy,
            error: input.workspaceActionError,
            onClose: input.onCloseWorkspaceDialog,
            onPick: input.onPickWorkspaceDirectory,
            onSubmit: input.onRegisterWorkspace,
          }),
        )
      : null,
    input.settingsOpen
      ? createElement(
          Suspense,
          { fallback: null },
          createElement(SettingsSurface, {
            providers: snapshot.aiProviders ?? [],
            models: snapshot.modelDirectory ?? [],
            onClose: input.onCloseSettings,
            onConnect: (providerId, apiKey) =>
              input.sessionManager?.connectProvider(providerId, apiKey) ??
              Promise.resolve({ ok: false, message: "Provider 连接功能暂不可用。" }),
            onDisconnect: (providerId) =>
              input.sessionManager?.disconnectProvider(providerId) ?? Promise.resolve(false),
          }),
        )
      : null,
  );
  return createElement(WorkbenchAppearanceRoute, {
    isOpen: input.appearanceOpen,
    snapshot: input.appearanceSnapshot,
    onBack: input.onCloseAppearance,
    onPreferenceChange: (preference) => input.appearanceController.setPreference(preference),
    workbench,
  });
}

export function shouldDisableComposerInteraction(
  snapshot: Pick<
    WebSessionSnapshot,
    "status" | "submission" | "activeRun" | "controlMode" | "preparingPreset"
  > & { readonly archiveReadOnly?: boolean },
): boolean {
  return (
    snapshot.archiveReadOnly === true ||
    snapshot.status !== "READY" ||
    snapshot.submission !== "IDLE" ||
    snapshot.preparingPreset !== undefined ||
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
    hasTurnPresentationItems(snapshot.turnPresentation) ||
    snapshot.activeRun !== undefined ||
    snapshot.activeRuns.length > 0 ||
    (snapshot.approvalState?.requests.length ?? 0) > 0
  );
}

function renderHostBootstrap(state: WebHostState, desktopHostLoadingUI: boolean): ReactElement {
  if (
    desktopHostLoadingUI &&
    (state.bootstrap === "BOOTING" ||
      state.bootstrap === "CONNECTING" ||
      state.bootstrap === "CHECKING_PROTOCOL")
  ) {
    return renderWorkspaceBootstrapSkeleton();
  }

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

function renderWorkspaceBootstrapSkeleton(): ReactElement {
  return createElement(
    "main",
    {
      className: "web-app-shell workspace-bootstrap-loading",
      "aria-busy": true,
      "aria-label": "正在加载工作台",
    },
    createElement(
      "div",
      { className: "workspace-frame workspace-frame--loading" },
      createElement(WorkbenchSidebarSkeleton, null),
      createElement(
        "section",
        { className: "workspace-column workspace-column--loading" },
        createElement(WorkbenchLoadingContent, null),
      ),
    ),
    createElement("span", { className: "visually-hidden", role: "status" }, "正在加载工作台"),
  );
}

function WorkbenchSidebarSkeleton(): ReactElement {
  return createElement(
    "aside",
    { className: "workspace-sidebar workspace-sidebar--loading", "aria-hidden": true },
    createElement(
      "div",
      { className: "workspace-sidebar-brand" },
      createElement("span", { className: "skeleton-block workbench-skeleton-logo" }),
    ),
    createElement("div", { className: "workbench-skeleton-section" }),
    createElement("div", { className: "skeleton-block workbench-skeleton-add" }),
    createElement("div", { className: "skeleton-block workbench-skeleton-project" }),
    createElement("div", { className: "skeleton-block workbench-skeleton-project" }),
    createElement(
      "div",
      { className: "workbench-skeleton-footer" },
      createElement("span", { className: "skeleton-block workbench-skeleton-avatar" }),
      createElement("span", { className: "skeleton-block workbench-skeleton-footer-label" }),
      createElement("span", { className: "skeleton-block workbench-skeleton-footer-icon" }),
    ),
  );
}

function WorkbenchLoadingContent(): ReactElement {
  return createElement(
    "section",
    { className: "workbench-loading-content", "aria-hidden": true },
    createElement(
      "div",
      { className: "workbench-loading-welcome" },
      createElement("span", { className: "skeleton-block workbench-skeleton-brand" }),
      createElement("span", { className: "skeleton-block workbench-skeleton-slogan" }),
    ),
    createElement(
      "div",
      { className: "workbench-loading-composer" },
      createElement("span", { className: "skeleton-block workbench-skeleton-prompt" }),
      createElement(
        "div",
        { className: "workbench-skeleton-composer-footer" },
        createElement("span", { className: "skeleton-block workbench-skeleton-control" }),
        createElement("span", { className: "skeleton-block workbench-skeleton-control" }),
        createElement("span", { className: "skeleton-block workbench-skeleton-submit" }),
      ),
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
