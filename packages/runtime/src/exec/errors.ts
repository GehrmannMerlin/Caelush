import { RuntimeError } from "../runtime-errors.js";

export type RuntimeExecErrorCode =
  | "INVALID_COMMAND"
  | "INVALID_ARGV"
  | "INVALID_YIELD_TIME"
  | "INVALID_STDIN"
  | "PROCESS_LIMIT_REACHED"
  | "SHELL_UNAVAILABLE"
  | "PTY_UNAVAILABLE"
  | "PROCESS_SESSION_NOT_FOUND"
  | "PROCESS_SESSION_STALE"
  | "SPAWN_FAILED"
  | "STDIN_UNAVAILABLE"
  | "PROCESS_UNCERTAIN";

export class RuntimeExecError extends RuntimeError {
  constructor(code: RuntimeExecErrorCode, options?: ErrorOptions) {
    super(code, code, options);
  }
}

export class RuntimeProcessStaleSessionError extends RuntimeExecError {
  constructor() {
    super("PROCESS_SESSION_STALE");
  }
}

export class RuntimeProcessUncertainError extends RuntimeExecError {
  constructor() {
    super("PROCESS_UNCERTAIN");
  }
}
