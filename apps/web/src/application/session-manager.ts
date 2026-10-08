import {
  createApprovalView,
  CaelushClientHttpError,
  CaelushClientProtocolError,
  CaelushProtocolCompatibilityError,
  canCancelRunStatus,
  createInitialLiveActivityState,
  createInitialTimelineState,
  deriveSessionActivity,
  flushTimelineForTerminal,
  isTerminalRunStatus,
  listMatchingSessionCandidates,
  nonTerminalRuns,
  pruneProjectedLiveActivities,
  reconcileSessionTranscript,
  reduceLiveActivityEvent,
  reduceTimelineEvent,
  ReconnectScheduler,
  resolveSessionWorkspace,
  sortSessionCandidates,
  type SessionCandidate,
  type ApprovalView,
  type SessionCandidateClient,
  type LiveActivityState,
  type TranscriptEntry,
  type TimelineState,
  type Timer,
  type TimerHandle,
  type WatchRunEventsOptions,
} from "@caelush/client";
import type {
  PublicRunEvent,
  ApprovalRequestId,
  ApprovalResolution,
  ClientAgentRun,
  ClientAgentSession,
  ClientModelSelectionWithReasoning,
  CreateRunRequest,
  CreateSessionRequest,
  DaemonInfo,
  RunActionResponse,
  RunId,
  RunStatus,
  SessionId,
  SessionTranscriptResponse,
  SessionTurnPresentationResponse,
  SessionTurnPresentationTurnV3,
  SessionContinuityPreflightResponse,
  TurnPresentationItem,
  TurnPresentationItemV3,
  WorkspaceRef,
  WorkspaceSessionSummary,
  ContextUsageProjection,
  AIModelDirectoryResponse,
  AIProvidersResponse,
  ConnectProviderRequest,
  UpdateAISelectionRequest,
  UpdateSessionModelSelectionRequest,
  PermissionPresetSelection,
  SecurityCapabilitiesResponse,
  SecurityPreparationResponse,
  SelectablePermissionPresetId,
  WorkspaceSecurityCapabilitiesResponse,
} from "@caelush/protocol";
import { derivePromptTitle, validatePrompt, type PromptError } from "./prompt.js";
import type { WebHostClient } from "../host/bootstrap.js";
import { mergeActiveTurnPresentation } from "./session-presentation-merge.js";
import {
  browserFrameScheduler,
  type FrameHandle,
  type FrameScheduler,
} from "./frame-publication-scheduler.js";
import { PermissionPresetSelectionStore, SessionSelectionStore } from "./session-persistence.js";
import {
  choosePermissionPreset,
  DEFAULT_PERMISSION_PRESET_ID,
  permissionPresetUnavailableReason,
  projectPermissionPresetViewModels,
  runPermissionPreset,
  type PermissionPresetViewModel,
} from "./permission-presets.js";

export interface WebSessionClient extends SessionCandidateClient, WebHostClient {
  listWorkspaceSessions?(workspaceId: WorkspaceRef["id"]): Promise<{
    readonly items: readonly WorkspaceSessionSummary[];
  }>;
  createSession(input: CreateSessionRequest): Promise<ClientAgentSession>;
  createRun(sessionId: SessionId, input: CreateRunRequest): Promise<ClientAgentRun>;
  getSecurityCapabilities?(): Promise<SecurityCapabilitiesResponse>;
  getWorkspaceSecurityCapabilities?(
    workspaceId: WorkspaceRef["id"],
  ): Promise<WorkspaceSecurityCapabilitiesResponse>;
  prepareWorkspaceSecurity?(
    workspaceId: WorkspaceRef["id"],
    preset: PermissionPresetSelection,
  ): Promise<SecurityPreparationResponse>;
  listAIProviders?(): Promise<AIProvidersResponse>;
  getAIModelDirectory?(providerId?: string): Promise<AIModelDirectoryResponse>;
  getDefaultAISelection?(): Promise<{ selection?: ClientModelSelectionWithReasoning | undefined }>;
  setDefaultAISelection?(input: UpdateAISelectionRequest): Promise<{
    selection?: ClientModelSelectionWithReasoning | undefined;
  }>;
  connectAIProvider?(providerId: string, input: ConnectProviderRequest): Promise<unknown>;
  disconnectAIProvider?(providerId: string): Promise<void>;
  updateSessionModelSelection?(
    sessionId: SessionId,
    input: UpdateSessionModelSelectionRequest,
  ): Promise<ClientAgentSession>;
  getRun(runId: RunId): Promise<ClientAgentRun>;
  getSessionTranscript?(
    sessionId: SessionId,
    query?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<SessionTranscriptResponse>;
  getSessionContinuityPreflight?(
    sessionId: SessionId,
    model: { readonly provider: string; readonly model: string },
  ): Promise<SessionContinuityPreflightResponse>;
  getSessionTurnPresentation?(
    sessionId: SessionId,
    query?: { readonly runId?: RunId; readonly limit?: number; readonly cursor?: string },
  ): Promise<SessionTurnPresentationResponse>;
  listPendingApprovals(
    runId: RunId,
  ): Promise<{ readonly items: readonly import("@caelush/protocol").ApprovalRequest[] }>;
  resolveApproval(
    runId: RunId,
    approvalId: ApprovalRequestId,
    resolution: ApprovalResolution,
  ): Promise<RunActionResponse>;
  startRun(runId: RunId): Promise<RunActionResponse>;
  recoverRun(runId: RunId): Promise<RunActionResponse>;
  cancelRun(runId: RunId): Promise<RunActionResponse>;
  continueResourceGuard(runId: RunId): Promise<RunActionResponse>;
  getRunContextUsage?(runId: RunId): Promise<ContextUsageProjection | null>;
  watchRunEvents(runId: RunId, options?: WatchRunEventsOptions): AsyncIterable<PublicRunEvent>;
}

export type WebSessionLoadState = "IDLE" | "LOADING" | "READY" | "ERROR";
export type WebSubmissionState = "IDLE" | "SUBMITTING" | "RUN_CREATED" | "STARTING" | "ACTIVE";
export type WebTransportState = "CONNECTED" | "RECONNECTING" | "DISCONNECTED";
export type WebControlMode =
  | "NONE"
  | "APPROVAL"
  | "RESOURCE_GUARD"
  | "CANCELLING"
  | "RECOVERY_PICKER"
  | "PENDING_RUN_CONFIRMATION";

export interface WebApprovalState {
  readonly requests: readonly ApprovalView[];
  readonly submitting: readonly ApprovalRequestId[];
}

export type WebSessionErrorCode =
  | "SESSION_LOAD_FAILED"
  | "SESSION_SELECTION_FAILED"
  | "MULTIPLE_ACTIVE_RUNS"
  | "SESSION_CREATE_FAILED"
  | "RUN_CREATE_FAILED"
  | "RUN_START_FAILED"
  | "RUN_CANCEL_FAILED"
  | "RUN_STREAM_FAILED"
  | "RUN_RECONNECT_EXHAUSTED"
  | "RUN_REFRESH_FAILED"
  | "DEFAULT_MODEL_UNAVAILABLE"
  | "PERMISSION_CAPABILITIES_FAILED"
  | "PERMISSION_PRESET_UNAVAILABLE"
  | "PERMISSION_PREPARATION_FAILED"
  | "PROMPT_REQUIRED"
  | "PROMPT_TOO_LARGE"
  | "CONVERSATION_CONTINUITY_INCOMPATIBLE";

export interface WebSessionError {
  readonly code: WebSessionErrorCode;
  readonly message: string;
  readonly reasonCode?: string;
}

export interface WebSessionSnapshot {
  readonly status: WebSessionLoadState;
  readonly candidates: readonly SessionCandidate[];
  readonly selectedSession?: ClientAgentSession;
  readonly selectedSessionId?: SessionId;
  readonly runs: readonly ClientAgentRun[];
  readonly history: readonly TranscriptEntry[];
  readonly turnPresentation?: SessionTurnPresentationResponse | undefined;
  readonly activeRuns: readonly ClientAgentRun[];
  readonly activeRun?: ClientAgentRun;
  readonly timeline: TimelineState;
  readonly liveActivity: LiveActivityState;
  readonly contextUsage?: ContextUsageProjection | null;
  readonly continuityWarning: boolean;
  readonly aiProviders?: AIProvidersResponse["providers"];
  readonly modelDirectory?: AIModelDirectoryResponse["models"];
  readonly permissionCapabilities?: SecurityCapabilitiesResponse | undefined;
  readonly availablePresets: readonly PermissionPresetViewModel[];
  /** The user's permission intent, which may differ from what is currently safe to execute. */
  readonly requestedPreset?: PermissionPresetSelection;
  /** The permission which will be sent with a newly-created Run. */
  readonly selectedPreset?: PermissionPresetSelection;
  readonly preparingPreset?: PermissionPresetSelection;
  readonly permissionPresetError?: string;
  readonly defaultSelection?: ClientModelSelectionWithReasoning;
  readonly modelSelection?: ClientModelSelectionWithReasoning;
  readonly isDraft: boolean;
  readonly composerEnabled: boolean;
  readonly submission: WebSubmissionState;
  readonly transportState: WebTransportState;
  readonly transportAttempt?: number;
  readonly controlMode: WebControlMode;
  readonly approvalState?: WebApprovalState;
  readonly error?: WebSessionError;
}

export type WebSessionListener = (snapshot: WebSessionSnapshot) => void;
type WebSessionSnapshotPatch = Partial<
  Omit<
    WebSessionSnapshot,
    | "selectedSession"
    | "selectedSessionId"
    | "activeRun"
    | "approvalState"
    | "error"
    | "defaultSelection"
    | "modelSelection"
    | "selectedPreset"
    | "requestedPreset"
    | "preparingPreset"
    | "permissionPresetError"
    | "transportAttempt"
  >
> & {
  readonly selectedSession?: ClientAgentSession | undefined;
  readonly selectedSessionId?: SessionId | undefined;
  readonly activeRun?: ClientAgentRun | undefined;
  readonly approvalState?: WebApprovalState | undefined;
  readonly error?: WebSessionError | undefined;
  readonly defaultSelection?: ClientModelSelectionWithReasoning | undefined;
  readonly modelSelection?: ClientModelSelectionWithReasoning | undefined;
  readonly selectedPreset?: PermissionPresetSelection | undefined;
  readonly requestedPreset?: PermissionPresetSelection | undefined;
  readonly preparingPreset?: PermissionPresetSelection | undefined;
  readonly permissionPresetError?: string | undefined;
  readonly transportAttempt?: number | undefined;
};

interface ActiveLifecycle {
  readonly run: ClientAgentRun;
  controller: AbortController;
  streamGeneration: number;
  recoveryAdmitted: boolean;
  recoveryRevoked: boolean;
  recoveryOnOpen: boolean;
  streamOpenGeneration?: number;
  presentationRefreshPending: boolean;
  presentationRefreshPromise?: Promise<void>;
  readonly scheduler: ReconnectScheduler;
  failure?: "RUN_STREAM_FAILED" | "RUN_REFRESH_FAILED";
}

interface ApprovalContext {
  readonly generation: number;
  readonly sessionId: SessionId | undefined;
  readonly runId: RunId;
}

interface OptimisticPresentationUser {
  readonly id: string;
  readonly runId: RunId;
  readonly status: "COMPLETED";
  readonly createdAt: ClientAgentRun["createdAt"];
  readonly kind: "USER";
  readonly text: string;
}

export class WebSessionManager {
  private readonly listeners = new Set<WebSessionListener>();
  private snapshot: WebSessionSnapshot = initialSnapshot();
  private pendingPublicationFrame:
    { readonly token: object; readonly handle: FrameHandle } | undefined;
  private readonly frameScheduler: FrameScheduler;
  private activeLifecycle: ActiveLifecycle | undefined;
  private readonly resolvingApprovals = new Set<ApprovalRequestId>();
  private approvalContextGeneration = 0;
  private cancelPromise: Promise<boolean> | undefined;
  private resourceContinuePromise: Promise<boolean> | undefined;
  private contextUsageRefreshGeneration = 0;
  private contextUsageRefreshTimer: TimerHandle | undefined;
  private contextUsageRefreshRunId: RunId | undefined;
  private continuityPreflightGeneration = 0;
  private disposed = false;

