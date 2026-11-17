import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { TerminalOutputDecoder } from "../exec/terminal-output.js";
import { terminateProcessTree } from "../exec/process-tree.js";
import type { ManagedProcessAdapter, ProcessExit, ProcessOutputEvent } from "../exec/contracts.js";
import { RuntimeExecError } from "../exec/errors.js";
import {
  RuntimeSandboxError,
  RuntimeSandboxOperationError,
  RuntimeSandboxProtocolError,
} from "../runtime-errors.js";
import {
  createSandboxHello,
  SANDBOX_READ_ONLY_RESOURCE_CAPABILITY_VERSION,
  type SandboxReadyMessage,
} from "./control-protocol.js";
import { createSandboxControlTransport } from "./control-transport.js";
import type { SandboxedSpawnSpec } from "./contracts.js";
import type { PrivateRunTemp } from "./private-temp.js";
import type { RuntimeProcessPolicy } from "../security/runtime-boundary.js";

export type NativeWindowsSandboxMode =
  "read-only" | "workspace-write" | "workspace-write-readonly-resource";

export function modeForPolicy(
  policy: RuntimeProcessPolicy,
  grant?: SandboxedSpawnSpec["readOnlyResourceGrant"],
): NativeWindowsSandboxMode {
  if (grant !== undefined) {
    const authority = policy.filesystem.readOnlyResources;
    const matchingResources = authority?.resources.filter(
      (resource) =>
        resource.resourceId === grant.resourceId &&
        resource.bundleRevision === grant.bundleRevision &&
        resource.canonicalRoot === grant.canonicalRoot &&
        resource.contentManifestHash === grant.contentManifestHash,
    ).length;
    if (
      policy.requiredEnforcement === "OS_RESTRICTED" &&
      policy.processBoundary === "WORKSPACE_WRITE" &&
      policy.filesystem.boundary === "WORKSPACE_READ_WRITE" &&
      grant.runId === policy.runId &&
      authority?.enabled === true &&
      authority.runId === policy.runId &&
      authority.revision === grant.policyRevision &&
      authority.expiresAt > Date.now() &&
      grant.lifetime.issuedAt <= Date.now() &&
      grant.lifetime.expiresAt > Date.now() &&
      grant.lifetime.expiresAt <= authority.expiresAt &&
      grant.lifetime.expiresAt - grant.lifetime.issuedAt <= 60_000 &&
      /^[a-f0-9]{64}$/u.test(grant.authorityFingerprint) &&
      readOnlyResourceAuthorityFingerprint(grant) === grant.authorityFingerprint &&
      matchingResources === 1
    ) {
      return "workspace-write-readonly-resource";
    }
    throw new RuntimeSandboxOperationError("SKILL_SCRIPT_UNAVAILABLE");
  }
  if (
    policy.requiredEnforcement === "OS_RESTRICTED" &&
    policy.processBoundary === "READ_ONLY" &&
    policy.filesystem.boundary === "WORKSPACE_READ_ONLY"
  ) {
    return "read-only";
  }
  if (
    policy.requiredEnforcement === "OS_RESTRICTED" &&
    policy.processBoundary === "WORKSPACE_WRITE" &&
    policy.filesystem.boundary === "WORKSPACE_READ_WRITE"
  ) {
    return "workspace-write";
  }
  throw new RuntimeSandboxError("The native sandbox policy tuple is inconsistent.");
}

export function assertReadOnlyResourceCapability(ready: SandboxReadyMessage): void {
  if (ready.readOnlyResourceCapabilityVersion !== SANDBOX_READ_ONLY_RESOURCE_CAPABILITY_VERSION) {
    throw new RuntimeSandboxProtocolError(
      "Sandbox runner did not prove read-only resource capability enforcement.",
    );
  }
}

