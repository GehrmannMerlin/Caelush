import { basename, resolve } from "node:path";
import type {
  AgentEvent,
  ApprovalListResponse,
  ApprovalRequestId,
  ApprovalResolutionRequest,
  ClientAgentRun,
  ClientAgentSession,
  CreateRunRequest,
  CreateSessionRequest,
  DaemonInfo,
  HealthResponse,
  RunListQuery,
  RunListResponse,
  RunActionResponse,
  RunId,
  SessionListQuery,
  SessionListResponse,
  SessionId,
  WorkspaceRef,
} from "@caelush/protocol";
import { createWorkspaceId, VerifiedRunFinalResultSchema } from "@caelush/protocol";
import type { WatchRunEventsOptions } from "@caelush/client";
import type { LaunchIntent } from "../bootstrap/cli-args.js";
import { projectAgentEvent } from "./event-projector.js";
import {
  createInitialCliState,
  type CliActivity,
  type CliStateListener,
  type CliViewState,
} from "./cli-state.js";
import { toSafeCliError } from "../bootstrap/safe-errors.js";
import { createInitialCliTimelineState } from "./timeline-model.js";
import {
  hydrateSessionTranscript,
  listMatchingSessionCandidates,
  nonTerminalRuns,
  resolveSessionWorkspace,
} from "./session-resume.js";
import { runStatusLabel } from "./timeline-model.js";

export const MAX_CLI_PROMPT_BYTES = 32 * 1024;