  constructor(
    private readonly options: {
      readonly client: WebSessionClient;
      readonly workspace: WorkspaceRef;
      readonly info: DaemonInfo;
      readonly timer?: Timer;
      readonly frameScheduler?: FrameScheduler;
      readonly selectionStore?: SessionSelectionStore;
      readonly permissionPresetStore?: PermissionPresetSelectionStore;
    },
  ) {
    this.frameScheduler = options.frameScheduler ?? browserFrameScheduler;
  }

  getSnapshot(): WebSessionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: WebSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async loadSessions(): Promise<void> {
    if (this.disposed) return;
    this.publish({ status: "LOADING", error: undefined });
    try {
      await this.loadAIControl();
      await this.loadPermissionPresets();
      const candidates =
        this.options.client.listWorkspaceSessions === undefined
          ? await listMatchingSessionCandidates(this.options.client, this.options.workspace.path)
          : await this.listWorkspaceSessionCandidates();
      const selectionStore = this.options.selectionStore;
      selectionStore?.setCandidates(
        this.options.workspace.id,
        candidates.map((candidate) => candidate.session.id),
      );
      const selectedId =
        selectionStore?.read(this.options.workspace.id) ?? this.snapshot.selectedSessionId;
      this.publish({ status: "READY", candidates, error: undefined });
      if (selectedId !== undefined && candidates.some((item) => item.session.id === selectedId)) {
        await this.selectSession(selectedId);
      }
    } catch {
      this.publish({
        status: "ERROR",
        composerEnabled: false,
        error: sessionError("SESSION_LOAD_FAILED"),
      });
    }
  }

  beginDraft(): void {
    if (
      this.disposed ||
      this.snapshot.submission !== "IDLE" ||
      this.snapshot.preparingPreset !== undefined
    )
      return;
    this.cancelActiveLifecycle();
    this.clearApprovals();
    const defaultSelection = this.snapshot.defaultSelection ?? this.options.info.defaultModel;
    const selectedPreset = this.currentPermissionPreset();
    this.publish({
      status: "READY",
      selectedSession: undefined,
      selectedSessionId: undefined,
      defaultSelection,
      modelSelection: defaultSelection,
      ...(selectedPreset === undefined ? {} : { selectedPreset }),
      runs: [],
      history: [],
      turnPresentation: undefined,
      continuityWarning: false,
      activeRuns: [],
      activeRun: undefined,
      timeline: createInitialTimelineState(),
      liveActivity: createInitialLiveActivityState(),
      isDraft: true,
      composerEnabled: true,
      submission: "IDLE",
      approvalState: undefined,
      controlMode: "NONE",
      error: undefined,
    });
  }

  async selectSession(sessionId: SessionId): Promise<boolean> {
    if (
      this.disposed ||
      this.snapshot.submission !== "IDLE" ||
      this.snapshot.preparingPreset !== undefined
    )
      return false;
    const candidate = this.snapshot.candidates.find((item) => item.session.id === sessionId);
    if (candidate === undefined) return false;

    // Navigation only aborts the browser observer for the previous Run. The
    // daemon-owned Run continues independently of the selected Web Session.
    this.cancelActiveLifecycle();
    this.clearApprovals();
    this.publish({ status: "LOADING", error: undefined });
    try {
      const runs = (await this.options.client.listRuns(sessionId, { limit: 100 })).items;
      if (this.options.client.listWorkspaceSessions === undefined) {
        const workspaceResult = resolveSessionWorkspace(
          candidate.session,
          runs,
          this.options.workspace.path,
        );
        if ("error" in workspaceResult) {
          this.publish({
            status: "ERROR",
            selectedSession: candidate.session,
            selectedSessionId: candidate.session.id,
            runs,
            history: await this.loadSessionTranscript(sessionId),
            turnPresentation: await this.loadSessionTurnPresentation(sessionId),
            activeRuns: [],
            activeRun: undefined,
            contextUsage: null,
            continuityWarning: false,
            isDraft: false,
            composerEnabled: false,
            error: sessionError("SESSION_SELECTION_FAILED"),
          });
          return false;
        }
      }
      this.options.selectionStore?.write(this.options.workspace.id, sessionId);
      return await this.applySelectedSession(candidate.session, runs);
    } catch {
      this.publish({
        status: "ERROR",
        selectedSession: candidate.session,
        selectedSessionId: candidate.session.id,
        runs: [],
        history: [],
        turnPresentation: undefined,
        activeRuns: [],
        activeRun: undefined,
        timeline: createInitialTimelineState(),
        liveActivity: createInitialLiveActivityState(),
        contextUsage: null,
        isDraft: false,
        composerEnabled: false,
        error: sessionError("SESSION_SELECTION_FAILED"),
      });
      return false;
    }
  }

  async submitPrompt(prompt: string): Promise<boolean> {
    if (
      this.disposed ||
      this.hasActiveRun() ||
      this.snapshot.submission !== "IDLE" ||
      this.snapshot.preparingPreset !== undefined
    )
      return false;
    const validation = validatePrompt(prompt);
    if (!validation.ok) {
      this.publish({ error: promptError(validation.error) });
      return false;
    }

    const selection = this.currentModelSelection();
    if (selection === undefined || !this.isSelectionAvailable(selection)) {
      this.publish({ error: sessionError("DEFAULT_MODEL_UNAVAILABLE") });
      return false;
    }
    const model = { provider: selection.provider, model: selection.model };
    const permissionPreset = this.currentPermissionPreset();
    if (permissionPreset === undefined) {
      this.publish({
        error: sessionError(
          this.snapshot.permissionCapabilities === undefined
            ? "PERMISSION_CAPABILITIES_FAILED"
            : "PERMISSION_PRESET_UNAVAILABLE",
        ),
      });
      return false;
    }

    const goal = validation.value;
    this.publish({ submission: "SUBMITTING", error: undefined });
    let session = this.snapshot.selectedSession;
    try {
      if (session === undefined) {
        session = await this.options.client.createSession(
          this.options.client.listWorkspaceSessions === undefined
            ? {
                title: derivePromptTitle(goal),
                defaultWorkspace: this.options.workspace,
                defaultModel: model,
                ...(selection.reasoningLevel === undefined
                  ? {}
                  : { defaultReasoningLevel: selection.reasoningLevel }),
                metadata: {},
              }
            : {
                title: derivePromptTitle(goal),
                workspaceId: this.options.workspace.id,
                defaultModel: model,
                ...(selection.reasoningLevel === undefined
                  ? {}
                  : { defaultReasoningLevel: selection.reasoningLevel }),
                metadata: {},
              },
        );
        const candidates = this.upsertCandidate(session);
        this.options.selectionStore?.setCandidates(
          this.options.workspace.id,
          candidates.map((candidate) => candidate.session.id),
        );
        this.options.selectionStore?.write(this.options.workspace.id, session.id);
        this.publish({
          candidates,
          selectedSession: session,
          selectedSessionId: session.id,
          isDraft: false,
          error: undefined,
        });
      }

      const defaultRunConfiguration = this.options.info.defaultRunConfiguration;
      const run = await this.options.client.createRun(session.id, {
        goal,
        workspace: this.options.workspace,
        model,
        runtime: defaultRunConfiguration.runtime,
        preset: permissionPreset,
        ...(selection.reasoningLevel === undefined
          ? {}
          : { reasoningLevel: selection.reasoningLevel }),
        ...(defaultRunConfiguration.limits === undefined
          ? { resourcePolicy: defaultRunConfiguration.resourcePolicy! }
          : { limits: defaultRunConfiguration.limits }),
      });
      const boundPreset = runPermissionPreset(run) ?? permissionPreset;
      const runs = [...this.snapshot.runs, run];
      const optimisticUser: TranscriptEntry = {
        id: `optimistic:user:${run.id}`,
        runId: run.id,
        conversationTurnId: run.id,
        createdAt: run.createdAt,
        kind: "USER",
        text: goal,
      };
      const optimisticPresentation = optimisticPresentationUser(run, goal);
      this.publish({
        history: reconcileSessionTranscript(this.snapshot.history, [optimisticUser]),
      });
      const history = await this.loadSessionTranscript(session.id, [optimisticUser]);
      const turnPresentation = await this.loadSessionTurnPresentation(session.id, [
        optimisticPresentation,
      ]);
      this.publish({
        candidates: this.upsertCandidate(session, run),
        status: "READY",
        runs,
        history,
        turnPresentation,
        activeRuns: [run],
        activeRun: run,
        timeline: createInitialTimelineState(run.id),
        liveActivity: createInitialLiveActivityState(run.id),
        contextUsage: null,
        selectedPreset: boundPreset,
        permissionPresetError: undefined,
        isDraft: false,
        composerEnabled: false,
        submission: "RUN_CREATED",
        error: undefined,
      });

      const active = this.attachLifecycle(run);
      await Promise.resolve();
      if (this.disposed || this.activeLifecycle !== active) return false;
      if (active.failure !== undefined) {
        return false;
      }
      this.publish({ submission: "STARTING", error: undefined });
      return this.confirmPendingRun(run.id);
    } catch {
      if (
        this.activeLifecycle !== undefined &&
        this.activeLifecycle.run.id === this.snapshot.activeRun?.id
      ) {
        const code = this.activeLifecycle.failure ?? "RUN_START_FAILED";
        this.publish({
          activeRuns: [this.snapshot.activeRun],
          activeRun: this.snapshot.activeRun,
          composerEnabled: false,
          submission: "ACTIVE",
          error: sessionError(code),
        });
        return false;
      }
      const code = session === undefined ? "SESSION_CREATE_FAILED" : "RUN_CREATE_FAILED";
      this.publish({
        submission: "IDLE",
        composerEnabled: true,
        error: sessionError(code),
      });
      return false;
    }
  }

