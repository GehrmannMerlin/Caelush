import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { TerminalOutputDecoder } from "../exec/terminal-output.js";
import { terminateProcessTree } from "../exec/process-tree.js";
import type { ManagedProcessAdapter, ProcessExit, ProcessOutputEvent } from "../exec/contracts.js";
import { RuntimeExecError } from "../exec/errors.js";
import { RuntimeSandboxError, RuntimeSandboxProtocolError } from "../runtime-errors.js";
import { createSandboxHello } from "./control-protocol.js";
import { createSandboxControlTransport } from "./control-transport.js";
import type { SandboxedSpawnSpec } from "./contracts.js";

export async function createNativeRunnerProcessAdapter(input: {
  readonly runnerPath: string;
  readonly providerId: string;
  readonly spec: SandboxedSpawnSpec;
}): Promise<ManagedProcessAdapter> {
  if (input.spec.tty) throw new RuntimeExecError("PTY_UNAVAILABLE");
  const boundaryFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        workspaceRoot: input.spec.policy.filesystem.workspaceRoot,
        filesystemBoundary: input.spec.policy.filesystem.boundary,
        processBoundary: input.spec.policy.processBoundary,
        requiredEnforcement: input.spec.policy.requiredEnforcement,
      }),
      "utf8",
    )
    .digest("hex");
  const hello = createSandboxHello({
    nonce: input.spec.authorizationNonce,
    providerId: input.providerId,
    boundaryFingerprint,
  });
  const controlTransport = await createSandboxControlTransport({ hello });
  const args = [
    "--operation",
    "run",
    ...controlTransport.runnerArgs,
    "--provider",
    input.providerId,
    "--nonce",
    hello.nonce,
    "--boundary-fingerprint",
    hello.boundaryFingerprint,
    "--workspace-root",
    input.spec.policy.filesystem.workspaceRoot,
    "--cwd",
    input.spec.cwd,
    "--program",
    input.spec.launch.executable,
    "--",
    ...input.spec.launch.args,
  ];
  let child: ChildProcess;
  try {
    child = spawn(input.runnerPath, args, {
      cwd: input.spec.cwd,
      env: { ...input.spec.env },
      shell: false,
      windowsHide: true,
      stdio:
        process.platform === "win32" ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
    });
  } catch {
    await controlTransport.close();
    throw new RuntimeSandboxError("The native sandbox runner could not be started.");
  }
  if (child.stdin === null) {
    await controlTransport.close();
    await terminateProcessTree({ pid: child.pid, kill: () => child.kill() });
    throw new RuntimeSandboxError("The native sandbox runner did not provide a control channel.");
  }
  try {
    await controlTransport.waitForReady(child, hello);
  } catch (error) {
    throw error instanceof RuntimeSandboxError || error instanceof RuntimeSandboxProtocolError
      ? error
      : new RuntimeSandboxError("The native sandbox runner did not prove its boundary.");
  }
  return new NativeRunnerProcessAdapter(child, input.spec.tty);
}

class NativeRunnerProcessAdapter implements ManagedProcessAdapter {
  readonly tty: boolean;
  private readonly startListeners = new Set<() => void>();
  private readonly outputListeners = new Set<(event: ProcessOutputEvent) => void>();
  private readonly exitListeners = new Set<(exit: ProcessExit) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private readonly pendingOutput: ProcessOutputEvent[] = [];
  private pendingExit: ProcessExit | undefined;
  private pendingError: unknown;
  private started = false;
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    tty: boolean,
  ) {
    this.tty = tty;
    const stdoutDecoder = new TerminalOutputDecoder();
    const stderrDecoder = new TerminalOutputDecoder();
    child.on("spawn", () => {
      this.started = true;
      for (const listener of this.startListeners) listener();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.push(chunk);
      if (text) this.emitOutput({ stream: "stdout", text });
    });
    child.stdout?.on("end", () => {
      const text = stdoutDecoder.end();
      if (text) this.emitOutput({ stream: "stdout", text });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.push(chunk);
      if (text) this.emitOutput({ stream: "stderr", text });
    });
    child.stderr?.on("end", () => {
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

  onStart(listener: () => void): () => void {
    this.startListeners.add(listener);
    if (this.started) listener();
    return () => this.startListeners.delete(listener);
  }

  onOutput(listener: (event: ProcessOutputEvent) => void): () => void {
    this.outputListeners.add(listener);
    for (const event of this.pendingOutput.splice(0)) listener(event);
    return () => this.outputListeners.delete(listener);
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
    if (this.closed || this.child.stdin === null || this.child.stdin.destroyed) {
      throw new RuntimeExecError("STDIN_UNAVAILABLE");
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin!.write(chars, (error) =>
        error === undefined || error === null ? resolve() : reject(error),
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.destroy();
    if (this.child.exitCode === null && !this.child.killed) {
      await terminateProcessTree({
        pid: this.child.pid,
        kill: () => {
          this.child.kill();
          return true;
        },
      });
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