export async function createNativeRunnerProcessAdapter(input: {
  readonly runnerPath: string;
  readonly providerId: string;
  readonly spec: SandboxedSpawnSpec;
  readonly readyTimeoutMs?: number;
  readonly privateRunTemp?: PrivateRunTemp;
}): Promise<ManagedProcessAdapter> {
  if (input.spec.tty) throw new RuntimeExecError("PTY_UNAVAILABLE");
  const grant = input.spec.readOnlyResourceGrant;
  const mode = modeForPolicy(input.spec.policy, grant);
  const resourceGrantInstanceFingerprint =
    grant === undefined
      ? undefined
      : createHash("sha256")
          .update(
            JSON.stringify([
              "caelush-read-only-resource-instance-v1",
              grant.authorityFingerprint,
              randomUUID(),
            ]),
            "utf8",
          )
          .digest("hex");
  const boundaryFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        workspaceRoot: input.spec.policy.filesystem.workspaceRoot,
        filesystemBoundary: input.spec.policy.filesystem.boundary,
        processBoundary: input.spec.policy.processBoundary,
        requiredEnforcement: input.spec.policy.requiredEnforcement,
        ...(grant === undefined
          ? {}
          : {
              readOnlyResource: {
                resourceId: grant.resourceId,
                canonicalRoot: grant.canonicalRoot,
                authorityFingerprint: grant.authorityFingerprint,
                instanceFingerprint: resourceGrantInstanceFingerprint,
              },
            }),
      }),
      "utf8",
    )
    .digest("hex");
  const hello = createSandboxHello({
    nonce: input.spec.authorizationNonce,
    providerId: input.providerId,
    boundaryFingerprint,
  });
  const controlTransport = await createSandboxControlTransport({
    hello,
    ...(input.readyTimeoutMs === undefined ? {} : { timeoutMs: input.readyTimeoutMs }),
  });
  const args = [
    "--operation",
    "run",
    ...controlTransport.runnerArgs,
    "--provider",
    input.providerId,
    "--mode",
    mode,
    "--nonce",
    hello.nonce,
    "--boundary-fingerprint",
    hello.boundaryFingerprint,
    "--workspace-root",
    input.spec.policy.filesystem.workspaceRoot,
    ...(input.privateRunTemp === undefined
      ? []
      : [
          "--private-temp",
          input.privateRunTemp.root,
          "--temp-marker-id",
          input.privateRunTemp.markerId,
        ]),
    ...(grant === undefined
      ? []
      : [
          "--resource-root",
          grant.canonicalRoot,
          "--resource-grant-fingerprint",
          resourceGrantInstanceFingerprint!,
          "--resource-grant-version",
          String(SANDBOX_READ_ONLY_RESOURCE_CAPABILITY_VERSION),
        ]),
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
    const ready = await controlTransport.waitForReady(child, hello);
    if (grant !== undefined) {
      try {
        assertReadOnlyResourceCapability(ready);
      } catch (error) {
        await terminateProcessTree({
          pid: child.pid,
          kill: () => {
            child.kill();
            return true;
          },
        });
        throw error;
      }
    }
  } catch (error) {
    throw error instanceof RuntimeSandboxError || error instanceof RuntimeSandboxProtocolError
      ? error
      : new RuntimeSandboxError("The native sandbox runner did not prove its boundary.");
  }
  return new NativeRunnerProcessAdapter(child, input.spec.tty);
}

function readOnlyResourceAuthorityFingerprint(
  grant: NonNullable<SandboxedSpawnSpec["readOnlyResourceGrant"]>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "caelush-read-only-resource-grant-v1",
        grant.runId,
        grant.resourceId,
        grant.bundleRevision,
        grant.canonicalRoot,
        grant.policyRevision,
        grant.contentManifestHash,
      ]),
      "utf8",
    )
    .digest("hex");
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

export function withNativeRunnerCleanup(
  adapter: ManagedProcessAdapter,
  cleanup: () => Promise<void>,
): ManagedProcessAdapter {
  return new CleanupProcessAdapter(adapter, cleanup);
}

class CleanupProcessAdapter implements ManagedProcessAdapter {
  readonly tty: boolean;
  private readonly startListeners = new Set<() => void>();
  private readonly outputListeners = new Set<(event: ProcessOutputEvent) => void>();
  private readonly exitListeners = new Set<(exit: ProcessExit) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private readonly pendingOutput: ProcessOutputEvent[] = [];
  private pendingExit: ProcessExit | undefined;
  private pendingError: unknown;
  private started = false;
  private cleanupPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly adapter: ManagedProcessAdapter,
    private readonly cleanup: () => Promise<void>,
  ) {
    this.tty = adapter.tty;
    adapter.onStart(() => {
      this.started = true;
      for (const listener of this.startListeners) listener();
    });
    adapter.onOutput((event) => this.emitOutput(event));
    adapter.onError((error) => {
      this.emitError(error);
      void this.cleanupOnce().catch((cleanupError) => this.emitError(cleanupError));
    });
    adapter.onExit((exit) => {
      void this.finishExit(exit);
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

  write(chars: string): Promise<void> {
    return this.adapter.write(chars);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    let closeError: unknown;
    try {
      await this.adapter.close();
    } catch (error) {
      closeError = error;
    }
    let cleanupError: unknown;
    try {
      await this.cleanupOnce();
    } catch (error) {
      cleanupError = error;
    }
    if (closeError !== undefined) throw closeError;
    if (cleanupError !== undefined) throw cleanupError;
  }

  private async finishExit(exit: ProcessExit): Promise<void> {
    try {
      await this.cleanupOnce();
    } catch (error) {
      this.emitError(error);
    }
    this.pendingExit = exit;
    for (const listener of this.exitListeners) listener(exit);
  }

  private cleanupOnce(): Promise<void> {
    this.cleanupPromise ??= Promise.resolve().then(() => this.cleanup());
    return this.cleanupPromise;
  }

  private emitError(error: unknown): void {
    this.pendingError = error;
    for (const listener of this.errorListeners) listener(error);
  }

  private emitOutput(event: ProcessOutputEvent): void {
    if (this.outputListeners.size === 0) {
      this.pendingOutput.push(event);
      return;
    }
    for (const listener of this.outputListeners) listener(event);
  }
}
