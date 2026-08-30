import process from "node:process";
import { stat } from "node:fs/promises";
import type { WorkspacePathResolver } from "../workspace-path.js";
import {
  DEFAULT_EXEC_POLL_YIELD_TIME_MS,
  DEFAULT_EXEC_WRITE_YIELD_TIME_MS,
  DEFAULT_EXEC_YIELD_TIME_MS,
  MAX_EXEC_COMMAND_BYTES,
  MAX_EXEC_STDIN_BYTES,
  MAX_EXEC_YIELD_TIME_MS,
  MIN_EXEC_YIELD_TIME_MS,
  type RuntimeExecRequest,
  type RuntimeExecResult,
  type RuntimeExecService,
  type RuntimeProcessInteractionRequest,
} from "./contracts.js";
import { RuntimeExecError } from "./errors.js";
import { LocalProcessManager } from "./process-manager.js";
import { LocalShellResolver } from "./shell-resolver.js";
import { RuntimePathTypeError } from "../runtime-errors.js";
import { createAgentProcessEnvironment } from "./environment-policy.js";

export interface LocalRuntimeExecServiceOptions {
  readonly pathResolver: WorkspacePathResolver;
  readonly processManager: LocalProcessManager;
  readonly shellResolver?: LocalShellResolver;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export class LocalRuntimeExecService implements RuntimeExecService {
  private readonly shellResolver: LocalShellResolver;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: LocalRuntimeExecServiceOptions) {
    this.shellResolver = options.shellResolver ?? new LocalShellResolver();
    this.env = options.env ?? process.env;
  }

  async execute(request: RuntimeExecRequest): Promise<RuntimeExecResult> {
    validateCommand(request.command);
    const cwd = await this.resolveWorkdir(request.workdir);
    validateYield(request.yieldTimeMs);
    return this.options.processManager.start({
      ...request,
      cwd,
      env: executionEnvironment(
        createAgentProcessEnvironment(this.env, this.options.platform ?? process.platform),
        request.tty,
      ),
      launch: this.shellResolver.resolve(request.command),
    });
  }

  async interact(request: RuntimeProcessInteractionRequest): Promise<RuntimeExecResult> {
    if (Buffer.byteLength(request.chars, "utf8") > MAX_EXEC_STDIN_BYTES) {
      throw new RuntimeExecError("INVALID_STDIN");
    }
    validateYield(request.yieldTimeMs);
    return this.options.processManager.interact(request);
  }

  async cancelOwnedByRun(ownerRunId: RuntimeExecRequest["ownerRunId"]) {
    return this.options.processManager.cancelOwnedByRun(ownerRunId);
  }

  private async resolveWorkdir(workdir: string | undefined): Promise<string> {
    const resolved = await this.options.pathResolver.resolveExisting(workdir ?? ".");
    if (resolved.kind === "DIRECTORY") return resolved.realPath;
    if (resolved.kind === "SYMLINK") {
      try {
        if ((await stat(resolved.realPath)).isDirectory()) return resolved.realPath;
      } catch {
        throw new RuntimePathTypeError("exec workdir target is not a directory");
      }
    }
    throw new RuntimePathTypeError("exec workdir must be a directory");
  }
}

export function validateCommand(command: string): void {
  if (command.trim().length === 0 || Buffer.byteLength(command, "utf8") > MAX_EXEC_COMMAND_BYTES) {
    throw new RuntimeExecError("INVALID_COMMAND");
  }
}

export function validateYield(yieldTimeMs: number): void {
  if (
    !Number.isSafeInteger(yieldTimeMs) ||
    yieldTimeMs < MIN_EXEC_YIELD_TIME_MS ||
    yieldTimeMs > MAX_EXEC_YIELD_TIME_MS
  ) {
    throw new RuntimeExecError("INVALID_YIELD_TIME");
  }
}

export function resolveExecYield(value: unknown, fallback = DEFAULT_EXEC_YIELD_TIME_MS): number {
  const result = value === undefined ? fallback : value;
  validateYield(result as number);
  return result as number;
}

export function resolveInteractionYield(value: unknown, chars: string): number {
  const fallback =
    chars.length === 0 ? DEFAULT_EXEC_POLL_YIELD_TIME_MS : DEFAULT_EXEC_WRITE_YIELD_TIME_MS;
  return resolveExecYield(value, fallback);
}

function executionEnvironment(base: NodeJS.ProcessEnv, tty: boolean): NodeJS.ProcessEnv {
  return {
    ...base,
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    ...(tty ? { TERM: base.TERM ?? "xterm-256color" } : {}),
  };
}
