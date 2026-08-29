import type { RunId } from "@caelush/protocol";

export const MAX_EXEC_COMMAND_BYTES = 64 * 1024;
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
  readonly ownerRunId: RunId;
  readonly command: string;
  readonly workdir?: string;
  readonly tty: boolean;
  readonly yieldTimeMs: number;
}

export interface RuntimeProcessInteractionRequest {
  readonly ownerRunId: RunId;
  readonly sessionId: string;
  readonly chars: string;
  readonly yieldTimeMs: number;
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
}

export interface RuntimeExecService {
  execute(request: RuntimeExecRequest): Promise<RuntimeExecResult>;
  interact(request: RuntimeProcessInteractionRequest): Promise<RuntimeExecResult>;
}
