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
import { createApprovalView } from "./cli-control.js";
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
  readonly generation: number;
  readonly recoverOnOpen: boolean;
  recoveryAdmitted: boolean;
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
  private pendingStartInFlight = false;
  private streamGeneration = 0;
  private controlGeneration = 0;
  private readonly approvalInFlight = new Set<ApprovalRequestId>();
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

    const active = this.attachActiveRun(run, false);
    try {
      await Promise.resolve();
      const response = await this.options.client.startRun(run.id);
      if (this.activeRun === active) this.updateActiveRun(response.run);
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

  async selectRecoveryRun(index: number): Promise<boolean> {
    if (this.state.controlMode !== "RUN_RECOVERY_PICKER") return false;
    const run = this.state.recoveryCandidates[index];
    if (run === undefined) return false;
    this.publish({
      ...this.state,
      recoveryCandidates: [],
      controlMode: run.status === "PENDING" ? "PENDING_RUN_CONFIRMATION" : "NONE",
      ...(run.status === "PENDING" ? { pendingRunId: run.id } : {}),
      activeRun: { runId: run.id, status: run.status },
      composerEnabled: false,
      activity: runStatusLabel(run.status) as CliActivity,
    });
    await this.prepareActiveRun(run);
    return true;
  }

  async confirmPendingRun(start: boolean): Promise<boolean> {
    if (
      !start ||
      this.state.controlMode !== "PENDING_RUN_CONFIRMATION" ||
      this.state.pendingRunId === undefined ||
      this.pendingStartInFlight
    ) {
      return false;
    }
    const runId = this.state.pendingRunId;
    this.pendingStartInFlight = true;
    try {
      const response = await this.options.client.startRun(runId);
      if (this.state.activeRun?.runId !== runId) return false;
      const { pendingRunId: _pendingRunId, ...stateWithoutPendingRun } = this.state;
      const nextState: CliViewState = {
        ...stateWithoutPendingRun,
        controlMode: "NONE",
        activeRun: { runId, status: response.run.status },
        activity: "Preparing",
        composerEnabled: false,
      };
      this.publish(nextState);
      this.attachActiveRun(response.run, true);
      return true;
    } catch (error) {
      this.publish({ ...this.state, controlError: toSafeCliError(error) });
      return false;
    } finally {
      this.pendingStartInFlight = false;
    }
  }

  async resolveApproval(
    approvalId: ApprovalRequestId,
    resolution: ApprovalResolutionRequest,
  ): Promise<boolean> {
    const active = this.activeRun;
    const currentApproval = this.state.approvalState?.requests.find(
      (request) => request.id === approvalId,
    );
    if (
      active === undefined ||
      currentApproval === undefined ||
      currentApproval.runId !== active.runId ||
      this.approvalInFlight.has(approvalId)
    ) {
      return false;
    }
    const generation = ++this.controlGeneration;
    this.approvalInFlight.add(approvalId);
    this.setApprovalSubmitting(approvalId, true);
    try {
      const pending = (await this.options.client.listPendingApprovals(active.runId)).items.find(
        (request) => request.id === approvalId && request.status === "PENDING",
      );
      if (generation !== this.controlGeneration || this.activeRun !== active) return false;
      if (pending === undefined) {
        await this.reconcileApprovals(active.runId, generation);
        return false;
      }
      const response = await this.options.client.resolveApproval(
        active.runId,
        approvalId,
        resolution,
      );
      if (generation !== this.controlGeneration || this.activeRun !== active) return false;
      this.updateActiveRun(response.run);
      this.removeApproval(approvalId);
      return true;
    } catch (error) {
      if (generation === this.controlGeneration && this.activeRun === active) {
        this.publish({ ...this.state, controlError: toSafeCliError(error) });
        await this.reconcileApprovals(active.runId, generation);
      }
      return false;
    } finally {
      this.approvalInFlight.delete(approvalId);
      if (this.activeRun === active && generation === this.controlGeneration) {
        this.setApprovalSubmitting(approvalId, false);
      }
    }
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
    const displayHistory = hydrateSessionTranscript(
      runs,
      activeRuns.length === 1 ? activeRuns[0]?.id : undefined,
    );
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
      ...(activeRuns.length === 1
        ? { activeRun: { runId: activeRuns[0]!.id, status: activeRuns[0]!.status } }
        : {}),
      ...(activeRuns[0]?.status === "PENDING" ? { pendingRunId: activeRuns[0].id } : {}),
    };
    this.publish(next);
    const activeRun = activeRuns.length === 1 ? activeRuns[0] : undefined;
    if (activeRun !== undefined) await this.prepareActiveRun(activeRun);
  }

  private async prepareActiveRun(run: ClientAgentRun): Promise<void> {
    if (run.status === "PENDING") return;
    if (run.status === "WAITING_APPROVAL") {
      const approvals = (await this.options.client.listPendingApprovals(run.id)).items;
      const requests = approvals
        .slice()
        .sort((left, right) =>
          left.createdAt !== right.createdAt
            ? left.createdAt - right.createdAt
            : left.id < right.id
              ? -1
              : left.id > right.id
                ? 1
                : 0,
        )
        .map(createApprovalView);
      if (requests.length > 0) {
        this.publish({
          ...this.state,
          controlMode: "APPROVAL",
          approvalState: { requests, selectedRequestIndex: 0, submitting: false },
          composerEnabled: false,
          activity: "Approval required",
        });
      }
      this.attachActiveRun(run, requests.length === 0);
      return;
    }
    this.attachActiveRun(run, true);
  }

  private addApproval(approval: Parameters<typeof createApprovalView>[0]): void {
    if (this.state.controlMode === "CANCELLING" || this.state.activeRun?.runId !== approval.runId) {
      return;
    }
    const existing = this.state.approvalState?.requests ?? [];
    const requests = [
      ...existing.filter((request) => request.id !== approval.id),
      createApprovalView(approval),
    ].sort((left, right) =>
      left.createdAt !== right.createdAt
        ? left.createdAt - right.createdAt
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
    );
    this.publish({
      ...this.state,
      controlMode: "APPROVAL",
      approvalState: {
        requests,
        selectedRequestIndex: Math.min(
          this.state.approvalState?.selectedRequestIndex ?? 0,
          Math.max(requests.length - 1, 0),
        ),
        submitting: false,
      },
      composerEnabled: false,
      activity: "Approval required",
    });
  }

  private removeApproval(approvalId: ApprovalRequestId): void {
    const approvalState = this.state.approvalState;
    if (approvalState === undefined) return;
    const requests = approvalState.requests.filter((request) => request.id !== approvalId);
    if (requests.length === 0) {
      const { approvalState: _approvalState, ...withoutApproval } = this.state;
      this.publish({ ...withoutApproval, controlMode: "NONE" });
      return;
    }
    this.publish({
      ...this.state,
      approvalState: {
        requests,
        selectedRequestIndex: Math.min(approvalState.selectedRequestIndex, requests.length - 1),
        submitting: false,
      },
    });
  }

  private setApprovalSubmitting(approvalId: ApprovalRequestId, submitting: boolean): void {
    const approvalState = this.state.approvalState;
    if (approvalState === undefined) return;
    if (!approvalState.requests.some((request) => request.id === approvalId)) return;
    this.publish({ ...this.state, approvalState: { ...approvalState, submitting } });
  }

  private async reconcileApprovals(runId: RunId, generation: number): Promise<void> {
    try {
      const [run, approvals] = await Promise.all([
        this.options.client.getRun(runId),
        this.options.client.listPendingApprovals(runId),
      ]);
      if (generation !== this.controlGeneration || this.activeRun?.runId !== runId) return;
      this.updateActiveRun(run);
      if (approvals.items.length === 0) {
        const { approvalState: _approvalState, ...withoutApproval } = this.state;
        this.publish({ ...withoutApproval, controlMode: "NONE" });
        return;
      }
      this.publish({
        ...this.state,
        controlMode: "APPROVAL",
        approvalState: {
          requests: approvals.items.slice().sort((left, right) =>
            left.createdAt !== right.createdAt
              ? left.createdAt - right.createdAt
              : left.id < right.id
                ? -1
                : left.id > right.id
                  ? 1
                  : 0,
          ).map(createApprovalView),
          selectedRequestIndex: 0,
          submitting: false,
        },
      });
    } catch {
      // The original safe control error remains visible; reconciliation is best effort.
    }
  }

  private attachActiveRun(run: ClientAgentRun, recoverOnOpen: boolean): ActiveRun {
    this.activeRun?.streamAbortController.abort();
    const active: ActiveRun = {
      runId: run.id,
      streamAbortController: new AbortController(),
      generation: ++this.streamGeneration,
      recoverOnOpen,
      recoveryAdmitted: false,
    };
    this.activeRun = active;
    this.publish({
      ...this.state,
      timeline: createInitialCliTimelineState(run.id),
      activeRun: { runId: run.id, status: run.status },
      composerEnabled: false,
    });
    try {
      const stream = this.options.client.watchRunEvents(run.id, {
        afterSequence: 0,
        signal: active.streamAbortController.signal,
        onOpen: () => this.handleStreamOpen(active),
      });
      void this.consumeRunEvents(active, stream);
    } catch (error) {
      this.handleStreamFailure(active, error);
    }
    return active;
  }

  private handleStreamOpen(active: ActiveRun): void {
    if (this.activeRun !== active || this.disposed) return;
    const nextState = { ...this.state, transportState: "CONNECTED" as const };
    delete nextState.transportError;
    this.publish(nextState);
    if (!active.recoverOnOpen || active.recoveryAdmitted) return;
    active.recoveryAdmitted = true;
    void this.admitRecovery(active);
  }

  private async admitRecovery(active: ActiveRun): Promise<void> {
    try {
      const response = await this.options.client.recoverRun(active.runId);
      if (this.activeRun !== active || this.disposed) return;
      this.updateActiveRun(response.run);
    } catch (error) {
      if (this.activeRun !== active || this.disposed) return;
      this.publish({ ...this.state, controlError: toSafeCliError(error) });
    }
  }

  private updateActiveRun(run: ClientAgentRun): void {
    if (this.activeRun?.runId !== run.id) return;
    this.publish({
      ...this.state,
      activeRun: { runId: run.id, status: run.status },
      activity:
        this.state.transportError === undefined
          ? (runStatusLabel(run.status) as CliActivity)
          : this.state.activity,
    });
  }

  private handleStreamFailure(active: ActiveRun, error: unknown): void {
    if (
      this.activeRun !== active ||
      this.disposed ||
      active.streamAbortController.signal.aborted
    ) {
      return;
    }
    this.publish({
      ...this.state,
      activity: "Transport error",
      transportError: toSafeCliError(error),
    });
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
        if (this.activeRun !== active || active.generation !== this.streamGeneration) return;
        const projected = projectAgentEvent(this.state, event);
        this.publish(projected.state);
        if (event.type === "approval.requested") this.addApproval(event.payload.approval);
        if (event.type === "approval.resolved") this.removeApproval(event.payload.approvalId);
        if (projected.terminal) {
          this.controlGeneration += 1;
          if (active.terminalSettlement === undefined) {
            active.terminalSettlement = this.settleTerminal(active);
          }
          await active.terminalSettlement;
          return;
        }
      }
    } catch (error) {
      this.handleStreamFailure(active, error);
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
