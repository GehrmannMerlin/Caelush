import { basename, resolve } from "node:path";
import type {
  AgentEvent,
  ClientAgentRun,
  ClientAgentSession,
  CreateRunRequest,
  CreateSessionRequest,
  DaemonInfo,
  HealthResponse,
  RunActionResponse,
  RunId,
  SessionId,
  WorkspaceRef,
} from "@caelush/protocol";
import { createWorkspaceId, VerifiedRunFinalResultSchema } from "@caelush/protocol";
import type { WatchRunEventsOptions } from "@caelush/client";
import { projectAgentEvent } from "./event-projector.js";
import { createInitialCliState, type CliStateListener, type CliViewState } from "./cli-state.js";
import { toSafeCliError } from "../bootstrap/safe-errors.js";

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
}

export interface CliConversationControllerOptions {
  readonly client: CliDaemonClient;
  readonly workspacePath: string;
}

interface ActiveRun {
  readonly runId: RunId;
  readonly streamAbortController: AbortController;
  terminalSettlement?: Promise<void>;
}

export class CliConversationController {
  private readonly workspace: WorkspaceRef;
  private readonly listeners = new Set<CliStateListener>();
  private state: CliViewState = createInitialCliState();
  private bootstrapPromise: Promise<void> | undefined;
  private activeRun: ActiveRun | undefined;
  private submissionInFlight = false;
  private transcriptSequence = 0;
  private disposed = false;

  constructor(private readonly options: CliConversationControllerOptions) {
    this.workspace = { id: createWorkspaceId(), path: resolve(options.workspacePath) };
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
    const optimisticId = this.nextTranscriptId("user");
    this.submissionInFlight = true;
    this.publish({
      ...this.state,
      transcript: [...this.state.transcript, { id: optimisticId, kind: "USER", text: goal }],
      composerEnabled: false,
      activity: "Preparing",
    });

    let run: ClientAgentRun;
    try {
      run = await this.options.client.createRun(session.id, {
        goal,
        workspace: this.workspace,
        model: info.defaultModel!,
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
      transcript: this.state.transcript.map((entry) =>
        entry.id === optimisticId ? { ...entry, runId: run.id } : entry,
      ),
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
        afterSequence: 0,
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
        workspace: this.workspace,
      });
      const session = await this.options.client.createSession({
        title: basename(this.workspace.path) || this.workspace.path,
        defaultWorkspace: this.workspace,
        defaultModel: info.defaultModel,
        metadata: {},
      });
      this.publish({
        ...this.state,
        bootstrap: "READY",
        session,
        daemonInfo: info,
        workspace: this.workspace,
        composerEnabled: true,
        activity: "Ready",
      });
    } catch (error) {
      this.publish({
        ...this.state,
        bootstrap: "BOOTSTRAP_ERROR",
        composerEnabled: false,
        activity: "Terminal error",
        fatalError: error instanceof CliConfigurationError ? error.message : toSafeCliError(error),
      });
    }
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
      transcript: [...this.state.transcript, transcriptEntry],
      composerEnabled: true,
      activity: run.status === "COMPLETED" && finalResult.success ? "Ready" : "Terminal error",
    });
  }

  private removeOptimisticEntry(id: string, safeError: string): void {
    this.publish({
      ...this.state,
      transcript: this.state.transcript.filter((entry) => entry.id !== id),
      composerEnabled: this.state.bootstrap === "READY",
      activity: "Terminal error",
      fatalError: safeError,
    });
  }

  private nextTranscriptId(prefix: string): string {
    this.transcriptSequence += 1;
    return `${prefix}-${this.transcriptSequence}`;
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
