import type { RunId } from "@caelush/protocol";
import type { AuthorizedRuntimeExecution } from "../security/runtime-boundary.js";

export const MAX_EXEC_COMMAND_BYTES = 64 * 1024;
export const MAX_EXEC_ARG_COUNT = 128;
export const MAX_EXEC_ARG_BYTES = 16 * 1024;
export const MAX_EXEC_ARGV_BYTES = 64 * 1024;
export const MAX_EXEC_STDIN_BYTES = 64 * 1024;
export const MAX_EXEC_MODEL_OUTPUT_BYTES = 48 * 1024;
export const MIN_EXEC_YIELD_TIME_MS = 250;
export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
export const DEFAULT_EXEC_POLL_YIELD_TIME_MS = 5_000;
export const DEFAULT_EXEC_WRITE_YIELD_TIME_MS = 250;
export const MAX_EXEC_YIELD_TIME_MS = 30_000;
export const MAX_PROCESS_BUFFER_BYTES = 1024 * 1024;
export const MAX_MANAGED_PROCESSES = 32;

export interface RuntimeExecRequest {
  readonly signal?: AbortSignal;
  readonly ownerRunId: RunId;
  readonly command: string;
  readonly workdir?: string;
  readonly tty: boolean;
  readonly yieldTimeMs: number;
  /** Neutral live output observation; Runtime does not interpret or persist the event. */
  readonly onOutput?: (event: ProcessOutputEvent) => void;
}

export interface RuntimeArgvExecRequest {
  readonly signal?: AbortSignal;
  readonly ownerRunId: RunId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly workdir?: string;
  readonly yieldTimeMs: number;
  /** Neutral live output observation; Runtime does not interpret or persist the event. */
  readonly onOutput?: (event: ProcessOutputEvent) => void;
}

export interface AuthorizedRuntimeExecRequest extends RuntimeExecRequest {
  readonly authorization: AuthorizedRuntimeExecution;
}

export interface AuthorizedRuntimeArgvExecRequest extends RuntimeArgvExecRequest {
  readonly authorization: AuthorizedRuntimeExecution;
}

export interface RuntimeProcessInteractionRequest {
  readonly signal?: AbortSignal;
  readonly ownerRunId: RunId;
  readonly sessionId: string;
  readonly chars: string;
  readonly yieldTimeMs: number;
  /** Neutral live output observation; Runtime does not interpret or persist the event. */
  readonly onOutput?: (event: ProcessOutputEvent) => void;
}

/**
 * Terminate exactly one managed process session this Run owns.
 *
 * ```text
 * sessionId    an opaque id the Runtime itself minted, never a pid, an image name or a pattern
 * ownerRunId   the Run identity the caller is acting as; it is not a model-supplied argument
 * ```
 *
 * There is deliberately no `all`, no wildcard, no image-name and no pid form. A caller that could
 * name a process by anything other than the Runtime's own session handle would be back to the
 * ownership problem this request exists to remove, and `cancelOwnedByRun` — which stops *every*
 * process a Run owns — is not a substitute for stopping one.
 */
export interface RuntimeProcessTerminationRequest {
  readonly ownerRunId: RunId;
  readonly sessionId: string;
}

export interface RuntimeExecResult {
  readonly status: "RUNNING" | "EXITED";
  readonly sessionId?: string;
  readonly output: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly totalOutputBytes: number;
  readonly omittedBytes: number;
  readonly tty?: boolean;
  readonly durationMs?: number;
  readonly charsAcceptedBytes?: number;
}

export interface ShellLaunch {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface ProcessOutputEvent {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface ProcessExit {
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface ManagedProcessAdapter {
  readonly tty: boolean;
  onStart(listener: () => void): () => void;
  onOutput(listener: (event: ProcessOutputEvent) => void): () => void;
  onExit(listener: (exit: ProcessExit) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
  write(chars: string): Promise<void>;
  close(): Promise<void>;
}

export interface ProcessAdapterFactory {
  create(input: {
    readonly launch: ShellLaunch;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly tty: boolean;
  }): Promise<ManagedProcessAdapter>;
}

export interface ManagedProcessStartRequest extends RuntimeExecRequest {
  readonly launch: ShellLaunch;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly authorization?: AuthorizedRuntimeExecution;
}

export interface RuntimeExecService {
  execute(request: RuntimeExecRequest): Promise<RuntimeExecResult>;
  executeArgv(request: RuntimeArgvExecRequest): Promise<RuntimeExecResult>;
  executeAuthorized(request: AuthorizedRuntimeExecRequest): Promise<RuntimeExecResult>;
  executeArgvAuthorized(request: AuthorizedRuntimeArgvExecRequest): Promise<RuntimeExecResult>;
  interact(request: RuntimeProcessInteractionRequest): Promise<RuntimeExecResult>;
  /**
   * Terminate one owned managed session.
   *
   * The returned result proves the outcome: `EXITED` with `signal: "KILLED"` for a process this call
   * actually terminated. A session this Run does not own, and a session that never existed, both
   * fail the same way — the Runtime must not disclose who owns a foreign session.
   */
  terminate(request: RuntimeProcessTerminationRequest): Promise<RuntimeExecResult>;
}
