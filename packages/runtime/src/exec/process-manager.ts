import crypto from "node:crypto";
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  MAX_MANAGED_PROCESSES,
  MAX_PROCESS_BUFFER_BYTES,
  type ManagedProcessAdapter,
  type ManagedProcessStartRequest,
  type ProcessAdapterFactory,
  type RuntimeExecResult,
  type RuntimeProcessInteractionRequest,
  type RuntimeProcessTerminationRequest,
} from "./contracts.js";
import type { RunId } from "@caelush/protocol";
import {
  RuntimeExecError,
  RuntimeProcessStaleSessionError,
  RuntimeProcessUncertainError,
} from "./errors.js";
import { createPipeProcessAdapter } from "./pipe-process-adapter.js";
import { createPtyProcessAdapter } from "./pty-process-adapter.js";
import { HeadTailOutputBuffer } from "./output-buffer.js";
import { isManagedProcessTerminal, type ManagedProcessState } from "./process-state.js";

export interface LocalProcessManagerOptions {
  readonly generationId?: string;
  readonly sessionIdFactory?: (generationId: string, sequence: number) => string;
  readonly maxProcesses?: number;
  readonly pipeFactory?: ProcessAdapterFactory;
  readonly ptyFactory?: ProcessAdapterFactory;
}

interface ProcessEntry {
  readonly id: string;
  readonly ownerRunId: ManagedProcessStartRequest["ownerRunId"];
  readonly adapter: ManagedProcessAdapter;
  readonly tty: boolean;
  readonly startedAtMs: number;
  readonly output: HeadTailOutputBuffer;
  state: ManagedProcessState;
  exitCode: number | undefined;
  signal: string | undefined;
  totalOutputBytes: number;
  totalOmittedBytes: number;
  error?: RuntimeExecError;
  waiters: Set<() => void>;
}

export class LocalProcessManager {
  readonly runtimeGenerationId: string;
  private readonly entries = new Map<string, ProcessEntry>();
  private readonly maxProcesses: number;
  private readonly pipeFactory: ProcessAdapterFactory;
  private readonly ptyFactory: ProcessAdapterFactory;
  private readonly sessionIdFactory: (generationId: string, sequence: number) => string;
  private sequence = 0;

  constructor(options: LocalProcessManagerOptions = {}) {
    this.runtimeGenerationId = options.generationId ?? crypto.randomUUID();
    this.maxProcesses = options.maxProcesses ?? MAX_MANAGED_PROCESSES;
    this.pipeFactory = options.pipeFactory ?? { create: createPipeProcessAdapter };
    this.ptyFactory = options.ptyFactory ?? { create: createPtyProcessAdapter };
    this.sessionIdFactory =
      options.sessionIdFactory ??
      ((generation, sequence) => `proc_${generation}_${crypto.randomUUID()}_${sequence}`);
  }

  get size(): number {
    return this.entries.size;
  }

  async start(request: ManagedProcessStartRequest): Promise<RuntimeExecResult> {
    const activeCount = [...this.entries.values()].filter(
      (entry) => !isManagedProcessTerminal(entry.state),
    ).length;
    if (activeCount >= this.maxProcesses) throw new RuntimeExecError("PROCESS_LIMIT_REACHED");
    const factory = request.tty ? this.ptyFactory : this.pipeFactory;
    const adapter = await factory.create({
      launch: request.launch,
      cwd: request.cwd,
      env: request.env,
      tty: request.tty,
    });
    const sequence = ++this.sequence;
    const id = this.sessionIdFactory(this.runtimeGenerationId, sequence);
    const entry: ProcessEntry = {
      id,
      ownerRunId: request.ownerRunId,
      adapter,
      tty: request.tty,
      startedAtMs: Date.now(),
      output: new HeadTailOutputBuffer(MAX_PROCESS_BUFFER_BYTES),
      state: "STARTING",
      exitCode: undefined,
      signal: undefined,
      totalOutputBytes: 0,
      totalOmittedBytes: 0,
      waiters: new Set(),
    };
    this.entries.set(id, entry);
    if (request.signal?.aborted) await this.cancelOwnedByRun(request.ownerRunId);
    adapter.onStart(() => {
      if (entry.state === "STARTING") entry.state = "RUNNING";
    });
    adapter.onOutput(({ text }) => {
      entry.output.append(text);
      entry.totalOutputBytes += Buffer.byteLength(text, "utf8");
      this.notify(entry);
    });
    adapter.onError((error) => {
      if (entry.state === "STARTING") {
        entry.state = "FAILED";
        entry.error = new RuntimeExecError("SPAWN_FAILED", { cause: error });
      } else if (!isManagedProcessTerminal(entry.state)) {
        entry.state = "FAILED";
        entry.error = new RuntimeProcessUncertainError();
      }
      this.notify(entry);
    });
    adapter.onExit(({ exitCode, signal }) => {
      entry.state = "EXITED";
      entry.exitCode = exitCode;
      if (entry.signal !== "KILLED") entry.signal = signal;
      this.notify(entry);
    });
    const removeLiveOutput = attachLiveOutput(adapter, request.onOutput);
    try {
      await this.waitForYield(
        entry,
        request.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS,
        request.signal,
      );
      return this.resultAndMaybeRemove(entry);
    } finally {
      removeLiveOutput?.();
    }
  }