  async createContinuitySession(): Promise<boolean> {
    const oldSession = this.snapshot.selectedSession;
    const selection = this.currentModelSelection();
    if (
      this.disposed ||
      oldSession === undefined ||
      !this.snapshot.continuityWarning ||
      this.snapshot.activeRuns.length > 0 ||
      this.snapshot.submission !== "IDLE" ||
      selection === undefined ||
      !this.isSelectionAvailable(selection)
    ) {
      return false;
    }

    const title = `${oldSession.title ?? "旧会话"}（新会话）`;
    const model = { provider: selection.provider, model: selection.model };
    this.publish({ submission: "SUBMITTING", error: undefined });
    try {
      const session = await this.options.client.createSession(
        this.options.client.listWorkspaceSessions === undefined
          ? {
              title,
              defaultWorkspace: this.options.workspace,
              defaultModel: model,
              ...(selection.reasoningLevel === undefined
                ? {}
                : { defaultReasoningLevel: selection.reasoningLevel }),
              metadata: {},
            }
          : {
              title,
              workspaceId: this.options.workspace.id,
              defaultModel: model,
              ...(selection.reasoningLevel === undefined
                ? {}
                : { defaultReasoningLevel: selection.reasoningLevel }),
              metadata: {},
            },
      );
      const candidates = this.upsertCandidate(session);
      this.options.selectionStore?.setCandidates(
        this.options.workspace.id,
        candidates.map((candidate) => candidate.session.id),
      );
      this.options.selectionStore?.write(this.options.workspace.id, session.id);
      this.cancelActiveLifecycle();
      this.clearApprovals();
      this.publish({
        status: "READY",
        candidates,
        selectedSession: session,
        selectedSessionId: session.id,
        runs: [],
        history: [],
        turnPresentation: undefined,
        activeRuns: [],
        activeRun: undefined,
        timeline: createInitialTimelineState(),
        liveActivity: createInitialLiveActivityState(),
        contextUsage: null,
        continuityWarning: false,
        modelSelection: selection,
        isDraft: false,
        composerEnabled: true,
        submission: "IDLE",
        controlMode: "NONE",
        approvalState: undefined,
        error: undefined,
      });
      return true;
    } catch {
      this.publish({ submission: "IDLE", error: sessionError("SESSION_CREATE_FAILED") });
      return false;
    }
  }

  async selectModel(selection: ClientModelSelectionWithReasoning): Promise<boolean> {
    if (this.disposed || this.hasActiveRun()) return false;
    try {
      if (
        this.snapshot.selectedSession !== undefined &&
        this.options.client.updateSessionModelSelection !== undefined
      ) {
        const updated = await this.options.client.updateSessionModelSelection(
          this.snapshot.selectedSession.id,
          {
            defaultModel: { provider: selection.provider, model: selection.model },
            ...(selection.reasoningLevel === undefined
              ? {}
              : { defaultReasoningLevel: selection.reasoningLevel }),
          },
        );
        this.publish({
          selectedSession: updated,
          modelSelection: selection,
          candidates: this.upsertCandidate(updated),
          error: undefined,
        });
        void this.refreshContinuityPreflight(updated.id, selection);
        return true;
      }
      if (this.options.client.setDefaultAISelection !== undefined) {
        const response = await this.options.client.setDefaultAISelection(selection);
        if (response.selection === undefined) return false;
        this.publish({
          defaultSelection: response.selection,
          modelSelection: response.selection,
          error: undefined,
        });
        return true;
      }
      this.publish({ modelSelection: selection, error: undefined });
      return true;
    } catch {
      this.publish({ error: sessionError("DEFAULT_MODEL_UNAVAILABLE") });
      return false;
    }
  }

  async connectProvider(providerId: string, apiKey: string): Promise<boolean> {
    if (this.options.client.connectAIProvider === undefined) return false;
    try {
      await this.options.client.connectAIProvider(providerId, { apiKey });
      await this.loadAIControl();
      return true;
    } catch {
      return false;
    }
  }

  async disconnectProvider(providerId: string): Promise<boolean> {
    if (this.options.client.disconnectAIProvider === undefined) return false;
    try {
      await this.options.client.disconnectAIProvider(providerId);
      await this.loadAIControl();
      return true;
    } catch {
      return false;
    }
  }

  private async loadAIControl(): Promise<void> {
    const client = this.options.client;
    if (
      client.listAIProviders === undefined ||
      client.getAIModelDirectory === undefined ||
      client.getDefaultAISelection === undefined
    ) {
      if (this.options.info.defaultModel !== undefined) {
        const fallback = this.options.info.defaultModel;
        this.publish({ defaultSelection: fallback, modelSelection: fallback });
      }
      return;
    }
    try {
      const [providers, directory, defaultResponse] = await Promise.all([
        client.listAIProviders(),
        client.getAIModelDirectory(),
        client.getDefaultAISelection(),
      ]);
      this.publish({
        aiProviders: providers.providers,
        modelDirectory: directory.models,
        ...(defaultResponse.selection === undefined
          ? { defaultSelection: undefined, modelSelection: undefined }
          : {
              defaultSelection: defaultResponse.selection,
              modelSelection: defaultResponse.selection,
            }),
      });
    } catch {
      // An older daemon remains usable through its compatibility info snapshot.
      if (this.options.info.defaultModel !== undefined) {
        const fallback = this.options.info.defaultModel;
        this.publish({ defaultSelection: fallback, modelSelection: fallback });
      }
    }
  }

  async selectPermissionPreset(selection: PermissionPresetSelection): Promise<boolean> {
    if (
      this.disposed ||
      this.hasActiveRun() ||
      this.snapshot.submission !== "IDLE" ||
      this.snapshot.preparingPreset !== undefined
    )
      return false;
    const preset = this.snapshot.availablePresets.find(
      (candidate) => candidate.id === selection.id,
    );
    if (
      preset === undefined ||
      preset.version !== selection.expectedVersion ||
      preset.status !== "AVAILABLE"
    ) {
      this.publish({ error: sessionError("PERMISSION_PRESET_UNAVAILABLE") });
      return false;
    }
    this.options.permissionPresetStore?.write(this.options.workspace.id, selection);
    this.publish({
      requestedPreset: selection,
      selectedPreset: selection,
      permissionPresetError: undefined,
      error: undefined,
    });
    return true;
  }

  async preparePermissionPreset(selection: PermissionPresetSelection): Promise<boolean> {
    if (
      this.disposed ||
      this.hasActiveRun() ||
      this.snapshot.submission !== "IDLE" ||
      this.snapshot.preparingPreset !== undefined
    )
      return false;
    const preset = this.snapshot.availablePresets.find(
      (candidate) => candidate.id === selection.id,
    );
    if (
      preset === undefined ||
      preset.version !== selection.expectedVersion ||
      preset.status !== "PREPARATION_REQUIRED"
    ) {
      this.publish({ error: sessionError("PERMISSION_PRESET_UNAVAILABLE") });
      return false;
    }

    this.publish({
      requestedPreset: selection,
      preparingPreset: selection,
      permissionPresetError: undefined,
      error: undefined,
    });
    const failPreparation = (error: WebSessionError): false => {
      this.publish({
        requestedPreset: this.snapshot.selectedPreset,
        error,
      });
      return false;
    };
    const prepare = this.options.client.prepareWorkspaceSecurity;
    if (prepare === undefined) {
      const error = permissionPreparationError();
      return failPreparation(error);
    }
    try {
      const response = await prepare.call(
        this.options.client,
        this.options.workspace.id,
        selection,
      );
      if (
        response.workspaceId !== this.options.workspace.id ||
        response.preset.id !== selection.id ||
        response.preset.expectedVersion !== selection.expectedVersion
      ) {
        const error = permissionPreparationError("WORKSPACE_PREPARATION_RESPONSE_MISMATCH");
        return failPreparation(error);
      }
      if (response.status !== "READY" && response.status !== "PREPARED") {
        const error = permissionPreparationError(response.reasonCode);
        return failPreparation(error);
      }
      // The prepared preset is named explicitly: the reload must select *it*, not re-derive a
      // choice from whatever happened to be persisted before. The capability read—not the
      // preparation acknowledgement—is authoritative for whether the permission is usable.
      await this.loadPermissionPresets(selection.id);
      if (this.disposed) return false;
      if (
        this.snapshot.selectedPreset?.id !== selection.id ||
        this.snapshot.selectedPreset.expectedVersion !== selection.expectedVersion
      ) {
        const error = permissionPreparationError("WORKSPACE_PREPARATION_NOT_CONFIRMED");
        return failPreparation(error);
      }
      this.options.permissionPresetStore?.write(this.options.workspace.id, selection);
      this.publish({
        requestedPreset: selection,
        permissionPresetError: undefined,
        error: undefined,
      });
      return true;
    } catch {
      const error = permissionPreparationError();
      return failPreparation(error);
    } finally {
      this.publish({ preparingPreset: undefined });
    }
  }

