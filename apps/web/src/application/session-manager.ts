import {
  createApprovalView,
  CaelushClientHttpError,
  CaelushClientProtocolError,
  CaelushProtocolCompatibilityError,
  canCancelRunStatus,
  createInitialTimelineState,
  deriveSessionActivity,
  flushTimelineForTerminal,
  hydrateSessionTranscript,
  isTerminalRunStatus,
  listMatchingSessionCandidates,
  nonTerminalRuns,
  reduceTimelineEvent,
  ReconnectScheduler,
  resolveSessionWorkspace,
  sortSessionCandidates,
  type SessionCandidate,
  type ApprovalView,
  type SessionCandidateClient,
  type SessionHistoryEntry,
  type TimelineState,
  type Timer,
  type WatchRunEventsOptions,
} from "@caelush/client";
import type {
  AgentEvent,
  ApprovalRequestId,
  ApprovalResolution,
  ClientAgentRun,
  ClientAgentSession,
  CreateRunRequest,
  CreateSessionRequest,
  DaemonInfo,
  RunActionResponse,
  RunId,
  RunStatus,
  SessionId,
  WorkspaceRef,
  ContextUsageProjection,
} from "@caelush/protocol";
import { derivePromptTitle, validatePrompt, type PromptError } from "./prompt.js";
import type { WebHostClient } from "../host/bootstrap.js";
import { SessionSelectionStore } from "./session-persistence.js";

export interface WebSessionClient extends SessionCandidateClient, WebHostClient {
  createSession(input: CreateSessionRequest): Promise<ClientAgentSession>;
  createRun(sessionId: SessionId, input: CreateRunRequest): Promise<ClientAgentRun>;
  getRun(runId: RunId): Promise<ClientAgentRun>;
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
  watchRunEvents(runId: RunId, options?: WatchRunEventsOptions): AsyncIterable<AgentEvent>;
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
  | "PROMPT_REQUIRED"
  | "PROMPT_TOO_LARGE";

export interface WebSessionError {
  readonly code: WebSessionErrorCode;
  readonly message: string;
}

export interface WebSessionSnapshot {
  readonly status: WebSessionLoadState;
  readonly candidates: readonly SessionCandidate[];
  readonly selectedSession?: ClientAgentSession;
  readonly selectedSessionId?: SessionId;
  readonly runs: readonly ClientAgentRun[];
  readonly history: readonly SessionHistoryEntry[];
  readonly activeRuns: readonly ClientAgentRun[];
  readonly activeRun?: ClientAgentRun;
  readonly timeline: TimelineState;
  readonly contextUsage?: ContextUsageProjection | null;
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
    | "transportAttempt"
  >
> & {
  readonly selectedSession?: ClientAgentSession | undefined;
  readonly selectedSessionId?: SessionId | undefined;
  readonly activeRun?: ClientAgentRun | undefined;
  readonly approvalState?: WebApprovalState | undefined;
  readonly error?: WebSessionError | undefined;
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
  readonly scheduler: ReconnectScheduler;
  failure?: "RUN_STREAM_FAILED" | "RUN_REFRESH_FAILED";
}

interface ApprovalContext {
  readonly generation: number;
  readonly sessionId: SessionId | undefined;
  readonly runId: RunId;
}

export class WebSessionManager {
  private readonly listeners = new Set<WebSessionListener>();
  private snapshot: WebSessionSnapshot = initialSnapshot();
  private activeLifecycle: ActiveLifecycle | undefined;
  private readonly resolvingApprovals = new Set<ApprovalRequestId>();
  private approvalContextGeneration = 0;
  private cancelPromise: Promise<boolean> | undefined;
  private disposed = false;

  constructor(
    private readonly options: {
      readonly client: WebSessionClient;
      readonly workspace: WorkspaceRef;
      readonly info: DaemonInfo;
      readonly timer?: Timer;
      readonly selectionStore?: SessionSelectionStore;
    },
  ) {}

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
      const candidates = await listMatchingSessionCandidates(
        this.options.client,
        this.options.workspace.path,
      );
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
    if (this.disposed || this.hasActiveRun() || this.snapshot.submission !== "IDLE") return;
    this.cancelActiveLifecycle();
    this.clearApprovals();
    this.publish({
      status: "READY",
      selectedSession: undefined,
      selectedSessionId: undefined,
      runs: [],
      history: [],
      activeRuns: [],
      activeRun: undefined,
      timeline: createInitialTimelineState(),
      isDraft: true,
      composerEnabled: true,
      submission: "IDLE",
      approvalState: undefined,
      controlMode: "NONE",
      error: undefined,
    });
  }

