import type { WatchRunEventsOptions } from "@caelush/client";
import {
  deriveSessionActivity,
  hydrateSessionTranscript,
  listMatchingSessionCandidates,
  nonTerminalRuns,
  resolveSessionWorkspace,
  sortSessionCandidates,
  type SessionCandidate,
  type SessionCandidateClient,
  type SessionHistoryEntry,
} from "@caelush/client";
import type {
  AgentEvent,
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
} from "@caelush/protocol";
import { derivePromptTitle, validatePrompt, type PromptError } from "./prompt.js";
import type { WebHostClient } from "../host/bootstrap.js";

export interface WebSessionClient extends SessionCandidateClient, WebHostClient {
  createSession(input: CreateSessionRequest): Promise<ClientAgentSession>;
  createRun(sessionId: SessionId, input: CreateRunRequest): Promise<ClientAgentRun>;
  getRun(runId: RunId): Promise<ClientAgentRun>;
  startRun(runId: RunId): Promise<RunActionResponse>;
  watchRunEvents(runId: RunId, options?: WatchRunEventsOptions): AsyncIterable<AgentEvent>;
}

export type WebSessionLoadState = "IDLE" | "LOADING" | "READY" | "ERROR";
export type WebSubmissionState = "IDLE" | "SUBMITTING" | "RUN_CREATED" | "STARTING" | "ACTIVE";

export type WebSessionErrorCode =
  | "SESSION_LOAD_FAILED"
  | "SESSION_SELECTION_FAILED"
  | "MULTIPLE_ACTIVE_RUNS"
  | "SESSION_CREATE_FAILED"
  | "RUN_CREATE_FAILED"
  | "RUN_START_FAILED"
  | "RUN_STREAM_FAILED"
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
  readonly isDraft: boolean;
  readonly composerEnabled: boolean;
  readonly submission: WebSubmissionState;
  readonly error?: WebSessionError;
}

export type WebSessionListener = (snapshot: WebSessionSnapshot) => void;
type WebSessionSnapshotPatch = Partial<
  Omit<WebSessionSnapshot, "selectedSession" | "selectedSessionId" | "activeRun" | "error">
> & {
  readonly selectedSession?: ClientAgentSession | undefined;
  readonly selectedSessionId?: SessionId | undefined;
  readonly activeRun?: ClientAgentRun | undefined;
  readonly error?: WebSessionError | undefined;
};

interface ActiveLifecycle {
  readonly run: ClientAgentRun;
  readonly controller: AbortController;
  failure?: "RUN_STREAM_FAILED" | "RUN_REFRESH_FAILED";
}

export class WebSessionManager {
  private readonly listeners = new Set<WebSessionListener>();
  private snapshot: WebSessionSnapshot = initialSnapshot();
  private activeLifecycle: ActiveLifecycle | undefined;
  private disposed = false;