  private async loadPermissionPresets(preferredId?: SelectablePermissionPresetId): Promise<void> {
    const getGlobal = this.options.client.getSecurityCapabilities;
    const getWorkspace = this.options.client.getWorkspaceSecurityCapabilities;
    if (getGlobal === undefined || getWorkspace === undefined) {
      // Compatibility clients do not know the capability endpoint. They may retain the safe
      // Workspace Write default, but they can never synthesize or silently select Full Access.
      const fallbackId =
        this.options.info.defaultRunConfiguration.defaultPreset ?? DEFAULT_PERMISSION_PRESET_ID;
      const safeFallback =
        fallbackId === "FULL_ACCESS" || fallbackId === "LEGACY_CUSTOM"
          ? DEFAULT_PERMISSION_PRESET_ID
          : fallbackId;
      this.publish({
        requestedPreset: { id: safeFallback, expectedVersion: 1 },
        selectedPreset: { id: safeFallback, expectedVersion: 1 },
        availablePresets: [],
        permissionPresetError: undefined,
      });
      return;
    }
    try {
      const [capabilities, workspaceCapabilities] = await Promise.all([
        getGlobal.call(this.options.client),
        getWorkspace.call(this.options.client, this.options.workspace.id),
      ]);
      const availablePresets = projectPermissionPresetViewModels(
        capabilities,
        workspaceCapabilities,
      );
      const persisted = this.options.permissionPresetStore?.read(this.options.workspace.id);
      const configuredId =
        persisted?.id ??
        this.options.info.defaultRunConfiguration.defaultPreset ??
        capabilities.defaultPreset;
      const requestedId =
        configuredId === "LEGACY_CUSTOM" ? capabilities.defaultPreset : configuredId;
      const requestedCandidate = availablePresets.find((preset) => preset.id === requestedId);
      const selectedPreset =
        preferredId !== undefined
          ? // An explicit preference (a preparation the host just accepted) always wins. It still
            // cannot select Full Access implicitly, because `choosePermissionPreset` excludes any
            // preset that requires confirmation.
            choosePermissionPreset(availablePresets, preferredId)
          : persisted !== undefined &&
              persisted.expectedVersion ===
                availablePresets.find((preset) => preset.id === persisted.id)?.version
            ? choosePermissionPreset(availablePresets, persisted.id)
            : choosePermissionPreset(availablePresets, requestedId);
      const requestedPreset =
        requestedCandidate === undefined ||
        requestedCandidate.status === "PREPARATION_REQUIRED" ||
        (requestedCandidate.requiresConfirmation && preferredId === undefined)
          ? selectedPreset
          : { id: requestedCandidate.id, expectedVersion: requestedCandidate.version };
      this.publish({
        permissionCapabilities: capabilities,
        availablePresets,
        requestedPreset,
        selectedPreset,
        permissionPresetError:
          selectedPreset === undefined
            ? sessionError("PERMISSION_PRESET_UNAVAILABLE").message
            : undefined,
        error:
          selectedPreset === undefined ? sessionError("PERMISSION_PRESET_UNAVAILABLE") : undefined,
      });
    } catch {
      this.publish({
        permissionCapabilities: undefined,
        availablePresets: [],
        requestedPreset: undefined,
        selectedPreset: undefined,
        permissionPresetError: sessionError("PERMISSION_CAPABILITIES_FAILED").message,
        error: sessionError("PERMISSION_CAPABILITIES_FAILED"),
      });
    }
  }

  private currentModelSelection(): ClientModelSelectionWithReasoning | undefined {
    const session = this.snapshot.selectedSession;
    if (session?.defaultModel !== undefined) {
      return session.defaultReasoningLevel === undefined
        ? { provider: session.defaultModel.provider, model: session.defaultModel.model }
        : {
            provider: session.defaultModel.provider,
            model: session.defaultModel.model,
            reasoningLevel: session.defaultReasoningLevel,
          };
    }
    return this.snapshot.modelSelection ?? this.snapshot.defaultSelection;
  }

  private currentPermissionPreset(): PermissionPresetSelection | undefined {
    if (this.options.client.getSecurityCapabilities === undefined) {
      if (this.snapshot.selectedPreset !== undefined) return this.snapshot.selectedPreset;
      const configured =
        this.options.info.defaultRunConfiguration.defaultPreset ?? DEFAULT_PERMISSION_PRESET_ID;
      return {
        id:
          configured === "FULL_ACCESS" || configured === "LEGACY_CUSTOM"
            ? DEFAULT_PERMISSION_PRESET_ID
            : configured,
        expectedVersion: 1,
      };
    }
    return this.snapshot.selectedPreset;
  }

  private isSelectionAvailable(selection: ClientModelSelectionWithReasoning): boolean {
    if (this.snapshot.modelDirectory === undefined) return true;
    return this.snapshot.modelDirectory.some(
      (model) => model.provider === selection.provider && model.id === selection.model,
    );
  }

  async refreshApprovals(runId: RunId): Promise<void> {
    if (this.disposed) return;
    if (this.snapshot.activeRun !== undefined && this.snapshot.activeRun.id !== runId) return;
    const context = this.captureApprovalContext(runId);
    try {
      const response = await this.options.client.listPendingApprovals(runId);
      if (!this.disposed && this.isCurrentApprovalContext(context)) {
        this.publishApprovals(runId, response.items);
      }
    } catch {
      // Approval controls are presentation-only; retain the last safe projection.
    }
  }

  async resolveApproval(
    approvalId: ApprovalRequestId,
    resolution: ApprovalResolution,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const approvalState = this.snapshot.approvalState;
    const approval = approvalState?.requests.find((item) => item.id === approvalId);
    if (
      approval === undefined ||
      approvalState === undefined ||
      approvalState.submitting.includes(approvalId) ||
      this.resolvingApprovals.has(approvalId)
    ) {
      return false;
    }

    const context = this.captureApprovalContext(approval.runId);
    if (!this.isCurrentApprovalContext(context)) return false;
    this.resolvingApprovals.add(approvalId);
    this.publishSubmitting(approvalId, true);
    try {
      const pending = await this.options.client.listPendingApprovals(approval.runId);
      if (this.disposed || !this.isCurrentApprovalContext(context)) return false;
      this.publishApprovals(approval.runId, pending.items);
      if (!pending.items.some((item) => item.id === approvalId && item.status === "PENDING")) {
        await this.reconcileApprovals(approval.runId, approvalId, context);
        return false;
      }
      await this.options.client.resolveApproval(approval.runId, approvalId, resolution);
      return !this.disposed && this.isCurrentApprovalContext(context);
    } catch {
      await this.reconcileApprovals(approval.runId, approvalId, context);
      return false;
    } finally {
      this.resolvingApprovals.delete(approvalId);
      if (!this.disposed && this.isCurrentApprovalContext(context)) {
        this.publishSubmitting(approvalId, false);
      }
    }
  }

  cancelRun(): Promise<boolean> {
    if (this.cancelPromise !== undefined) return this.cancelPromise;
    const run = this.snapshot.activeRun;
    if (this.disposed || run === undefined || !canCancelRunStatus(run.status)) {
      return Promise.resolve(false);
    }

    const context = this.captureApprovalContext(run.id);
    this.publish({ controlMode: "CANCELLING", error: undefined });
    const promise = this.requestCancellation(run, context);
    this.cancelPromise = promise;
    void promise.then(() => {
      if (this.cancelPromise === promise) this.cancelPromise = undefined;
    });
    return promise;
  }

  continueResourceGuard(): Promise<boolean> {
    if (this.resourceContinuePromise !== undefined) return this.resourceContinuePromise;
    const run = this.snapshot.activeRun;
    if (this.disposed || run === undefined || run.status !== "WAITING_RESOURCE")
      return Promise.resolve(false);
    const promise = this.requestResourceContinuation(run.id);
    this.resourceContinuePromise = promise;
    void promise.then(() => {
      if (this.resourceContinuePromise === promise) this.resourceContinuePromise = undefined;
    });
    return promise;
  }

  private async requestResourceContinuation(runId: RunId): Promise<boolean> {
    try {
      const response = await this.options.client.continueResourceGuard(runId);
      if (this.disposed || this.snapshot.activeRun?.id !== runId) return false;
      this.publishActiveRun(response.run, "ACTIVE");
      return true;
    } catch {
      if (!this.disposed && this.snapshot.activeRun?.id === runId) {
        this.publish({ controlMode: "RESOURCE_GUARD", error: sessionError("RUN_REFRESH_FAILED") });
      }
      return false;
    }
  }

  reconnectActiveRun(): void {
    const active = this.activeLifecycle;
    if (this.disposed || active === undefined || this.snapshot.transportState !== "DISCONNECTED") {
      return;
    }
    this.publish({
      transportState: "RECONNECTING",
      transportAttempt: 1,
      error: undefined,
    });
    active.scheduler.manualRetry();
  }

  async prepareRecoveryRun(run: ClientAgentRun): Promise<boolean> {
    if (this.disposed || !nonTerminalRuns([run]).some((item) => item.id === run.id)) return false;
    if (this.snapshot.activeRun?.id !== run.id) return false;
    if (run.status === "PENDING") {
      this.publish({ controlMode: "PENDING_RUN_CONFIRMATION", composerEnabled: false });
      return true;
    }
    if (run.status === "WAITING_RESOURCE") {
      this.publish({
        controlMode: "RESOURCE_GUARD",
        composerEnabled: false,
        error: undefined,
      });
      this.attachLifecycle(run, false);
      return true;
    }
    let approvals: Awaited<ReturnType<WebSessionClient["listPendingApprovals"]>>;
    try {
      if (this.options.client.listPendingApprovals === undefined) {
        throw new Error("approval query unavailable");
      }
      approvals = await this.options.client.listPendingApprovals(run.id);
    } catch {
      this.publish({ error: sessionError("RUN_REFRESH_FAILED") });
      const active = this.activeLifecycle;
      if (active !== undefined && active.run.id === run.id) {
        active.recoveryRevoked = true;
      } else {
        const attached = this.attachLifecycle(run, false);
        attached.recoveryRevoked = true;
      }
      return true;
    }
    this.publishApprovals(run.id, approvals.items);
    const hasPendingApproval = approvals.items.some((item) => item.status === "PENDING");
    if (run.status === "WAITING_APPROVAL" && hasPendingApproval) {
      const active = this.activeLifecycle;
      if (active !== undefined && active.run.id === run.id) {
        active.recoveryRevoked = true;
      } else {
        const attached = this.attachLifecycle(run, false);
        attached.recoveryRevoked = true;
      }
      return true;
    }
    const active = this.activeLifecycle;
    if (active !== undefined && active.run.id === run.id) {
      active.recoveryRevoked = false;
      if (
        !active.recoveryOnOpen ||
        (active.streamOpenGeneration === active.streamGeneration && !active.recoveryAdmitted)
      ) {
        this.attachStream(active, true);
      }
    } else {
      this.attachLifecycle(run, true);
    }
    return true;
  }

  async selectRecoveryRun(runId: RunId): Promise<boolean> {
    const run = this.snapshot.activeRuns.find((item) => item.id === runId);
    if (run === undefined) return false;
    const session = this.snapshot.selectedSession;
    if (session === undefined || session.id !== run.sessionId) return false;
    this.clearApprovals();
    this.publish({ activeRun: run, controlMode: "NONE", error: undefined, composerEnabled: false });
    return this.prepareRecoveryRun(run);
  }

