import { RuntimeExecError } from "./errors.js";
import { TerminalOutputSanitizer } from "./terminal-output.js";
import type {
  ManagedProcessAdapter,
  ProcessExit,
  ProcessOutputEvent,
  ShellLaunch,
} from "./contracts.js";

export interface PtyProcessAdapterOptions {
  readonly launch: ShellLaunch;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export async function createPtyProcessAdapter(
  options: PtyProcessAdapterOptions,
): Promise<ManagedProcessAdapter> {
  let pty: typeof import("node-pty");
  try {
    pty = await import("node-pty");
  } catch (error) {
    throw new RuntimeExecError("PTY_UNAVAILABLE", { cause: error });
  }
  try {
    const child = pty.spawn(options.launch.executable, [...options.launch.args], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: { ...options.env },
    });
    return new PtyProcessAdapter(child);
  } catch (error) {
    throw new RuntimeExecError("PTY_UNAVAILABLE", { cause: error });
  }
}

interface PtyLike {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  kill(): void;
}

class PtyProcessAdapter implements ManagedProcessAdapter {
  readonly tty = true;
  private readonly outputListeners = new Set<(event: ProcessOutputEvent) => void>();
  private readonly startListeners = new Set<() => void>();
  private readonly exitListeners = new Set<(exit: ProcessExit) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private readonly pendingOutput: ProcessOutputEvent[] = [];
  private readonly sanitizer = new TerminalOutputSanitizer();
  private pendingExit: ProcessExit | undefined;
  private closed = false;
  private readonly started = true;

  constructor(private readonly child: PtyLike) {
    child.onData((data) => {
      const text = this.sanitizer.push(data);
      if (text) this.emitOutput({ stream: "stdout", text });
    });
    child.onExit(({ exitCode, signal }) => {
      const trailing = this.sanitizer.end();
      if (trailing) this.emitOutput({ stream: "stdout", text: trailing });
      const exit: ProcessExit = {
        ...(exitCode === undefined || exitCode === null ? {} : { exitCode }),
        ...(signal === undefined || signal === 0 ? {} : { signal: String(signal) }),
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
    return () => this.errorListeners.delete(listener);
  }

  async write(chars: string): Promise<void> {
    if (this.closed) throw new RuntimeExecError("STDIN_UNAVAILABLE");
    try {
      this.child.write(chars);
    } catch (error) {
      for (const listener of this.errorListeners) listener(error);
      throw new RuntimeExecError("STDIN_UNAVAILABLE", { cause: error });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      // Runtime shutdown is best effort.
    }
  }

  private emitOutput(event: ProcessOutputEvent): void {
    if (this.outputListeners.size === 0) {
      this.pendingOutput.push(event);
      return;
    }
    for (const listener of this.outputListeners) listener(event);
  }
}
