import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import path from "node:path";
import type { WorkspaceId } from "@caelush/protocol";
import type { DesktopWorkspaceAccess } from "../workspace/file-service.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_SESSIONS = 4;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_HELPER_MESSAGE_BYTES = 32 * 1024;
const MAX_OUTPUT_CHUNK_BYTES = 16 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 512 * 1024;
const MAX_IN_FLIGHT_OUTPUT_BYTES = 256 * 1024;
const HELPER_READY_TIMEOUT_MS = 10_000;
const TERMINAL_CLOSE_TIMEOUT_MS = 1_500;
const execFile = promisify(execFileCallback);

export type DesktopTerminalErrorCode =
  | "TERMINAL_SESSION_INVALID"
  | "TERMINAL_INPUT_TOO_LARGE"
  | "TERMINAL_RESIZE_INVALID"
  | "TERMINAL_LIMIT_REACHED"
  | "TERMINAL_START_FAILED"
  | "TERMINAL_OUTPUT_BACKPRESSURE"
  | "TERMINAL_UNAVAILABLE"
  | "TERMINAL_CLEANUP_PENDING";

export class DesktopTerminalError extends Error {
  constructor(
    readonly code: DesktopTerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesktopTerminalError";
  }
}

export interface DesktopTerminalHelperSpawnInput {
  readonly nodeExecutablePath: string;
  readonly helperPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface DesktopTerminalChild {
  readonly pid?: number;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface DesktopTerminalOutput {
  readonly terminalId: string;
  readonly data?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly errorCode?: "TERMINAL_OUTPUT_BACKPRESSURE" | "TERMINAL_UNAVAILABLE";
}

export interface DesktopUserTerminalManagerOptions {
  readonly authorizeWorkspace: (
    workspaceId: WorkspaceId,
    signal?: AbortSignal,
  ) => Promise<DesktopWorkspaceAccess>;
  readonly nodeExecutablePath: string;
  readonly helperPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnHelper?: (input: DesktopTerminalHelperSpawnInput) => DesktopTerminalChild;
  readonly sendOutput: (ownerId: number, output: DesktopTerminalOutput) => void;
  readonly killProcessTree?: (pid: number) => Promise<void>;
  readonly isCurrentIdentity?: (
    identity: Pick<DesktopWorkspaceAccess, "userId" | "profileId" | "generationId">,
  ) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly closeTimeoutMs?: number;
}

export interface DesktopTerminalSession {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly identity: "USER_TERMINAL";
  readonly shell: "WINDOWS_POWERSHELL";
  readonly cols: number;
  readonly rows: number;
}

interface ActiveSession {
  readonly ownerId: number;
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly access: DesktopWorkspaceAccess;
  readonly child: DesktopTerminalChild;
  readonly ready: Promise<void>;
  readonly output: string[];
  readonly listeners: Array<() => void>;
  pendingOutputBytes: number;
  inFlightOutputBytes: number;
  stdoutBuffer: string;
  subscribed: boolean;
  closing: boolean;
  helperExited: boolean;
  ptyExited: boolean;
  readyResolved: boolean;
  closePromise?: Promise<void>;
}

export class DesktopUserTerminalManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly activeWorkspaces = new Map<number, string>();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: DesktopUserTerminalManagerOptions) {
    this.platform = options.platform ?? process.platform;
  }

  async activateWorkspace(ownerId: number, workspaceId: WorkspaceId): Promise<void> {
    const access = await this.options.authorizeWorkspace(workspaceId);
    this.activeWorkspaces.set(ownerId, access.workspaceId);
    const oldSessions = [...this.sessions.values()].filter(
      (session) => session.ownerId === ownerId && session.workspaceId !== access.workspaceId,
    );
    for (const session of oldSessions) await this.closeSession(session);
  }

  async clearWorkspace(ownerId: number): Promise<void> {
    this.activeWorkspaces.delete(ownerId);
    const sessions = [...this.sessions.values()].filter((session) => session.ownerId === ownerId);
    for (const session of sessions) await this.closeSession(session);
  }

