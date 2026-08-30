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
    await this.waitForYield(entry, request.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS, request.signal);
    return this.resultAndMaybeRemove(entry);
  }

  async interact(request: RuntimeProcessInteractionRequest): Promise<RuntimeExecResult> {
    const entry = this.lookup(request.sessionId, request.ownerRunId);
    const charsAcceptedBytes = Buffer.byteLength(request.chars, "utf8");
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
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.adapter.close()));
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
      confirmed: confirmed && ![...this.entries.values()].some(
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

  private waitForYield(entry: ProcessEntry, yieldTimeMs: number, signal?: AbortSignal): Promise<void> {
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