  async confirmPendingRun(runId: RunId): Promise<boolean> {
    const run = this.snapshot.activeRun;
    if (this.disposed || run?.id !== runId || run.status !== "PENDING") return false;
    let active = this.activeLifecycle;
    if (active === undefined || active.run.id !== runId) active = this.attachLifecycle(run, false);
    try {
      this.publish({ submission: "STARTING", controlMode: "NONE", error: undefined });
      const response = await this.options.client.startRun(runId);
      if (this.activeLifecycle !== active) return false;
      this.publishActiveRun(response.run, "ACTIVE");
      return true;
    } catch {
      this.publish({
        error: sessionError("RUN_START_FAILED"),
        controlMode: "PENDING_RUN_CONFIRMATION",
      });
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPendingPublicationFrame();
    this.cancelActiveLifecycle();
    this.listeners.clear();
  }

  private async loadSessionTranscript(
    sessionId: SessionId,
    optimistic: readonly TranscriptEntry[] = [],
  ): Promise<readonly TranscriptEntry[]> {
    const getSessionTranscript = this.options.client.getSessionTranscript;
    if (this.options.info.capabilities.sessionTranscript === true && getSessionTranscript) {
      const items: TranscriptEntry[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await getSessionTranscript.call(this.options.client, sessionId, {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        items.push(...response.items);
        cursor = nextPageCursor(response.nextCursor, seenCursors);
      } while (cursor !== undefined);
      return reconcileSessionTranscript(items, optimistic);
    }
    throw new CaelushProtocolCompatibilityError();
  }

  private async loadSessionTurnPresentation(
    sessionId: SessionId,
    optimistic: readonly OptimisticPresentationUser[] = [],
  ): Promise<SessionTurnPresentationResponse | undefined> {
    const getPresentation = this.options.client.getSessionTurnPresentation;
    if (
      this.options.info.capabilities.sessionTurnPresentation !== true ||
      getPresentation === undefined
    ) {
      return undefined;
    }
    const items: TurnPresentationItem[] = [];
    const turns: SessionTurnPresentationTurnV3[] = [];
    const seenRunIds = new Set<RunId>();
    const seenTurnIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let highWatermark = 0;
    let capabilityVersion: 1 | 2 | 3 | undefined;
    do {
      const response = await getPresentation.call(this.options.client, sessionId, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (capabilityVersion !== undefined && response.capabilityVersion !== capabilityVersion) {
        throw new CaelushProtocolCompatibilityError();
      }
      capabilityVersion ??= response.capabilityVersion;
      if (response.capabilityVersion === 3) {
        for (const turn of response.turns) {
          if (seenRunIds.has(turn.runId) || seenTurnIds.has(turn.conversationTurnId)) {
            throw new CaelushProtocolCompatibilityError();
          }
          seenRunIds.add(turn.runId);
          seenTurnIds.add(turn.conversationTurnId);
          turns.push(turn);
        }
      } else {
        items.push(...response.items);
        highWatermark = Math.max(highWatermark, response.highWatermark);
      }
      cursor = nextPageCursor(response.nextCursor, seenCursors);
    } while (cursor !== undefined);
    const presentation: SessionTurnPresentationResponse =
      capabilityVersion === 3
        ? { capabilityVersion: 3, turns }
        : { capabilityVersion: capabilityVersion ?? 1, items, highWatermark };
    return reconcileTurnPresentation(presentation, optimistic);
  }

  private async listWorkspaceSessionCandidates(): Promise<readonly SessionCandidate[]> {
    const listWorkspaceSessions = this.options.client.listWorkspaceSessions;
    if (listWorkspaceSessions === undefined) return [];
    const response = await listWorkspaceSessions.call(
      this.options.client,
      this.options.workspace.id,
    );
    return response.items.map((summary) => ({
      session: summary.session,
      ...(summary.latestRun === undefined ? {} : { latestRun: summary.latestRun }),
      lastActivityAt: summary.lastActivityAt,
    }));
  }

  private optimisticTranscriptEntries(): readonly TranscriptEntry[] {
    return this.snapshot.history.filter(
      (entry) => entry.kind === "USER" && entry.id.startsWith("optimistic:user:"),
    );
  }

  private async applySelectedSession(
    session: ClientAgentSession,
    runs: readonly ClientAgentRun[],
  ): Promise<boolean> {
    const activeRuns = nonTerminalRuns(runs);
    const contextUsageRun = selectContextUsageRun(runs, activeRuns);
    this.clearApprovals();
    this.publish({
      status: "READY",
      selectedSession: session,
      selectedSessionId: session.id,
      runs,
      history: await this.loadSessionTranscript(session.id),
      turnPresentation: await this.loadSessionTurnPresentation(session.id),
      activeRuns,
      activeRun: activeRuns.length === 1 ? activeRuns[0] : undefined,
      selectedPreset:
        (activeRuns.length === 1 ? runPermissionPreset(activeRuns[0]) : undefined) ??
        runPermissionPreset(latestRun(runs)) ??
        this.snapshot.selectedPreset,
      timeline: createInitialTimelineState(activeRuns.length === 1 ? activeRuns[0]?.id : undefined),
      liveActivity: createInitialLiveActivityState(
        activeRuns.length === 1 ? activeRuns[0]?.id : undefined,
      ),
      contextUsage: null,
      continuityWarning: false,
      modelSelection:
        session.defaultModel === undefined
          ? undefined
          : {
              provider: session.defaultModel.provider,
              model: session.defaultModel.model,
              ...(session.defaultReasoningLevel === undefined
                ? {}
                : { reasoningLevel: session.defaultReasoningLevel }),
            },
      isDraft: false,
      composerEnabled: activeRuns.length === 0,
      submission: "IDLE",
      controlMode:
        activeRuns.length === 1 && activeRuns[0]?.status === "WAITING_RESOURCE"
          ? "RESOURCE_GUARD"
          : "NONE",
      approvalState: undefined,
      error: activeRuns.length > 1 ? sessionError("MULTIPLE_ACTIVE_RUNS") : undefined,
    });
    void this.refreshContinuityPreflight(
      session.id,
      session.defaultModel ?? this.currentModelSelection(),
    );
    if (activeRuns.length > 1) this.publish({ controlMode: "RECOVERY_PICKER" });
    if (activeRuns.length === 1 && activeRuns[0] !== undefined) {
      await this.prepareRecoveryRun(activeRuns[0]);
      this.scheduleContextUsageRefresh(activeRuns[0].id);
    } else if (contextUsageRun !== undefined) {
      if (isTerminalRunStatus(contextUsageRun.status)) {
        void this.reconcileTerminalContextUsage(contextUsageRun);
      } else {
        void this.refreshContextUsage(contextUsageRun.id);
      }
    }
    return true;
  }

  private async refreshContinuityPreflight(
    sessionId: SessionId,
    model: { readonly provider: string; readonly model: string } | undefined,
  ): Promise<void> {
    const generation = ++this.continuityPreflightGeneration;
    const getPreflight = this.options.client.getSessionContinuityPreflight;
    if (
      this.options.info.capabilities.sessionContinuityPreflight !== true ||
      getPreflight === undefined ||
      model === undefined
    ) {
      return;
    }
    try {
      const result = await getPreflight.call(this.options.client, sessionId, model);
      const currentModel = this.currentModelSelection();
      if (
        this.disposed ||
        this.continuityPreflightGeneration !== generation ||
        this.snapshot.selectedSessionId !== sessionId ||
        currentModel?.provider !== model.provider ||
        currentModel.model !== model.model
      )
        return;
      this.publish({ continuityWarning: result.status === "POSSIBLE_INCOMPATIBILITY" });
    } catch {
      // This advisory check never blocks transcript access or Run creation.
    }
  }

  private async requestCancellation(
    run: ClientAgentRun,
    context: ApprovalContext,
  ): Promise<boolean> {
    try {
      const response = await this.options.client.cancelRun(run.id);
      if (this.disposed || this.snapshot.activeRun?.id !== run.id) return false;
      if (isTerminalRunStatus(response.run.status)) {
        await this.publishTerminalReconciliation(response.run, context);
        return !this.disposed;
      }
      this.publishActiveRun(response.run, this.snapshot.submission);
      this.restoreControlMode();
      await this.refreshApprovals(run.id);
      return !this.disposed && this.snapshot.activeRun?.id === run.id;
    } catch {
      if (!this.disposed && this.snapshot.activeRun?.id === run.id) {
        this.publish({
          controlMode: this.controlModeForApprovals(),
          error: sessionError("RUN_CANCEL_FAILED"),
        });
      }
      return false;
    }
  }

  private attachLifecycle(run: ClientAgentRun, recoverOnOpen = false): ActiveLifecycle {
    const active: ActiveLifecycle = {
      run,
      controller: new AbortController(),
      streamGeneration: 0,
      recoveryAdmitted: false,
      recoveryRevoked: false,
      recoveryOnOpen: recoverOnOpen,
      presentationRefreshPending: false,
      scheduler: new ReconnectScheduler({
        timer: this.options.timer ?? systemWebTimer,
        onAttempt: (attempt) => this.retryActiveStream(active, attempt),
        onExhausted: () => this.markTransportDisconnected(active),
      }),
    };
    this.activeLifecycle = active;
    this.attachStream(active, recoverOnOpen);
    return active;
  }

  private attachStream(active: ActiveLifecycle, recoverOnOpen: boolean): void {
    active.controller.abort();
    active.controller = new AbortController();
    const generation = active.streamGeneration + 1;
    active.streamGeneration = generation;
    if (active.presentationRefreshPromise !== undefined) {
      active.presentationRefreshPending = true;
    }
    active.recoveryAdmitted = false;
    active.recoveryOnOpen = recoverOnOpen;
    void this.consumeLifecycle(active, generation, recoverOnOpen);
  }

  private async consumeLifecycle(
    active: ActiveLifecycle,
    generation: number,
    recoverOnOpen: boolean,
  ): Promise<void> {
    try {
      for await (const event of this.options.client.watchRunEvents(active.run.id, {
        afterSequence: generation === 1 ? 0 : this.snapshot.timeline.lastDurableSequence,
        signal: active.controller.signal,
        onOpen: () => this.handleStreamOpen(active, generation, recoverOnOpen),
      })) {
        if (!this.isCurrentStream(active, generation)) return;
        if (event.runId !== active.run.id) continue;
        const liveActivity = reduceLiveActivityEvent(this.snapshot.liveActivity, event);
        const timeline = reduceTimelineEvent(this.snapshot.timeline, event);
        this.publish(
          { timeline, liveActivity },
          shouldPublishEventOnFrame(event) ? "FRAME" : "IMMEDIATE",
        );
        if (event.durability.kind === "DURABLE") {
          this.requestTurnPresentationRefresh(active, generation);
        }
        if (
          event.type === "run.failed" &&
          event.payload.error.code === "CONVERSATION_CONTINUITY_INCOMPATIBLE"
        ) {
          this.publish({
            continuityWarning: true,
            error: sessionError("CONVERSATION_CONTINUITY_INCOMPATIBLE"),
          });
        }
        if (timeline.error !== undefined) {
          this.handleTerminalStreamError(active, generation);
          return;
        }
        this.projectApprovalEvent(event);
        if (isContextUsageRefreshEvent(event)) this.scheduleContextUsageRefresh(active.run.id);
        if (!isLifecycleEvent(event)) continue;
        let refreshed: ClientAgentRun;
        try {
          refreshed = await this.options.client.getRun(active.run.id);
        } catch {
          if (!this.isCurrentStream(active, generation)) return;
          active.failure = "RUN_REFRESH_FAILED";
          this.publish({ error: sessionError("RUN_REFRESH_FAILED") });
          return;
        }
        if (!this.isCurrentStream(active, generation)) return;
        // A status.changed event can describe an earlier nonterminal boundary while a fast Run has
        // already advanced further in Storage. Keep consuming the ordered event stream in that case;
        // settling from the newer read would cancel the stream before its committed verification and
        // terminal events reached the Timeline.
        if (
          isTerminalRunStatus(refreshed.status) &&
          event.type === "status.changed" &&
          !isTerminalRunStatus(event.payload.to)
        ) {
          continue;
        }
        const terminalTimeline = isTimelineTerminalRunStatus(refreshed.status)
          ? flushTimelineForTerminal(this.snapshot.timeline, refreshed.status)
          : this.snapshot.timeline;
        this.publishActiveRun(refreshed, "ACTIVE", terminalTimeline);
        if (isTerminalRunStatus(refreshed.status)) {
          await this.settleLifecycle(active, refreshed);
          return;
        }
      }
      this.handleStreamFailure(active, generation, undefined);
    } catch (error) {
      this.handleStreamFailure(active, generation, error);
    }
  }

  private handleStreamOpen(
    active: ActiveLifecycle,
    generation: number,
    recoverOnOpen: boolean,
  ): void {
    if (!this.isCurrentStream(active, generation)) return;
    active.scheduler.succeeded();
    active.streamOpenGeneration = generation;
    this.publish({ transportState: "CONNECTED", transportAttempt: undefined, error: undefined });
    if (!recoverOnOpen || active.recoveryAdmitted || active.recoveryRevoked) return;
    active.recoveryAdmitted = true;
    void this.admitRecovery(active, generation);
  }

  private async refreshTurnPresentation(
    active: ActiveLifecycle,
    generation: number,
  ): Promise<void> {
    try {
      const response = await this.loadActiveTurnPresentation(active);
      if (response === undefined || !this.isCurrentStream(active, generation)) return;
      this.publish({
        turnPresentation: response,
        liveActivity: prunePresentationForRun(this.snapshot.liveActivity, response, active.run.id),
      });
    } catch {
      // The durable timeline remains authoritative if the optional read-model refresh races a
      // reconnect or an older daemon. It must never interrupt Run control.
    }
  }

  private requestTurnPresentationRefresh(active: ActiveLifecycle, generation: number): void {
    if (
      this.options.info.capabilities.sessionTurnPresentation !== true ||
      !this.isCurrentStream(active, generation)
    ) {
      return;
    }
    if (active.presentationRefreshPromise !== undefined) {
      active.presentationRefreshPending = true;
      return;
    }

    active.presentationRefreshPending = false;
    const refresh = this.refreshTurnPresentation(active, generation);
    active.presentationRefreshPromise = refresh;
    void refresh.then(
      () => this.completeTurnPresentationRefresh(active, refresh),
      () => this.completeTurnPresentationRefresh(active, refresh),
    );
  }

  private completeTurnPresentationRefresh(active: ActiveLifecycle, refresh: Promise<void>): void {
    if (active.presentationRefreshPromise !== refresh) return;
    delete active.presentationRefreshPromise;
    const pending = active.presentationRefreshPending;
    active.presentationRefreshPending = false;
    if (pending && this.activeLifecycle === active && !this.disposed) {
      this.requestTurnPresentationRefresh(active, active.streamGeneration);
    }
  }

  private async loadActiveTurnPresentation(
    active: ActiveLifecycle,
  ): Promise<SessionTurnPresentationResponse | undefined> {
    const client = this.options.client;
    const getPresentation = client.getSessionTurnPresentation;
    if (
      this.options.info.capabilities.sessionTurnPresentation !== true ||
      getPresentation === undefined
    ) {
      return undefined;
    }

    const optimistic = [optimisticPresentationUser(active.run, active.run.goal)];
    const current = this.snapshot.turnPresentation;
    if (current?.capabilityVersion !== 3) {
      return this.loadSessionTurnPresentation(active.run.sessionId, optimistic);
    }

    const targeted = await getPresentation.call(client, active.run.sessionId, {
      runId: active.run.id,
      limit: 1,
    });
    if (targeted.capabilityVersion !== 3) {
      return this.loadSessionTurnPresentation(active.run.sessionId, optimistic);
    }
    return mergeActiveTurnPresentation(current, targeted, this.snapshot.runs, active.run);
  }

  private async admitRecovery(active: ActiveLifecycle, generation: number): Promise<void> {
    try {
      const response = await this.options.client.recoverRun(active.run.id);
      if (!this.isCurrentStream(active, generation)) return;
      this.publishActiveRun(response.run, this.snapshot.submission);
    } catch {
      if (!this.isCurrentStream(active, generation)) return;
      this.publish({ error: sessionError("RUN_REFRESH_FAILED") });
    }
  }

  private handleStreamFailure(active: ActiveLifecycle, generation: number, error: unknown): void {
    if (!this.isCurrentStream(active, generation) || active.controller.signal.aborted) return;
    if (isTerminalStreamError(error)) {
      this.handleTerminalStreamError(active, generation);
      return;
    }
    this.publish({
      transportState: "RECONNECTING",
      transportAttempt: 1,
      error: undefined,
    });
    active.scheduler.failed();
  }

  private handleTerminalStreamError(active: ActiveLifecycle, generation: number): void {
    if (!this.isCurrentStream(active, generation)) return;
    active.failure = "RUN_STREAM_FAILED";
    this.publish({
      transportState: "DISCONNECTED",
      transportAttempt: undefined,
      error: sessionError("RUN_STREAM_FAILED"),
    });
  }

  private retryActiveStream(active: ActiveLifecycle, attempt: number): void {
    if (this.activeLifecycle !== active || this.disposed) return;
    this.publish({ transportState: "RECONNECTING", transportAttempt: attempt, error: undefined });
    this.attachStream(active, true);
  }

  private markTransportDisconnected(active: ActiveLifecycle): void {
    if (this.activeLifecycle !== active || this.disposed) return;
    active.failure = "RUN_STREAM_FAILED";
    this.publish({
      transportState: "DISCONNECTED",
      transportAttempt: undefined,
      error: sessionError("RUN_RECONNECT_EXHAUSTED"),
    });
  }

  private isCurrentStream(active: ActiveLifecycle, generation: number): boolean {
    return (
      this.activeLifecycle === active && active.streamGeneration === generation && !this.disposed
    );
  }

  private async settleLifecycle(active: ActiveLifecycle, run: ClientAgentRun): Promise<void> {
    try {
      const runs = (await this.options.client.listRuns(run.sessionId, { limit: 100 })).items;
      if (this.activeLifecycle !== active || this.disposed) return;
      this.cancelActiveLifecycle();
      await active.presentationRefreshPromise;
      if (this.disposed) return;
      this.clearApprovals();
      const activeRuns = nonTerminalRuns(runs);
      const activeRun = activeRuns.length === 1 ? activeRuns[0] : undefined;
      const history = await this.loadSessionTranscript(
        run.sessionId,
        this.optimisticTranscriptEntries(),
      );
      const turnPresentation = await this.loadSessionTurnPresentation(run.sessionId);
      if (this.snapshot.selectedSessionId !== run.sessionId) return;
      const retainedLiveActivity =
        turnPresentation === undefined
          ? this.snapshot.liveActivity
          : prunePresentationForRun(
              this.snapshot.liveActivity,
              turnPresentation,
              activeRun?.id ?? run.id,
            );
      this.publish({
        candidates: this.snapshot.selectedSession
          ? this.upsertCandidate(this.snapshot.selectedSession, latestRun(runs))
          : this.snapshot.candidates,
        status: "READY",
        runs,
        history,
        turnPresentation,
        activeRuns,
        activeRun,
        timeline:
          activeRun !== undefined && activeRun.id !== run.id
            ? createInitialTimelineState(activeRun.id)
            : activeRuns.length > 1
              ? createInitialTimelineState()
              : this.snapshot.timeline,
        liveActivity:
          activeRun !== undefined && activeRun.id !== run.id
            ? createInitialLiveActivityState(activeRun.id)
            : activeRuns.length > 1
              ? createInitialLiveActivityState()
              : retainedLiveActivity,
        composerEnabled: activeRuns.length === 0,
        submission: "IDLE",
        approvalState: undefined,
        controlMode: "NONE",
        error: activeRuns.length > 1 ? sessionError("MULTIPLE_ACTIVE_RUNS") : undefined,
      });
      if (isTerminalRunStatus(run.status) && this.currentContextUsageRunId() === run.id) {
        void this.reconcileTerminalContextUsage(run);
      }
    } catch {
      if (this.activeLifecycle !== active || this.disposed) return;
      this.publish({ error: sessionError("RUN_REFRESH_FAILED") });
    }
  }

  private publishActiveRun(
    run: ClientAgentRun,
    submission: WebSubmissionState,
    timeline: TimelineState = this.snapshot.timeline,
  ): void {
    const activeRuns = this.snapshot.activeRuns.map((item) => (item.id === run.id ? run : item));
    const lifecycle = this.activeLifecycle;
    this.publish({
      candidates: this.snapshot.selectedSession
        ? this.upsertCandidate(this.snapshot.selectedSession, run)
        : this.snapshot.candidates,
      activeRuns: activeRuns.length === 0 ? [run] : activeRuns,
      activeRun: run,
      runs: this.snapshot.runs.map((item) => (item.id === run.id ? run : item)),
      timeline,
      submission,
      composerEnabled: false,
      controlMode:
        run.status === "WAITING_RESOURCE"
          ? "RESOURCE_GUARD"
          : run.status === "RUNNING" && this.snapshot.controlMode === "RESOURCE_GUARD"
            ? "NONE"
            : this.snapshot.controlMode,
      error:
        lifecycle?.run.id === run.id && lifecycle.failure !== undefined
          ? sessionError(lifecycle.failure)
          : undefined,
    });
    this.scheduleContextUsageRefresh(run.id);
  }

  private scheduleContextUsageRefresh(runId: RunId): void {
    if (this.options.client.getRunContextUsage === undefined || this.disposed) return;
    if (this.contextUsageRefreshTimer !== undefined) {
      if (this.contextUsageRefreshRunId === runId) return;
      this.contextUsageRefreshTimer.cancel();
      this.contextUsageRefreshTimer = undefined;
    }
    const generation = ++this.contextUsageRefreshGeneration;
    this.contextUsageRefreshRunId = runId;
    this.contextUsageRefreshTimer = (this.options.timer ?? systemWebTimer).schedule(
      CONTEXT_USAGE_REFRESH_DELAY_MS,
      () => {
        this.contextUsageRefreshTimer = undefined;
        if (this.contextUsageRefreshGeneration !== generation) return;
        void this.refreshContextUsage(runId, generation);
      },
    );
  }

  private async refreshContextUsage(
    runId: RunId,
    generation = this.contextUsageRefreshGeneration,
    sessionId = this.snapshot.selectedSessionId,
  ): Promise<ContextUsageProjection | null | undefined> {
    const getContextUsage = this.options.client.getRunContextUsage;
    if (getContextUsage === undefined || this.disposed || sessionId === undefined) return undefined;
    try {
      const usage = await getContextUsage.call(this.options.client, runId);
      if (
        this.disposed ||
        this.contextUsageRefreshGeneration !== generation ||
        this.snapshot.selectedSessionId !== sessionId ||
        this.currentContextUsageRunId() !== runId
      )
        return undefined;
      this.publish({ contextUsage: usage ?? null });
      return usage;
    } catch {
      // Context diagnostics are optional UI and never change Run control state.
      return undefined;
    }
  }

  private async reconcileTerminalContextUsage(run: ClientAgentRun): Promise<void> {
    if (
      !isTerminalRunStatus(run.status) ||
      this.options.client.getRunContextUsage === undefined ||
      this.disposed ||
      this.snapshot.selectedSessionId !== run.sessionId ||
      this.currentContextUsageRunId() !== run.id
    ) {
      return;
    }

    // Invalidate a queued/in-flight live read, then give this terminal reconciliation its own
    // generation and Run/Session identity before its immediate durable projection request.
    this.invalidateContextUsageRefresh();
    const generation = ++this.contextUsageRefreshGeneration;
    this.contextUsageRefreshRunId = run.id;
    const usage = await this.refreshContextUsage(run.id, generation, run.sessionId);
    if (
      usage?.promptCache?.metricsV2?.usageCoverage?.status !== "PARTIAL" ||
      !this.isCurrentContextUsageRequest(run.sessionId, run.id, generation)
    ) {
      return;
    }

    // One bounded retry allows durable invocation rows to settle. A second PARTIAL stays true.
    this.contextUsageRefreshTimer = (this.options.timer ?? systemWebTimer).schedule(
      TERMINAL_CONTEXT_USAGE_RETRY_DELAY_MS,
      () => {
        this.contextUsageRefreshTimer = undefined;
        if (!this.isCurrentContextUsageRequest(run.sessionId, run.id, generation)) return;
        void this.refreshContextUsage(run.id, generation, run.sessionId);
      },
    );
  }

  private isCurrentContextUsageRequest(
    sessionId: SessionId,
    runId: RunId,
    generation: number,
  ): boolean {
    return (
      !this.disposed &&
      this.contextUsageRefreshGeneration === generation &&
      this.contextUsageRefreshRunId === runId &&
      this.snapshot.selectedSessionId === sessionId &&
      this.currentContextUsageRunId() === runId
    );
  }

  private projectApprovalEvent(event: PublicRunEvent): void {
    if (event.type === "approval.requested") {
      const current = this.snapshot.approvalState?.requests ?? [];
      const otherRequests = current.filter((item) => item.id !== event.payload.approval.id);
      this.publishApprovalState(
        [...otherRequests, createApprovalView(event.payload.approval)],
        this.snapshot.approvalState?.submitting ?? [],
      );
      return;
    }
    if (event.type === "approval.resolved") {
      const current = this.snapshot.approvalState;
      if (current === undefined) return;
      this.publishApprovalState(
        current.requests.filter((item) => item.id !== event.payload.approvalId),
        current.submitting.filter((item) => item !== event.payload.approvalId),
      );
    }
  }

  private async reconcileApprovals(
    runId: RunId,
    affectedApprovalId: ApprovalRequestId,
    context: ApprovalContext,
  ): Promise<void> {
    const [run, approvals] = await Promise.allSettled([
      this.options.client.getRun(runId),
      this.options.client.listPendingApprovals(runId),
    ]);
    if (this.disposed || !this.isCurrentApprovalContext(context)) return;
    if (run.status === "fulfilled" && isTerminalRunStatus(run.value.status)) {
      await this.publishTerminalReconciliation(run.value, context);
      return;
    }
    if (run.status === "fulfilled" && this.snapshot.activeRun?.id === runId) {
      this.publishActiveRun(run.value, this.snapshot.submission);
    }
    if (approvals.status === "fulfilled") this.publishApprovals(runId, approvals.value.items);
    else this.removeApproval(affectedApprovalId);
  }

  private async publishTerminalReconciliation(
    run: ClientAgentRun,
    context: ApprovalContext,
  ): Promise<void> {
    let runs = this.snapshot.runs.map((item) => (item.id === run.id ? run : item));
    try {
      runs = (await this.options.client.listRuns(run.sessionId, { limit: 100 })).items;
    } catch {
      // The terminal Run is still authoritative; preserve known session history if list refresh fails.
    }
    runs = upsertConfirmedTerminalRun(runs, run);
    if (this.disposed || !this.isCurrentApprovalContext(context)) return;
    const activeLifecycle =
      this.activeLifecycle?.run.id === run.id ? this.activeLifecycle : undefined;
    if (activeLifecycle !== undefined) this.cancelActiveLifecycle();
    await activeLifecycle?.presentationRefreshPromise;
    if (this.disposed || !this.isCurrentApprovalContext(context)) return;
    const activeRuns = nonTerminalRuns(runs);
    const activeRun = activeRuns.length === 1 ? activeRuns[0] : undefined;
    this.clearApprovals();
    const reconciliationGeneration = this.approvalContextGeneration;
    const history = await this.loadSessionTranscript(
      run.sessionId,
      this.optimisticTranscriptEntries(),
    );
    const turnPresentation = await this.loadSessionTurnPresentation(run.sessionId);
    if (
      this.disposed ||
      this.snapshot.selectedSessionId !== context.sessionId ||
      this.approvalContextGeneration !== reconciliationGeneration
    )
      return;
    const retainedLiveActivity =
      turnPresentation === undefined
        ? this.snapshot.liveActivity
        : prunePresentationForRun(
            this.snapshot.liveActivity,
            turnPresentation,
            activeRun?.id ?? run.id,
          );
    this.publish({
      candidates: this.snapshot.selectedSession
        ? this.upsertCandidate(this.snapshot.selectedSession, latestRun(runs))
        : this.snapshot.candidates,
      runs,
      history,
      turnPresentation,
      activeRuns,
      activeRun,
      timeline:
        activeRun !== undefined && activeRun.id !== run.id
          ? createInitialTimelineState(activeRun.id)
          : activeRuns.length > 1
            ? createInitialTimelineState()
            : this.snapshot.timeline,
      liveActivity:
        activeRun !== undefined && activeRun.id !== run.id
          ? createInitialLiveActivityState(activeRun.id)
          : activeRuns.length > 1
            ? createInitialLiveActivityState()
            : retainedLiveActivity,
      composerEnabled: activeRuns.length === 0,
      submission: "IDLE",
      approvalState: undefined,
      controlMode: "NONE",
      error: activeRuns.length > 1 ? sessionError("MULTIPLE_ACTIVE_RUNS") : undefined,
    });
    if (isTerminalRunStatus(run.status) && this.currentContextUsageRunId() === run.id) {
      void this.reconcileTerminalContextUsage(run);
    }
  }

  private publishApprovals(
    runId: RunId,
    approvals: readonly import("@caelush/protocol").ApprovalRequest[],
  ): void {
    const requests = approvals
      .filter((item) => item.status === "PENDING")
      .map(createApprovalView)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
    const submitting = (this.snapshot.approvalState?.submitting ?? []).filter((id) =>
      requests.some((request) => request.id === id),
    );
    this.publishApprovalState(requests, submitting);
  }

  private publishSubmitting(approvalId: ApprovalRequestId, submitting: boolean): void {
    const current = this.snapshot.approvalState;
    if (current === undefined) return;
    this.publishApprovalState(
      current.requests,
      submitting
        ? [...current.submitting, approvalId]
        : current.submitting.filter((item) => item !== approvalId),
    );
  }

  private removeApproval(approvalId: ApprovalRequestId): void {
    const current = this.snapshot.approvalState;
    if (current === undefined) return;
    this.publishApprovalState(
      current.requests.filter((item) => item.id !== approvalId),
      current.submitting.filter((item) => item !== approvalId),
    );
  }

  private clearApprovals(): void {
    this.approvalContextGeneration += 1;
    this.publish({ approvalState: undefined, controlMode: "NONE" });
  }

  private captureApprovalContext(runId: RunId): ApprovalContext {
    return {
      generation: this.approvalContextGeneration,
      sessionId: this.snapshot.selectedSessionId,
      runId,
    };
  }

  private isCurrentApprovalContext(context: ApprovalContext): boolean {
    return (
      this.approvalContextGeneration === context.generation &&
      this.snapshot.selectedSessionId === context.sessionId &&
      this.snapshot.activeRun?.id === context.runId
    );
  }

  private publishApprovalState(
    requests: readonly ApprovalView[],
    submitting: readonly ApprovalRequestId[],
  ): void {
    const nextRequests = Object.freeze(
      [...requests]
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        )
        .map(freezeApprovalView),
    );
    const nextSubmitting = Object.freeze([...new Set(submitting)]);
    this.publish({
      approvalState: Object.freeze({ requests: nextRequests, submitting: nextSubmitting }),
      controlMode:
        this.snapshot.controlMode === "CANCELLING"
          ? "CANCELLING"
          : nextRequests.length > 0
            ? "APPROVAL"
            : "NONE",
    });
  }

  private restoreControlMode(): void {
    this.publish({ controlMode: this.controlModeForApprovals() });
  }

  private controlModeForApprovals(): WebControlMode {
    return (this.snapshot.approvalState?.requests.length ?? 0) > 0 ? "APPROVAL" : "NONE";
  }

  private cancelActiveLifecycle(): void {
    this.invalidateContextUsageRefresh();
    const active = this.activeLifecycle;
    if (active !== undefined) {
      active.presentationRefreshPending = false;
      active.scheduler.dispose();
      active.controller.abort();
    }
    this.activeLifecycle = undefined;
  }

  private invalidateContextUsageRefresh(): void {
    this.contextUsageRefreshGeneration += 1;
    this.contextUsageRefreshTimer?.cancel();
    this.contextUsageRefreshTimer = undefined;
    this.contextUsageRefreshRunId = undefined;
  }

  private currentContextUsageRunId(): RunId | undefined {
    return selectContextUsageRun(this.snapshot.runs, this.snapshot.activeRuns)?.id;
  }

  private hasActiveRun(): boolean {
    return this.snapshot.activeRuns.length > 0;
  }

  private upsertCandidate(
    session: ClientAgentSession,
    latestRun?: ClientAgentRun,
  ): readonly SessionCandidate[] {
    const candidate: SessionCandidate = {
      session,
      ...(latestRun === undefined ? {} : { latestRun }),
      lastActivityAt: deriveSessionActivity(session, latestRun),
    };
    return sortSessionCandidates([
      ...this.snapshot.candidates.filter((item) => item.session.id !== session.id),
      candidate,
    ]);
  }

  private publish(patch: WebSessionSnapshotPatch, mode: "IMMEDIATE" | "FRAME" = "IMMEDIATE"): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch } as WebSessionSnapshot;
    if (mode === "FRAME") {
      this.scheduleFramePublication();
      return;
    }
    this.cancelPendingPublicationFrame();
    this.notifyListeners();
  }

  private scheduleFramePublication(): void {
    if (this.pendingPublicationFrame !== undefined) return;
    const token = {};
    const handle = this.frameScheduler.schedule(() => {
      if (this.disposed || this.pendingPublicationFrame?.token !== token) return;
      this.pendingPublicationFrame = undefined;
      this.notifyListeners();
    });
    this.pendingPublicationFrame = { token, handle };
  }

  private cancelPendingPublicationFrame(): void {
    const pending = this.pendingPublicationFrame;
    if (pending === undefined) return;
    this.pendingPublicationFrame = undefined;
    this.frameScheduler.cancel(pending.handle);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function shouldPublishEventOnFrame(event: PublicRunEvent): boolean {
  if (event.durability.kind === "DURABLE" || event.visibility !== "USER_VISIBLE") return false;
  switch (event.type) {
    case "model.text.delta":
    case "model.reasoning_summary.delta":
    case "model.tool_call.started":
    case "model.status":
    case "tool.output":
    case "shell.output":
    case "process.output":
      return true;
    default:
      return false;
  }
}

function initialSnapshot(): WebSessionSnapshot {
  return {
    status: "IDLE",
    candidates: [],
    runs: [],
    history: [],
    turnPresentation: undefined,
    activeRuns: [],
    timeline: createInitialTimelineState(),
    liveActivity: createInitialLiveActivityState(),
    contextUsage: null,
    continuityWarning: false,
    availablePresets: [],
    isDraft: false,
    composerEnabled: false,
    submission: "IDLE",
    transportState: "CONNECTED",
    controlMode: "NONE",
  };
}

function optimisticPresentationUser(run: ClientAgentRun, text: string): OptimisticPresentationUser {
  return {
    id: `optimistic:presentation:user:${run.id}`,
    runId: run.id,
    status: "COMPLETED",
    createdAt: run.createdAt,
    kind: "USER",
    text,
  };
}

function reconcileTurnPresentation(
  response: SessionTurnPresentationResponse,
  optimistic: readonly OptimisticPresentationUser[],
): SessionTurnPresentationResponse {
  if (optimistic.length === 0) return response;
  if (response.capabilityVersion === 3) {
    let changed = false;
    const turns = response.turns.map((turn) => {
      const additions = optimistic.filter(
        (candidate) =>
          candidate.runId === turn.runId && !turn.items.some((item) => item.kind === "USER"),
      );
      if (additions.length === 0) return turn;
      changed = true;
      const items: TurnPresentationItemV3[] = [
        ...additions.map((item) => ({
          ...item,
          conversationTurnId: turn.conversationTurnId,
          ordinal: 0,
        })),
        ...turn.items,
      ];
      return {
        ...turn,
        items: items.map((item, ordinal) => ({ ...item, ordinal })),
      };
    });
    return changed ? { ...response, turns } : response;
  }
  const canonical = response.items;
  const additions = optimistic.filter(
    (candidate) =>
      !canonical.some((item) => item.kind === candidate.kind && item.runId === candidate.runId),
  );
  if (additions.length === 0) return response;
  const legacyAdditions: TurnPresentationItem[] = additions.map((item) => ({
    ...item,
    conversationTurnId: item.runId,
    ordinal: 0,
  }));
  const items = [...canonical, ...legacyAdditions]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((item, ordinal) => ({ ...item, ordinal }));
  return { ...response, items };
}

function prunePresentationForRun(
  state: LiveActivityState,
  presentation: SessionTurnPresentationResponse,
  runId: RunId,
): LiveActivityState {
  const highWatermark =
    presentation.capabilityVersion === 3
      ? presentation.turns.find((turn) => turn.runId === runId)?.highWatermark
      : presentation.highWatermark;
  return highWatermark === undefined ? state : pruneProjectedLiveActivities(state, highWatermark);
}

function nextPageCursor(
  nextCursor: string | undefined,
  seenCursors: Set<string>,
): string | undefined {
  if (nextCursor === undefined) return undefined;
  if (seenCursors.has(nextCursor)) throw new CaelushProtocolCompatibilityError();
  seenCursors.add(nextCursor);
  return nextCursor;
}

const systemWebTimer: Timer = {
  schedule(delayMs, callback) {
    const timeout = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timeout) };
  },
};

const CONTEXT_USAGE_REFRESH_DELAY_MS = 750;
const TERMINAL_CONTEXT_USAGE_RETRY_DELAY_MS = 250;

function isTerminalStreamError(error: unknown): boolean {
  return (
    error instanceof CaelushClientHttpError ||
    error instanceof CaelushClientProtocolError ||
    error instanceof CaelushProtocolCompatibilityError
  );
}

function isTimelineTerminalRunStatus(
  status: RunStatus,
): status is Parameters<typeof flushTimelineForTerminal>[1] {
  return isTerminalRunStatus(status);
}

function isLifecycleEvent(event: PublicRunEvent): boolean {
  return (
    event.type === "run.started" ||
    event.type === "status.changed" ||
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.timed_out" ||
    event.type === "budget.exceeded"
  );
}

function isContextUsageRefreshEvent(event: PublicRunEvent): boolean {
  return (
    event.type === "status.changed" ||
    event.type === "llm.started" ||
    event.type === "llm.completed" ||
    event.type === "llm.failed" ||
    event.type === "tool.completed" ||
    event.type === "tool.failed" ||
    event.type === "verification.started" ||
    event.type === "verification.completed" ||
    event.type === "verification.finalized" ||
    event.type === "verification.check.completed" ||
    event.type === "verification.repair.started" ||
    event.type === "verification.repair.limit_reached"
  );
}

function latestRun(runs: readonly ClientAgentRun[]): ClientAgentRun | undefined {
  return [...runs].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  })[0];
}

