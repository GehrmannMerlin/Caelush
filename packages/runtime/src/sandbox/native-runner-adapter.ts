import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { TerminalOutputDecoder } from "../exec/terminal-output.js";
import { terminateProcessTree } from "../exec/process-tree.js";
import type { ManagedProcessAdapter, ProcessExit, ProcessOutputEvent } from "../exec/contracts.js";
import { RuntimeExecError } from "../exec/errors.js";
import { RuntimeSandboxError, RuntimeSandboxProtocolError } from "../runtime-errors.js";
import {
  acceptSandboxReady,
  createSandboxHello,
  decodeSandboxControlMessage,
  encodeSandboxControlMessage,
  MAX_SANDBOX_CONTROL_MESSAGE_BYTES,
  type SandboxHelloMessage,
} from "./control-protocol.js";
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
  const args = [
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
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
  } catch {
    throw new RuntimeSandboxError("The native sandbox runner could not be started.");
  }
  const control = child.stdio[3];
  if (!(control instanceof Readable) || child.stdin === null) {
    child.kill();
    throw new RuntimeSandboxError("The native sandbox runner did not provide a control channel.");
  }
  try {
    await waitForReady(child, control, hello);
  } catch (error) {
    try {
      child.kill();
    } catch {
      // The runner may already have exited.
    }
    if (error instanceof RuntimeSandboxProtocolError || error instanceof RuntimeSandboxError) {
      throw error;
    }
    throw new RuntimeSandboxError("The native sandbox runner did not prove its boundary.");
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

async function waitForReady(
  child: ChildProcess,
  control: Readable,
  hello: SandboxHelloMessage,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      control.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_SANDBOX_CONTROL_MESSAGE_BYTES) {
        finish(new RuntimeSandboxProtocolError("Sandbox control channel exceeded its size limit."));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            const message = decodeSandboxControlMessage(line);
            acceptSandboxReady(message, hello);
            finish();
            return;
          } catch (error) {
            finish(error);
            return;
          }
        }
        newline = buffer.indexOf("\n");
      }
    };
    const onError = (): void =>
      finish(new RuntimeSandboxError("The native sandbox runner failed before READY."));
    const onClose = (): void =>
      finish(new RuntimeSandboxError("The native sandbox runner exited before READY."));
    control.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
    // The runner receives no READY authority from user stdout/stderr; the HELLO is only used to
    // derive the expected tuple. Keeping this call here also makes malformed expected messages fail
    // before the process is accepted by a Provider.
    encodeSandboxControlMessage(hello);
  });
}