  async selectSession(sessionId: SessionId): Promise<boolean> {
    if (this.disposed || this.hasActiveRun() || this.snapshot.submission !== "IDLE") return false;
    const candidate = this.snapshot.candidates.find((item) => item.session.id === sessionId);
    if (candidate === undefined) return false;

    this.clearApprovals();
    this.publish({ status: "LOADING", error: undefined });
    try {
      const runs = (await this.options.client.listRuns(sessionId, { limit: 100 })).items;
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
          history: hydrateSessionTranscript(runs),
          activeRuns: [],
          activeRun: undefined,
          timeline: createInitialTimelineState(),
          contextUsage: null,
          isDraft: false,
          composerEnabled: false,
          error: sessionError("SESSION_SELECTION_FAILED"),
        });
        return false;
      }
      this.options.selectionStore?.write(this.options.workspace.id, sessionId);
      return this.applySelectedSession(candidate.session, runs);
    } catch {
      this.publish({
        status: "ERROR",
        selectedSession: candidate.session,
        selectedSessionId: candidate.session.id,
        runs: [],
        history: [],
        activeRuns: [],
        activeRun: undefined,
        timeline: createInitialTimelineState(),
        contextUsage: null,
        isDraft: false,
        composerEnabled: false,
        error: sessionError("SESSION_SELECTION_FAILED"),
      });
      return false;
    }
  }

  async submitPrompt(prompt: string): Promise<boolean> {
    if (this.disposed || this.hasActiveRun() || this.snapshot.submission !== "IDLE") return false;
    const validation = validatePrompt(prompt);
    if (!validation.ok) {
      this.publish({ error: promptError(validation.error) });
      return false;
    }

    const model = this.snapshot.selectedSession?.defaultModel ?? this.options.info.defaultModel;
    if (model === undefined) {
      this.publish({ error: sessionError("DEFAULT_MODEL_UNAVAILABLE") });
      return false;
    }

    const goal = validation.value;
    this.publish({ submission: "SUBMITTING", error: undefined });
    let session = this.snapshot.selectedSession;
    try {
      if (session === undefined) {
        session = await this.options.client.createSession({
          title: derivePromptTitle(goal),
          defaultWorkspace: this.options.workspace,
          defaultModel: model,
          metadata: {},
        });
        this.publish({
          candidates: this.upsertCandidate(session),
          selectedSession: session,
          selectedSessionId: session.id,
          isDraft: false,
          error: undefined,
        });
      }

      const run = await this.options.client.createRun(session.id, {
        goal,
        workspace: this.options.workspace,
        model,
        ...this.options.info.defaultRunConfiguration,
      });
      const runs = [...this.snapshot.runs, run];
      this.publish({
        candidates: this.upsertCandidate(session, run),
        status: "READY",
        runs,
        history: hydrateSessionTranscript(runs, run.id),
        activeRuns: [run],
        activeRun: run,
        timeline: createInitialTimelineState(run.id),
        contextUsage: null,
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

  async continueResourceGuard(): Promise<boolean> {
    const run = this.snapshot.activeRun;
    if (this.disposed || run === undefined || run.status !== "WAITING_RESOURCE") return false;
    try {
      const response = await this.options.client.continueResourceGuard(run.id);
      this.publishActiveRun(response.run, "ACTIVE");
      return true;
    } catch {
      this.publish({ controlMode: "RESOURCE_GUARD", error: sessionError("RUN_REFRESH_FAILED") });
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
    this.cancelActiveLifecycle();
    this.listeners.clear();
  }

  private async applySelectedSession(
    session: ClientAgentSession,
    runs: readonly ClientAgentRun[],
  ): Promise<boolean> {
    const activeRuns = nonTerminalRuns(runs);
    this.clearApprovals();
    this.publish({
      status: "READY",
      selectedSession: session,
      selectedSessionId: session.id,
      runs,
      history: hydrateSessionTranscript(
        runs,
        activeRuns.length === 1 ? activeRuns[0]?.id : undefined,
      ),
      activeRuns,
      activeRun: activeRuns.length === 1 ? activeRuns[0] : undefined,
      timeline: createInitialTimelineState(activeRuns.length === 1 ? activeRuns[0]?.id : undefined),
      contextUsage: null,
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
    if (activeRuns.length > 1) this.publish({ controlMode: "RECOVERY_PICKER" });
    if (activeRuns.length === 1 && activeRuns[0] !== undefined) {
      await this.prepareRecoveryRun(activeRuns[0]);
      await this.refreshContextUsage(activeRuns[0].id);
    }
    return true;
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
        const timeline = reduceTimelineEvent(this.snapshot.timeline, event);
        this.publish({ timeline });
        if (timeline.error !== undefined) {
          this.handleTerminalStreamError(active, generation);
          return;
        }
        this.projectApprovalEvent(event);
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
      this.clearApprovals();
      const activeRuns = nonTerminalRuns(runs);
      const activeRun = activeRuns.length === 1 ? activeRuns[0] : undefined;
      this.publish({
        candidates: this.snapshot.selectedSession
          ? this.upsertCandidate(this.snapshot.selectedSession, latestRun(runs))
          : this.snapshot.candidates,
        status: "READY",
        runs,
        history: hydrateSessionTranscript(runs),
        activeRuns,
        activeRun,
        timeline:
          activeRun !== undefined && activeRun.id !== run.id
            ? createInitialTimelineState(activeRun.id)
            : activeRuns.length > 1
              ? createInitialTimelineState()
              : this.snapshot.timeline,
        composerEnabled: activeRuns.length === 0,
        submission: "IDLE",
        approvalState: undefined,
        controlMode: "NONE",
        error: activeRuns.length > 1 ? sessionError("MULTIPLE_ACTIVE_RUNS") : undefined,
      });
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
    void this.refreshContextUsage(run.id);
  }

  private async refreshContextUsage(runId: RunId): Promise<void> {
    const getContextUsage = this.options.client.getRunContextUsage;
    if (getContextUsage === undefined || this.disposed) return;
    try {
      const usage = await getContextUsage.call(this.options.client, runId);
      if (this.disposed || this.snapshot.activeRun?.id !== runId) return;
      this.publish({ contextUsage: usage ?? null });
    } catch {
      // Context diagnostics are optional UI and never change Run control state.
    }
  }

  private projectApprovalEvent(event: AgentEvent): void {
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
    if (this.activeLifecycle?.run.id === run.id) this.cancelActiveLifecycle();
    const activeRuns = nonTerminalRuns(runs);
    const activeRun = activeRuns.length === 1 ? activeRuns[0] : undefined;
    this.clearApprovals();
    this.publish({
      candidates: this.snapshot.selectedSession
        ? this.upsertCandidate(this.snapshot.selectedSession, latestRun(runs))
        : this.snapshot.candidates,
      runs,
      history: hydrateSessionTranscript(runs),
      activeRuns,
      activeRun,
      timeline:
        activeRun !== undefined && activeRun.id !== run.id
          ? createInitialTimelineState(activeRun.id)
          : activeRuns.length > 1
            ? createInitialTimelineState()
            : this.snapshot.timeline,
      composerEnabled: activeRuns.length === 0,
      submission: "IDLE",
      approvalState: undefined,
      controlMode: "NONE",
      error: activeRuns.length > 1 ? sessionError("MULTIPLE_ACTIVE_RUNS") : undefined,
    });
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
    this.activeLifecycle?.scheduler.dispose();
    this.activeLifecycle?.controller.abort();
    this.activeLifecycle = undefined;
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

  private publish(patch: WebSessionSnapshotPatch): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch } as WebSessionSnapshot;
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function initialSnapshot(): WebSessionSnapshot {
  return {
    status: "IDLE",
    candidates: [],
    runs: [],
    history: [],
    activeRuns: [],
    timeline: createInitialTimelineState(),
    contextUsage: null,
    isDraft: false,
    composerEnabled: false,
    submission: "IDLE",
    transportState: "CONNECTED",
    controlMode: "NONE",
  };
}

const systemWebTimer: Timer = {
  schedule(delayMs, callback) {
    const timeout = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timeout) };
  },
};

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

function isLifecycleEvent(event: AgentEvent): boolean {
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

function latestRun(runs: readonly ClientAgentRun[]): ClientAgentRun | undefined {
  return [...runs].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  })[0];
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
    PROMPT_REQUIRED: "请输入任务内容。",
    PROMPT_TOO_LARGE: "任务内容不能超过 32 KiB。",
  };
  return { code, message: messages[code] };
}