export interface CliDaemonClient {
  getHealth(options?: { readonly signal?: AbortSignal }): Promise<HealthResponse>;
  getInfo(options?: { readonly signal?: AbortSignal }): Promise<DaemonInfo>;
  createSession(
    input: CreateSessionRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ClientAgentSession>;
  createRun(
    sessionId: SessionId,
    input: CreateRunRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ClientAgentRun>;
  watchRunEvents(runId: RunId, options?: WatchRunEventsOptions): AsyncIterable<AgentEvent>;
  startRun(runId: RunId, options?: { readonly signal?: AbortSignal }): Promise<RunActionResponse>;
  getRun(runId: RunId, options?: { readonly signal?: AbortSignal }): Promise<ClientAgentRun>;
  listSessions(
    query?: Partial<SessionListQuery>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SessionListResponse>;
  getSession(
    sessionId: SessionId,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ClientAgentSession>;
  listRuns(
    sessionId: SessionId,
    query?: Partial<RunListQuery>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RunListResponse>;
  recoverRun(runId: RunId, options?: { readonly signal?: AbortSignal }): Promise<RunActionResponse>;
  cancelRun(runId: RunId, options?: { readonly signal?: AbortSignal }): Promise<RunActionResponse>;
  listPendingApprovals(
    runId: RunId,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ApprovalListResponse>;
  resolveApproval(
    runId: RunId,
    approvalId: ApprovalRequestId,
    resolution: ApprovalResolutionRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RunActionResponse>;
}

export interface CliConversationControllerOptions {
  readonly client: CliDaemonClient;
  readonly workspacePath: string;
  readonly launchIntent?: LaunchIntent;
}

interface ActiveRun {
  readonly runId: RunId;
  readonly streamAbortController: AbortController;
  terminalSettlement?: Promise<void>;
}

export class CliConversationController {
  private readonly currentWorkspacePath: string;
  private workspace: WorkspaceRef | undefined;
  private readonly listeners = new Set<CliStateListener>();
  private state: CliViewState = createInitialCliState();
  private bootstrapPromise: Promise<void> | undefined;
  private activeRun: ActiveRun | undefined;
  private submissionInFlight = false;
  private historySequence = 0;
  private disposed = false;

  constructor(private readonly options: CliConversationControllerOptions) {
    this.currentWorkspacePath = resolve(options.workspacePath);
  }

  getState(): CliViewState {
    return this.state;
  }

  subscribe(listener: CliStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bootstrap(): Promise<void> {
    this.bootstrapPromise ??= this.bootstrapOnce();
    return this.bootstrapPromise;
  }

  async submitPrompt(prompt: string): Promise<boolean> {
    const goal = prompt.trim();
    if (!this.canSubmit(goal)) return false;

    const session = this.state.session!;
    const info = this.state.daemonInfo!;
    const workspace = this.workspace;
    if (workspace === undefined) return false;
    const optimisticId = this.nextTranscriptId("user");
    this.submissionInFlight = true;
    this.publish({
      ...this.state,
      displayHistory: [
        ...this.state.displayHistory,
        { id: optimisticId, kind: "USER", text: goal },
      ],
      composerEnabled: false,
      activity: "Preparing",
    });

    let run: ClientAgentRun;
    try {
      run = await this.options.client.createRun(session.id, {
        goal,
        workspace,
        model: session.defaultModel ?? info.defaultModel!,
        ...info.defaultRunConfiguration,
      });
    } catch (error) {
      this.submissionInFlight = false;
      this.removeOptimisticEntry(optimisticId, toSafeCliError(error));
      return false;
    }

    this.submissionInFlight = false;
    this.publish({
      ...this.state,
      displayHistory: this.state.displayHistory.map((entry) =>
        entry.id === optimisticId ? { ...entry, runId: run.id } : entry,
      ),
      timeline: createInitialCliTimelineState(run.id),
      activeRun: { runId: run.id, status: run.status },
      composerEnabled: false,
      activity: "Preparing",
    });

    const active: ActiveRun = {
      runId: run.id,
      streamAbortController: new AbortController(),
    };
    this.activeRun = active;
    try {
      const stream = this.options.client.watchRunEvents(run.id, {
        afterSequence: this.state.timeline.lastDurableSequence,
        signal: active.streamAbortController.signal,
      });
      void this.consumeRunEvents(active, stream);
      await Promise.resolve();
      await this.options.client.startRun(run.id);
    } catch (error) {
      if (this.activeRun === active && !active.streamAbortController.signal.aborted) {
        this.publish({
          ...this.state,
          activity: "Transport error",
          fatalError: toSafeCliError(error),
        });
      }
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeRun?.streamAbortController.abort();
    this.listeners.clear();
  }

  private async bootstrapOnce(): Promise<void> {
    if (this.disposed) return;
    try {
      this.publish({ ...this.state, bootstrap: "CONNECTING", activity: "Connecting" });
      await this.options.client.getHealth();
      this.publish({
        ...this.state,
        bootstrap: "CHECKING_COMPATIBILITY",
        activity: "Checking compatibility",
      });
      const info = await this.options.client.getInfo();
      if (info.defaultModel === undefined || info.defaultRunConfiguration === undefined) {
        throw new CliConfigurationError();
      }
      this.publish({
        ...this.state,
        bootstrap: "CREATING_SESSION",
        activity: "Creating session",
        daemonInfo: info,
      });
      await this.bootstrapLaunch(info);
    } catch (error) {
      this.publishFatal(error);
    }
  }

  async selectSession(index: number): Promise<boolean> {
    if (this.state.controlMode !== "SESSION_PICKER") return false;
    const candidate = this.state.sessionCandidates[index];
    if (candidate === undefined || this.state.daemonInfo === undefined) return false;
    try {
      await this.enterSession(candidate.session);
      return true;
    } catch (error) {
      this.publishFatal(error);
      return false;
    }
  }

  async selectRecoveryRun(_index: number): Promise<boolean> {
    return false;
  }

  async confirmPendingRun(_start: boolean): Promise<boolean> {
    return false;
  }

  async resolveApproval(
    _approvalId: ApprovalRequestId,
    _resolution: ApprovalResolutionRequest,
  ): Promise<boolean> {
    return false;
  }

  async cancelActiveRun(): Promise<boolean> {
    return false;
  }

  detachActiveRun(): void {
    this.activeRun?.streamAbortController.abort();
    this.activeRun = undefined;
  }

  reconnectActiveRun(): void {
    // Stream reconnect is implemented by the transport recovery phase.
  }

  private async bootstrapLaunch(info: DaemonInfo): Promise<void> {
    const intent = this.options.launchIntent ?? { kind: "NEW" as const };
    if (intent.kind === "NEW") {
      this.workspace = { id: createWorkspaceId(), path: this.currentWorkspacePath };
      const session = await this.options.client.createSession({
        title: basename(this.workspace.path) || this.workspace.path,
        defaultWorkspace: this.workspace,
        defaultModel: info.defaultModel,
        metadata: {},
      });
      await this.enterSession(session, [], this.workspace);
      return;
    }

    if (intent.kind === "CONTINUE" || intent.kind === "RESUME_PICKER") {
      const candidates = await listMatchingSessionCandidates(
        this.options.client,
        this.currentWorkspacePath,
      );
      if (intent.kind === "RESUME_PICKER") {
        this.publish({
          ...this.state,
          bootstrap: "READY",
          controlMode: "SESSION_PICKER",
          sessionCandidates: candidates,
          recoveryCandidates: [],
          composerEnabled: false,
          activity: "Ready",
        });
        return;
      }
      const candidate = candidates[0];
      if (candidate === undefined) {
        throw new CliResumeError("No conversation found to continue in this workspace.");
      }
      await this.enterSession(candidate.session);
      return;
    }

    const session = await this.options.client.getSession(intent.sessionId);
    await this.enterSession(session);
  }

  private async enterSession(
    session: ClientAgentSession,
    visibleRuns?: readonly ClientAgentRun[],
    workspaceOverride?: WorkspaceRef,
  ): Promise<void> {
    const runs =
      visibleRuns ?? (await this.options.client.listRuns(session.id, { limit: 100 })).items;
    const workspaceResult =
      workspaceOverride === undefined
        ? resolveSessionWorkspace(session, runs, this.currentWorkspacePath)
        : { workspace: workspaceOverride };
    if ("error" in workspaceResult) throw new CliResumeError(workspaceResult.error);
    this.workspace = workspaceResult.workspace;

    const activeRuns = nonTerminalRuns(runs);
    const displayHistory = hydrateSessionTranscript(runs, activeRuns.length === 1 ? activeRuns[0]?.id : undefined);
    const next: CliViewState = {
      ...this.state,
      bootstrap: "READY",
      workspace: this.workspace,
      session,
      displayHistory,
      sessionCandidates: [],
      recoveryCandidates: activeRuns.length > 1 ? activeRuns : [],
      composerEnabled: activeRuns.length === 0,
      controlMode:
        activeRuns.length > 1
          ? "RUN_RECOVERY_PICKER"
          : activeRuns[0]?.status === "PENDING"
            ? "PENDING_RUN_CONFIRMATION"
            : "NONE",
      activity:
        activeRuns.length === 0
          ? "Ready"
          : (runStatusLabel(activeRuns[0]!.status) as CliActivity),
      ...(activeRuns.length === 1 ? { activeRun: { runId: activeRuns[0]!.id, status: activeRuns[0]!.status } } : {}),
      ...(activeRuns[0]?.status === "PENDING" ? { pendingRunId: activeRuns[0].id } : {}),
    };
    this.publish(next);
  }

  private publishFatal(error: unknown): void {
    this.publish({
      ...this.state,
      bootstrap: "BOOTSTRAP_ERROR",
      controlMode: "NONE",
      composerEnabled: false,
      activity: "Terminal error",
      fatalError:
        error instanceof CliConfigurationError || error instanceof CliResumeError
          ? error.message
          : toSafeCliError(error),
    });
  }

  private canSubmit(goal: string): boolean {
    if (this.disposed || this.state.bootstrap !== "READY") return false;
    if (this.state.session === undefined || this.state.daemonInfo === undefined) return false;
    if (this.activeRun !== undefined || this.submissionInFlight) return false;
    return goal.length > 0 && new TextEncoder().encode(goal).byteLength <= MAX_CLI_PROMPT_BYTES;
  }

  private async consumeRunEvents(
    active: ActiveRun,
    stream: AsyncIterable<AgentEvent>,
  ): Promise<void> {
    try {
      for await (const event of stream) {
        if (this.activeRun !== active) return;
        const projected = projectAgentEvent(this.state, event);
        this.publish(projected.state);
        if (projected.terminal) {
          if (active.terminalSettlement === undefined) {
            active.terminalSettlement = this.settleTerminal(active);
          }
          await active.terminalSettlement;
          return;
        }
      }
    } catch (error) {
      if (
        this.activeRun === active &&
        !active.streamAbortController.signal.aborted &&
        !this.disposed
      ) {
        this.publish({
          ...this.state,
          activity: "Transport error",
          fatalError: toSafeCliError(error),
        });
      }
    }
  }

  private async settleTerminal(active: ActiveRun): Promise<void> {
    const run = await this.options.client.getRun(active.runId);
    if (this.activeRun !== active || this.disposed) return;

    const finalResult = VerifiedRunFinalResultSchema.safeParse(run.finalResult);
    const transcriptEntry =
      run.status === "COMPLETED" && finalResult.success
        ? {
            id: this.nextTranscriptId("assistant"),
            kind: "ASSISTANT" as const,
            text: finalResult.data.text,
            runId: run.id,
          }
        : {
            id: this.nextTranscriptId("terminal"),
            kind: "RUN_TERMINAL" as const,
            text:
              run.status === "COMPLETED"
                ? "Run completed without a verified final result."
                : `Run ended with status ${run.status}.`,
            runId: run.id,
          };
    active.streamAbortController.abort();
    this.activeRun = undefined;
    const nextState = { ...this.state };
    delete nextState.activeRun;
    delete nextState.fatalError;
    this.publish({
      ...nextState,
      displayHistory: [...this.state.displayHistory, transcriptEntry],
      composerEnabled: true,
      activity: run.status === "COMPLETED" && finalResult.success ? "Ready" : "Terminal error",
    });
  }

  private removeOptimisticEntry(id: string, safeError: string): void {
    this.publish({
      ...this.state,
      displayHistory: this.state.displayHistory.filter((entry) => entry.id !== id),
      composerEnabled: this.state.bootstrap === "READY",
      activity: "Terminal error",
      fatalError: safeError,
    });
  }

  private nextTranscriptId(prefix: string): string {
    this.historySequence += 1;
    return `${prefix}-${this.historySequence}`;
  }

  private publish(state: CliViewState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

class CliConfigurationError extends Error {
  constructor() {
    super("Daemon is missing a default model or Run configuration.");
    this.name = "CliConfigurationError";
  }
}

class CliResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliResumeError";
  }
}