  async create(input: {
    readonly ownerId: number;
    readonly workspaceId: WorkspaceId;
    readonly cols: number;
    readonly rows: number;
    readonly signal?: AbortSignal;
  }): Promise<DesktopTerminalSession> {
    assertTerminalSize(input.cols, input.rows);
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new DesktopTerminalError(
        "TERMINAL_LIMIT_REACHED",
        "Close a terminal before opening another one.",
      );
    }
    if (this.activeWorkspaces.get(input.ownerId) !== input.workspaceId) {
      throw new DesktopTerminalError(
        "TERMINAL_SESSION_INVALID",
        "Select this Workspace before opening its terminal.",
      );
    }
    const access = await this.options.authorizeWorkspace(input.workspaceId, input.signal);
    this.assertCurrent(access);
    const terminalId = randomBytes(32).toString("base64url");
    const child = (this.options.spawnHelper ?? spawnHelper)({
      nodeExecutablePath: this.options.nodeExecutablePath,
      helperPath: this.options.helperPath,
      cwd: access.rootPath,
      env: createUserTerminalEnvironment(this.options.environment ?? process.env, this.platform),
    });
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) < 1) {
      child.kill("SIGTERM");
      throw new DesktopTerminalError(
        "TERMINAL_START_FAILED",
        "The user terminal could not be started.",
      );
    }
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const session: ActiveSession = {
      ownerId: input.ownerId,
      terminalId,
      workspaceId: input.workspaceId,
      access,
      child,
      ready,
      output: [],
      listeners: [],
      pendingOutputBytes: 0,
      inFlightOutputBytes: 0,
      stdoutBuffer: "",
      subscribed: false,
      closing: false,
      helperExited: false,
      ptyExited: false,
      readyResolved: false,
    };
    this.sessions.set(terminalId, session);
    this.bindChild(session, resolveReady, rejectReady);
    this.writeControl(session, {
      type: "start",
      terminalId,
      cwd: access.rootPath,
      shell: "WINDOWS_POWERSHELL",
      cols: input.cols,
      rows: input.rows,
    });
    try {
      await Promise.race([
        ready,
        delay(this.options.closeTimeoutMs ?? HELPER_READY_TIMEOUT_MS).then(() => {
          throw new DesktopTerminalError(
            "TERMINAL_START_FAILED",
            "The user terminal did not become ready.",
          );
        }),
      ]);
      this.assertCurrent(access);
      return {
        terminalId,
        workspaceId: input.workspaceId,
        cwd: access.rootPath,
        identity: "USER_TERMINAL",
        shell: "WINDOWS_POWERSHELL",
        cols: input.cols,
        rows: input.rows,
      };
    } catch (error) {
      await this.closeSession(session).catch(() => undefined);
      if (error instanceof DesktopTerminalError) throw error;
      throw new DesktopTerminalError(
        "TERMINAL_START_FAILED",
        "The user terminal could not be started.",
      );
    }
  }

  write(ownerId: number, terminalId: string, data: string): void {
    const session = this.requireSession(ownerId, terminalId);
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
      throw new DesktopTerminalError(
        "TERMINAL_INPUT_TOO_LARGE",
        "Terminal input exceeds its size limit.",
      );
    }
    this.writeControl(session, { type: "write", data });
  }

  resize(
    ownerId: number,
    terminalId: string,
    size: { readonly cols: number; readonly rows: number },
  ): void {
    const session = this.requireSession(ownerId, terminalId);
    assertTerminalSize(size.cols, size.rows);
    this.writeControl(session, { type: "resize", cols: size.cols, rows: size.rows });
  }

  subscribeOutput(ownerId: number, terminalId: string): void {
    const session = this.requireSession(ownerId, terminalId);
    session.subscribed = true;
    this.flushOutput(session);
  }

  unsubscribeOutput(ownerId: number, terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (session === undefined || session.ownerId !== ownerId) return;
    session.subscribed = false;
  }

  acknowledgeOutput(ownerId: number, terminalId: string, bytes: number): void {
    const session = this.sessions.get(terminalId);
    if (
      session === undefined ||
      session.ownerId !== ownerId ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > session.inFlightOutputBytes
    ) {
      return;
    }
    session.inFlightOutputBytes -= bytes;
    this.flushOutput(session);
  }

  async close(ownerId: number, terminalId: string): Promise<void> {
    const session = this.requireSession(ownerId, terminalId);
    await this.closeSession(session);
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    const outcomes = await Promise.allSettled(
      sessions.map((session) => this.closeSession(session)),
    );
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      throw new DesktopTerminalError(
        "TERMINAL_CLEANUP_PENDING",
        "A user terminal process did not stop safely.",
      );
    }
    this.activeWorkspaces.clear();
  }

  closeForIdentity(
    identity: Pick<DesktopWorkspaceAccess, "userId" | "profileId" | "generationId"> | null,
  ): Promise<void> {
    const stale = [...this.sessions.values()].filter(
      (session) => identity === null || !sameIdentity(session.access, identity),
    );
    return Promise.all(stale.map((session) => this.closeSession(session))).then(() => undefined);
  }

  private bindChild(
    session: ActiveSession,
    resolveReady: () => void,
    rejectReady: (error: Error) => void,
  ): void {
    let stderrBytes = 0;
    let stderrBuffer = "";
    const dataListener = (chunk: Buffer | string) => {
      session.stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (Buffer.byteLength(session.stdoutBuffer, "utf8") > MAX_HELPER_MESSAGE_BYTES) {
        void this.failSession(session, "TERMINAL_UNAVAILABLE");
        rejectReady(
          new DesktopTerminalError("TERMINAL_START_FAILED", "The user terminal helper failed."),
        );
        return;
      }
      while (true) {
        const newline = session.stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = session.stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
        session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
        this.handleHelperMessage(session, line, resolveReady, rejectReady);
      }
    };
    const stderrListener = (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes <= 4096)
        stderrBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    };
    const errorListener = () => {
      rejectReady(
        new DesktopTerminalError("TERMINAL_START_FAILED", "The user terminal helper failed."),
      );
      void this.failSession(session, "TERMINAL_UNAVAILABLE");
    };
    const exitListener = (code: number | null, signal: NodeJS.Signals | null) => {
      session.helperExited = true;
      if (!session.closing) {
        this.options.sendOutput(session.ownerId, {
          terminalId: session.terminalId,
          exitCode: code,
          signal,
          ...(stderrBuffer.length > 0 ? { errorCode: "TERMINAL_UNAVAILABLE" as const } : {}),
        });
      }
      if (!session.readyResolved && !session.ptyExited) {
        rejectReady(
          new DesktopTerminalError("TERMINAL_START_FAILED", "The user terminal helper failed."),
        );
      }
      this.removeSession(session);
    };
    session.child.stdout.on("data", dataListener as never);
    session.child.stderr.on("data", stderrListener as never);
    session.child.on("error", errorListener);
    session.child.on("exit", exitListener);
    session.listeners.push(
      () => session.child.stdout.removeListener("data", dataListener as never),
      () => session.child.stderr.removeListener("data", stderrListener as never),
      () => session.child.removeListener("error", errorListener),
      () => session.child.removeListener("exit", exitListener),
    );
  }

  private handleHelperMessage(
    session: ActiveSession,
    line: string,
    resolveReady: () => void,
    rejectReady: (error: Error) => void,
  ): void {
    if (Buffer.byteLength(line, "utf8") > MAX_HELPER_MESSAGE_BYTES) {
      void this.failSession(session, "TERMINAL_UNAVAILABLE");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      void this.failSession(session, "TERMINAL_UNAVAILABLE");
      return;
    }
    if (!isObject(message) || typeof message.type !== "string") {
      void this.failSession(session, "TERMINAL_UNAVAILABLE");
      return;
    }
    if (message.type === "ready") {
      session.readyResolved = true;
      resolveReady();
      return;
    }
    if (message.type === "output" && typeof message.data === "string") {
      this.queueOutput(session, message.data);
      return;
    }
    if (
      message.type === "exit" &&
      (message.exitCode === null || Number.isInteger(message.exitCode)) &&
      (message.signal === null || typeof message.signal === "string")
    ) {
      session.ptyExited = true;
      if (!session.closing) {
        this.options.sendOutput(session.ownerId, {
          terminalId: session.terminalId,
          exitCode: message.exitCode as number | null,
          signal: message.signal as string | null,
        });
      }
      return;
    }
    if (message.type === "error") {
      rejectReady(
        new DesktopTerminalError("TERMINAL_START_FAILED", "The user terminal helper failed."),
      );
      void this.failSession(session, "TERMINAL_UNAVAILABLE");
      return;
    }
    void this.failSession(session, "TERMINAL_UNAVAILABLE");
  }

  private queueOutput(session: ActiveSession, value: string): void {
    if (this.sessions.get(session.terminalId) !== session || session.closing) return;
    const chunks = splitOutput(value);
    for (const chunk of chunks) {
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (
        session.pendingOutputBytes + session.inFlightOutputBytes + bytes >
        MAX_PENDING_OUTPUT_BYTES
      ) {
        void this.failSession(session, "TERMINAL_OUTPUT_BACKPRESSURE");
        return;
      }
      session.output.push(chunk);
      session.pendingOutputBytes += bytes;
    }
    this.flushOutput(session);
  }

  private flushOutput(session: ActiveSession): void {
    if (!session.subscribed || session.closing || !this.isSessionCurrent(session)) return;
    while (session.output.length > 0 && session.inFlightOutputBytes < MAX_IN_FLIGHT_OUTPUT_BYTES) {
      const data = session.output.shift()!;
      const bytes = Buffer.byteLength(data, "utf8");
      session.pendingOutputBytes -= bytes;
      session.inFlightOutputBytes += bytes;
      try {
        this.options.sendOutput(session.ownerId, { terminalId: session.terminalId, data });
      } catch {
        void this.failSession(session, "TERMINAL_UNAVAILABLE");
        return;
      }
    }
  }

  private async failSession(
    session: ActiveSession,
    errorCode: "TERMINAL_OUTPUT_BACKPRESSURE" | "TERMINAL_UNAVAILABLE",
  ): Promise<void> {
    if (this.sessions.get(session.terminalId) !== session || session.closing) return;
    this.options.sendOutput(session.ownerId, { terminalId: session.terminalId, errorCode });
    await this.closeSession(session).catch(() => undefined);
  }

  private requireSession(ownerId: number, terminalId: string): ActiveSession {
    const session = this.sessions.get(terminalId);
    if (
      session === undefined ||
      session.ownerId !== ownerId ||
      !SESSION_ID_PATTERN.test(terminalId) ||
      session.closing ||
      session.ptyExited ||
      !this.isSessionCurrent(session)
    ) {
      throw new DesktopTerminalError(
        "TERMINAL_SESSION_INVALID",
        "The user terminal session is unavailable.",
      );
    }
    return session;
  }

  private isSessionCurrent(session: ActiveSession): boolean {
    return (
      this.activeWorkspaces.get(session.ownerId) === session.workspaceId &&
      !session.access.signal.aborted &&
      (this.options.isCurrentIdentity?.(session.access) ?? true)
    );
  }

  private assertCurrent(access: DesktopWorkspaceAccess): void {
    if (access.signal.aborted || (this.options.isCurrentIdentity?.(access) ?? true) === false) {
      throw new DesktopTerminalError(
        "TERMINAL_SESSION_INVALID",
        "The active Desktop Profile changed.",
      );
    }
  }

  private writeControl(session: ActiveSession, value: Readonly<Record<string, unknown>>): void {
    const encoded = `${JSON.stringify(value)}\n`;
    if (
      Buffer.byteLength(encoded, "utf8") > MAX_HELPER_MESSAGE_BYTES ||
      session.child.stdin.write(encoded) === false
    ) {
      // A full helper pipe is treated as a failed session, never as an unbounded queue.
      void this.failSession(session, "TERMINAL_OUTPUT_BACKPRESSURE");
    }
  }

  private closeSession(session: ActiveSession): Promise<void> {
    if (session.closePromise !== undefined) return session.closePromise;
    const operation = this.performCloseSession(session);
    session.closePromise = operation;
    return operation.finally(() => {
      if (session.closePromise === operation) delete session.closePromise;
    });
  }

  private async performCloseSession(session: ActiveSession): Promise<void> {
    if (session.closing) return;
    session.closing = true;
    session.subscribed = false;
    if (this.sessions.get(session.terminalId) === session) this.sessions.delete(session.terminalId);
    if (session.helperExited) {
      this.removeSession(session);
      return;
    }
    try {
      session.child.stdin.write('{"type":"close"}\n');
    } catch {
      // The fallback below owns the process tree cleanup.
    }
    const exited = await waitForSessionExit(
      session,
      this.options.closeTimeoutMs ?? TERMINAL_CLOSE_TIMEOUT_MS,
    );
    if (!exited) {
      try {
        if (session.child.pid === undefined) throw new Error("PID unavailable");
        if (this.options.killProcessTree !== undefined) {
          await this.options.killProcessTree(session.child.pid);
        } else if (this.platform === "win32") {
          await killWindowsProcessTree(session.child.pid, this.options.environment ?? process.env);
        } else {
          session.child.kill("SIGTERM");
        }
      } catch {
        if (session.helperExited) {
          this.removeSession(session);
          return;
        }
        session.closing = false;
        this.sessions.set(session.terminalId, session);
        throw new DesktopTerminalError(
          "TERMINAL_CLEANUP_PENDING",
          "The user terminal process tree could not be stopped safely.",
        );
      }
      const killed = await waitForSessionExit(session, 2000);
      if (!killed) {
        session.closing = false;
        this.sessions.set(session.terminalId, session);
        throw new DesktopTerminalError(
          "TERMINAL_CLEANUP_PENDING",
          "The user terminal process tree did not exit.",
        );
      }
    }
    this.removeSession(session);
  }

  private removeSession(session: ActiveSession): void {
    this.sessions.delete(session.terminalId);
    for (const removeListener of session.listeners.splice(0)) removeListener();
  }
}