  constructor(
    private readonly options: {
      readonly client: WebSessionClient;
      readonly workspace: WorkspaceRef;
      readonly info: DaemonInfo;
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
      const selectedId = this.snapshot.selectedSessionId;
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
    this.publish({
      status: "READY",
      selectedSession: undefined,
      selectedSessionId: undefined,
      runs: [],
      history: [],
      activeRuns: [],
      activeRun: undefined,
      isDraft: true,
      composerEnabled: true,
      submission: "IDLE",
      error: undefined,
    });
  }

  async selectSession(sessionId: SessionId): Promise<boolean> {
    if (this.disposed || this.hasActiveRun() || this.snapshot.submission !== "IDLE") return false;
    const candidate = this.snapshot.candidates.find((item) => item.session.id === sessionId);
    if (candidate === undefined) return false;

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
          isDraft: false,
          composerEnabled: false,
          error: sessionError("SESSION_SELECTION_FAILED"),
        });
        return false;
      }
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
      const response = await this.options.client.startRun(run.id);
      if (this.activeLifecycle !== active) return false;
      this.publishActiveRun(response.run, "ACTIVE");
      return true;
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
      isDraft: false,
      composerEnabled: activeRuns.length === 0,
      submission: "IDLE",
      error: activeRuns.length > 1 ? sessionError("MULTIPLE_ACTIVE_RUNS") : undefined,
    });
    return true;
  }

  private attachLifecycle(run: ClientAgentRun): ActiveLifecycle {
    const active: ActiveLifecycle = {
      run,
      controller: new AbortController(),
    };
    this.activeLifecycle = active;
    void this.consumeLifecycle(active);
    return active;
  }

  private async consumeLifecycle(active: ActiveLifecycle): Promise<void> {
    try {
      for await (const event of this.options.client.watchRunEvents(active.run.id, {
        signal: active.controller.signal,
      })) {
        if (this.activeLifecycle !== active || this.disposed) return;
        if (!isLifecycleEvent(event)) continue;
        let refreshed: ClientAgentRun;
        try {
          refreshed = await this.options.client.getRun(active.run.id);
        } catch {
          active.failure = "RUN_REFRESH_FAILED";
          this.publish({ error: sessionError("RUN_REFRESH_FAILED") });
          return;
        }
        if (this.activeLifecycle !== active || this.disposed) return;
        this.publishActiveRun(refreshed, "ACTIVE");
        if (isTerminalRunStatus(refreshed.status)) {
          await this.settleLifecycle(active, refreshed);
          return;
        }
      }
      active.failure = "RUN_STREAM_FAILED";
      if (this.activeLifecycle === active && !this.disposed) {
        this.publish({ error: sessionError("RUN_STREAM_FAILED") });
      }
    } catch {
      active.failure = "RUN_STREAM_FAILED";
      if (this.activeLifecycle === active && !this.disposed) {
        this.publish({ error: sessionError("RUN_STREAM_FAILED") });
      }
    }
  }

  private async settleLifecycle(active: ActiveLifecycle, run: ClientAgentRun): Promise<void> {
    try {
      const runs = (await this.options.client.listRuns(run.sessionId, { limit: 100 })).items;
      if (this.activeLifecycle !== active || this.disposed) return;
      this.cancelActiveLifecycle();
      const activeRuns = nonTerminalRuns(runs);
      this.publish({
        candidates: this.snapshot.selectedSession
          ? this.upsertCandidate(this.snapshot.selectedSession, latestRun(runs))
          : this.snapshot.candidates,
        status: "READY",
        runs,
        history: hydrateSessionTranscript(runs),
        activeRuns,
        activeRun: activeRuns.length === 1 ? activeRuns[0] : undefined,
        composerEnabled: activeRuns.length === 0,
        submission: "IDLE",
        error: activeRuns.length > 1 ? sessionError("MULTIPLE_ACTIVE_RUNS") : undefined,
      });
    } catch {
      if (this.activeLifecycle !== active || this.disposed) return;
      this.publish({ error: sessionError("RUN_REFRESH_FAILED") });
    }
  }

  private publishActiveRun(run: ClientAgentRun, submission: WebSubmissionState): void {
    const activeRuns = this.snapshot.activeRuns.map((item) => (item.id === run.id ? run : item));
    const lifecycle = this.activeLifecycle;
    this.publish({
      candidates: this.snapshot.selectedSession
        ? this.upsertCandidate(this.snapshot.selectedSession, run)
        : this.snapshot.candidates,
      activeRuns: activeRuns.length === 0 ? [run] : activeRuns,
      activeRun: run,
      runs: this.snapshot.runs.map((item) => (item.id === run.id ? run : item)),
      submission,
      composerEnabled: false,
      error:
        lifecycle?.run.id === run.id && lifecycle.failure !== undefined
          ? sessionError(lifecycle.failure)
          : undefined,
    });
  }

  private cancelActiveLifecycle(): void {
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
    isDraft: false,
    composerEnabled: false,
    submission: "IDLE",
  };
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

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "TIMEOUT" ||
    status === "MAX_STEPS_REACHED" ||
    status === "BUDGET_EXCEEDED"
  );
}

function latestRun(runs: readonly ClientAgentRun[]): ClientAgentRun | undefined {
  return [...runs].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  })[0];
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
    RUN_STREAM_FAILED: "任务执行连接中断。",
    RUN_REFRESH_FAILED: "无法刷新任务状态。",
    DEFAULT_MODEL_UNAVAILABLE: "当前 daemon 未配置默认模型，无法开始任务。",
    PROMPT_REQUIRED: "请输入任务内容。",
    PROMPT_TOO_LARGE: "任务内容不能超过 32 KiB。",
  };
  return { code, message: messages[code] };
}