  async interact(request: RuntimeProcessInteractionRequest): Promise<RuntimeExecResult> {
    const entry = this.lookup(request.sessionId, request.ownerRunId);
    const charsAcceptedBytes = Buffer.byteLength(request.chars, "utf8");
    const removeLiveOutput = attachLiveOutput(entry.adapter, request.onOutput);
    try {
      if (request.chars.length > 0) {
        if (entry.state === "EXITED") throw new RuntimeExecError("STDIN_UNAVAILABLE");
        try {
          await entry.adapter.write(request.chars);
        } catch {
          if ((entry as ProcessEntry).state === "EXITED")
            throw new RuntimeExecError("STDIN_UNAVAILABLE");
          throw new RuntimeProcessUncertainError();
        }
      }
      await this.waitForYield(entry, request.yieldTimeMs, request.signal);
      return this.resultAndMaybeRemove(entry, charsAcceptedBytes);
    } finally {
      removeLiveOutput?.();
    }
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.adapter.close()));
  }

  /**
   * Terminate exactly one managed session this Run owns.
   *
   * ```text
   * lookup(sessionId, ownerRunId)     the ownership authority; a foreign session is not-found
   * adapter.close()                   the actual termination
   * adapter exit observation          the proof that the process really ended
   * ```
   *
   * ## One session, never a run-wide sweep
   *
   * `cancelOwnedByRun` stops *every* process the Run owns, which is the right answer when a Run is
   * being cancelled and the wrong one when a model asks to stop the dev server it just started. This
   * method therefore never touches a sibling session: stopping session A leaves session B running.
   *
   * ## The outcome is proven, not assumed
   *
   * `close()` is only a request to terminate. The method waits for the adapter's own exit
   * observation before it reports `EXITED / KILLED`, so a caller that reads the result knows the OS
   * process ended rather than merely that a signal was sent. If termination cannot be confirmed
   * within the bound, the answer is `RuntimeProcessUncertainError` — deliberately *not* a plain
   * failure the model would be invited to retry, because a retry cannot make an unknown outcome
   * known.
   *
   * A session that is already terminal, that never existed, or that belongs to another Run all fail
   * as `PROCESS_SESSION_NOT_FOUND`: a foreign session's owner is never disclosed.
   */
  async terminateOwnedSession(
    request: RuntimeProcessTerminationRequest,
  ): Promise<RuntimeExecResult> {
    const entry = this.lookup(request.sessionId, request.ownerRunId);
    const snapshot = entry.output.drain();
    entry.totalOmittedBytes += snapshot.omittedBytes;
    if (isManagedProcessTerminal(entry.state)) {
      this.entries.delete(entry.id);
      throw new RuntimeExecError("PROCESS_SESSION_NOT_FOUND");
    }
    const confirmation = awaitAdapterExit(entry.adapter);
    try {
      await entry.adapter.close();
    } catch {
      throw new RuntimeProcessUncertainError();
    }
    if (!(await confirmation)) throw new RuntimeProcessUncertainError();
    entry.state = "EXITED";
    entry.signal = "KILLED";
    this.entries.delete(entry.id);
    this.notify(entry);
    return {
      status: "EXITED",
      output: snapshot.text,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      signal: "KILLED",
      totalOutputBytes: entry.totalOutputBytes,
      omittedBytes: entry.totalOmittedBytes,
      tty: entry.tty,
      durationMs: Math.max(0, Date.now() - entry.startedAtMs),
    };
  }

  async cancelOwnedByRun(ownerRunId: RunId): Promise<{
    readonly runId: RunId;
    readonly stoppedProcessIds: readonly string[];
    readonly confirmed: boolean;
  }> {
    const owned = [...this.entries.values()].filter((entry) => entry.ownerRunId === ownerRunId);
    const active = owned.filter((entry) => !isManagedProcessTerminal(entry.state));
    for (const entry of owned) {
      if (isManagedProcessTerminal(entry.state)) this.entries.delete(entry.id);
    }
    let confirmed = true;
    await Promise.all(
      active.map(async (entry) => {
        entry.state = "EXITED";
        entry.signal = "KILLED";
        this.entries.delete(entry.id);
        this.notify(entry);
        try {
          await entry.adapter.close();
        } catch {
          confirmed = false;
        }
      }),
    );
    return {
      runId: ownerRunId,
      stoppedProcessIds: active.map((entry) => entry.id),
      confirmed:
        confirmed &&
        ![...this.entries.values()].some(
          (entry) => entry.ownerRunId === ownerRunId && !isManagedProcessTerminal(entry.state),
        ),
    };
  }

  private lookup(
    sessionId: string,
    ownerRunId: ManagedProcessStartRequest["ownerRunId"],
  ): ProcessEntry {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      if (
        sessionId.startsWith("proc_") &&
        !sessionId.startsWith(`proc_${this.runtimeGenerationId}_`)
      ) {
        throw new RuntimeProcessStaleSessionError();
      }
      throw new RuntimeExecError("PROCESS_SESSION_NOT_FOUND");
    }
    if (entry.ownerRunId !== ownerRunId) throw new RuntimeExecError("PROCESS_SESSION_NOT_FOUND");
    return entry;
  }

  private waitForYield(
    entry: ProcessEntry,
    yieldTimeMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (isManagedProcessTerminal(entry.state)) return Promise.resolve();
    return new Promise((resolve) => {
      let abortListener: (() => void) | undefined;
      const finish = () => {
        clearTimeout(timer);
        if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
        entry.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, yieldTimeMs);
      entry.waiters.add(finish);
      if (signal !== undefined) {
        abortListener = () => {
          void this.cancelOwnedByRun(entry.ownerRunId).finally(finish);
        };
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      }
    });
  }

  private notify(entry: ProcessEntry): void {
    if (!isManagedProcessTerminal(entry.state)) return;
    for (const waiter of [...entry.waiters]) waiter();
  }

  private resultAndMaybeRemove(
    entry: ProcessEntry,
    charsAcceptedBytes?: number,
  ): RuntimeExecResult {
    const snapshot = entry.output.drain();
    entry.totalOmittedBytes += snapshot.omittedBytes;
    if (entry.error !== undefined) {
      this.entries.delete(entry.id);
      throw entry.error;
    }
    const result: RuntimeExecResult = {
      status: entry.state === "EXITED" ? "EXITED" : "RUNNING",
      ...(entry.state === "RUNNING" ? { sessionId: entry.id } : {}),
      output: snapshot.text,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      ...(entry.signal === undefined ? {} : { signal: entry.signal }),
      totalOutputBytes: entry.totalOutputBytes,
      omittedBytes: entry.totalOmittedBytes,
      tty: entry.tty,
      durationMs: Math.max(0, Date.now() - entry.startedAtMs),
      ...(charsAcceptedBytes === undefined ? {} : { charsAcceptedBytes }),
    };
    if (entry.state === "EXITED") this.entries.delete(entry.id);
    return result;
  }
}