function selectContextUsageRun(
  runs: readonly ClientAgentRun[],
  activeRuns: readonly ClientAgentRun[],
): ClientAgentRun | undefined {
  if (activeRuns.length > 1) return undefined;
  return activeRuns[0] ?? latestRun(runs);
}

function upsertConfirmedTerminalRun(
  runs: readonly ClientAgentRun[],
  confirmedRun: ClientAgentRun,
): ClientAgentRun[] {
  let replaced = false;
  const reconciled = runs.flatMap((run) => {
    if (run.id !== confirmedRun.id) return [run];
    if (replaced) return [];
    replaced = true;
    return [confirmedRun];
  });
  return replaced ? reconciled : [...reconciled, confirmedRun];
}

function freezeApprovalView(view: ApprovalView): ApprovalView {
  return Object.freeze({
    ...view,
    requiredCapabilities: Object.freeze([...view.requiredCapabilities]),
    options: Object.freeze(view.options.map((option) => Object.freeze({ ...option }))),
  });
}

function promptError(error: PromptError): WebSessionError {
  return { code: error.code, message: error.message };
}

function sessionError(code: WebSessionErrorCode): WebSessionError {
  const messages: Record<WebSessionErrorCode, string> = {
    SESSION_LOAD_FAILED: "无法加载当前工作区的会话。",
    SESSION_SELECTION_FAILED: "无法安全打开这个会话。",
    MULTIPLE_ACTIVE_RUNS: "该会话存在多个未完成运行，暂时无法安全继续。",
    SESSION_CREATE_FAILED: "无法创建会话。",
    RUN_CREATE_FAILED: "无法创建任务。",
    RUN_START_FAILED: "无法启动任务。",
    RUN_CANCEL_FAILED: "无法确认取消请求。任务可能仍在后台运行。",
    RUN_STREAM_FAILED: "任务执行连接中断。",
    RUN_RECONNECT_EXHAUSTED: "任务执行连接已断开。请手动重新连接。",
    RUN_REFRESH_FAILED: "无法刷新任务状态。",
    DEFAULT_MODEL_UNAVAILABLE: "当前 daemon 未配置默认模型，无法开始任务。",
    PERMISSION_CAPABILITIES_FAILED: "无法确认当前主机的权限能力，已阻止创建任务。",
    PERMISSION_PRESET_UNAVAILABLE: "所选权限当前不可用，已阻止创建任务。",
    PERMISSION_PREPARATION_FAILED: "工作区准备失败，已阻止创建任务。",
    PROMPT_REQUIRED: "请输入任务内容。",
    PROMPT_TOO_LARGE: "任务内容不能超过 32 KiB。",
    CONVERSATION_CONTINUITY_INCOMPATIBLE:
      "旧会话缺少当前模型安全续接所需的历史记录。请在当前工作区新建会话，再自行提交任务。",
  };
  return { code, message: messages[code] };
}

function permissionPreparationError(reasonCode?: string): WebSessionError {
  const boundedReasonCode =
    reasonCode !== undefined && /^[A-Z0-9_]{1,96}$/.test(reasonCode) ? reasonCode : undefined;
  if (boundedReasonCode === undefined) return sessionError("PERMISSION_PREPARATION_FAILED");
  const reason = permissionPresetUnavailableReason(boundedReasonCode);
  return {
    code: "PERMISSION_PREPARATION_FAILED",
    reasonCode: boundedReasonCode,
    message: `工作区准备失败：${reason}。`,
  };
}