export function createUserTerminalEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const excluded =
    /^(?:CAELUSH_|NODE_OPTIONS$|NODE_PATH$)|(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY|AUTH|COOKIE)/iu;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || excluded.test(name)) continue;
    result[name] = value;
  }
  if (platform === "win32") {
    const windowsDirectory = source.SystemRoot ?? "C:\\Windows";
    result.SystemRoot = windowsDirectory;
    result.WINDIR = windowsDirectory;
    result.COMSPEC ??= `${windowsDirectory}\\System32\\cmd.exe`;
    result.TEMP ??= source.TMP ?? "C:\\Windows\\Temp";
    result.TMP ??= result.TEMP;
    result.PATH ??= `${windowsDirectory}\\System32`;
  }
  return result;
}

async function killWindowsProcessTree(pid: number, environment: NodeJS.ProcessEnv): Promise<void> {
  const systemRoot = environment.SystemRoot ?? "C:\\Windows";
  await execFile(
    path.win32.join(systemRoot, "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 16 * 1024,
    },
  );
}

function spawnHelper(input: DesktopTerminalHelperSpawnInput): DesktopTerminalChild {
  return spawn(input.nodeExecutablePath, [input.helperPath], {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as DesktopTerminalChild;
}

function assertTerminalSize(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    cols < 20 ||
    cols > 500 ||
    !Number.isInteger(rows) ||
    rows < 5 ||
    rows > 300
  ) {
    throw new DesktopTerminalError(
      "TERMINAL_RESIZE_INVALID",
      "Terminal dimensions are outside the supported range.",
    );
  }
}

function splitOutput(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (currentBytes + characterBytes > MAX_OUTPUT_CHUNK_BYTES && current.length > 0) {
      result.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameIdentity(
  left: Pick<DesktopWorkspaceAccess, "userId" | "profileId" | "generationId">,
  right: Pick<DesktopWorkspaceAccess, "userId" | "profileId" | "generationId">,
): boolean {
  return (
    left.userId === right.userId &&
    left.profileId === right.profileId &&
    left.generationId === right.generationId
  );
}

function waitForSessionExit(session: ActiveSession, timeoutMs: number): Promise<boolean> {
  if (session.helperExited) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.child.removeListener("exit", listener);
      resolve(exited);
    };
    const listener = () => {
      session.helperExited = true;
      finish(true);
    };
    const timer = setTimeout(() => finish(session.helperExited), timeoutMs);
    session.child.on("exit", listener);
    if (session.helperExited) finish(true);
  });
}