function attachLiveOutput(
  adapter: ManagedProcessAdapter,
  listener: ((event: import("./contracts.js").ProcessOutputEvent) => void) | undefined,
): (() => void) | undefined {
  if (listener === undefined) return undefined;
  return adapter.onOutput((event) => {
    try {
      listener(event);
    } catch {
      // Presentation observers are not allowed to change Runtime execution semantics.
    }
  });
}

/**
 * How long a termination waits for the adapter to observe the process exit.
 *
 * This is not a yield and not a timeout on the *request*: it bounds how long the Runtime will keep a
 * termination unresolved before it stops pretending it can prove an outcome. Ten seconds is far
 * beyond a local `close()` on any supported platform, so the only way to reach it is a process that
 * genuinely refused to die — which is exactly the case that must not be reported as success.
 */
const TERMINATION_CONFIRMATION_TIMEOUT_MS = 10_000;

/**
 * Resolve `true` when the adapter observes the managed process exit, `false` when the bound expires.
 *
 * The subscription is taken before `close()` is called, and `onExit` replays an exit that already
 * happened, so the wait never races the termination it is confirming.
 */
function awaitAdapterExit(adapter: ManagedProcessAdapter): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const resources: {
      timer?: ReturnType<typeof setTimeout>;
      unsubscribe?: () => void;
    } = {};
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      if (resources.timer !== undefined) clearTimeout(resources.timer);
      resources.unsubscribe?.();
      resolve(confirmed);
    };
    resources.timer = setTimeout(() => finish(false), TERMINATION_CONFIRMATION_TIMEOUT_MS);
    const unsubscribe = adapter.onExit(() => finish(true));
    resources.unsubscribe = unsubscribe;
    if (settled) unsubscribe();
  });
}
