import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TerminalOutputDecoder } from "./terminal-output.js";
import type {
  ManagedProcessAdapter,
  ProcessExit,
  ProcessOutputEvent,
  ShellLaunch,
} from "./contracts.js";
import { RuntimeExecError } from "./errors.js";

export interface PipeProcessAdapterOptions {
  readonly launch: ShellLaunch;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

class PipeProcessAdapter implements ManagedProcessAdapter {
  readonly tty = false;
  private readonly startListeners = new Set<() => void>();
  private readonly outputListeners = new Set<(event: ProcessOutputEvent) => void>();
  private readonly exitListeners = new Set<(exit: ProcessExit) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private readonly pendingOutput: ProcessOutputEvent[] = [];
  private pendingExit: ProcessExit | undefined;
  private started = false;
  private pendingError: unknown;
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const stdoutDecoder = new TerminalOutputDecoder();
    const stderrDecoder = new TerminalOutputDecoder();
    child.on("spawn", () => {
      this.started = true;
      for (const listener of this.startListeners) listener();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.push(chunk);
      if (text) this.emitOutput({ stream: "stdout", text });
    });
    child.stdout.on("end", () => {
      const text = stdoutDecoder.end();
      if (text) this.emitOutput({ stream: "stdout", text });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.push(chunk);
      if (text) this.emitOutput({ stream: "stderr", text });
    });
    child.stderr.on("end", () => {
      const text = stderrDecoder.end();
      if (text) this.emitOutput({ stream: "stderr", text });
    });
    child.on("error", (error) => {
      this.pendingError = error;
      for (const listener of this.errorListeners) listener(error);
    });
    child.on("close", (exitCode, signal) => {
      const exit: ProcessExit = {
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal === null ? {} : { signal }),
      };
      this.pendingExit = exit;
      for (const listener of this.exitListeners) listener(exit);
    });
  }

  onOutput(listener: (event: ProcessOutputEvent) => void): () => void {
    this.outputListeners.add(listener);
    for (const event of this.pendingOutput.splice(0)) listener(event);
    return () => this.outputListeners.delete(listener);
  }

  onStart(listener: () => void): () => void {
    this.startListeners.add(listener);
    if (this.started) listener();
    return () => this.startListeners.delete(listener);
  }

  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    if (this.pendingExit !== undefined) listener(this.pendingExit);
    return () => this.exitListeners.delete(listener);
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    if (this.pendingError !== undefined) listener(this.pendingError);
    return () => this.errorListeners.delete(listener);
  }

  async write(chars: string): Promise<void> {
    if (this.closed || this.child.stdin.destroyed || this.child.exitCode !== null) {
      throw new RuntimeExecError("STDIN_UNAVAILABLE");
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(chars, (error) =>
        error === undefined || error === null ? resolve() : reject(error),
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.destroy();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }

  private emitOutput(event: ProcessOutputEvent): void {
    if (this.outputListeners.size === 0) {
      this.pendingOutput.push(event);
      return;
    }
    for (const listener of this.outputListeners) listener(event);
  }
}

export async function createPipeProcessAdapter(
  options: PipeProcessAdapterOptions,
): Promise<ManagedProcessAdapter> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.launch.executable, [...options.launch.args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new RuntimeExecError("SPAWN_FAILED", { cause: error });
  }
  return new PipeProcessAdapter(child);
}
