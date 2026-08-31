export type RuntimeErrorCode =
  | "UNSUPPORTED_RUNTIME"
  | "WORKSPACE_ERROR"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PATH_NOT_FOUND"
  | "SYMLINK_MUTATION_NOT_ALLOWED"
  | "PATH_TYPE_ERROR"
  | "BINARY_FILE"
  | "INVALID_UTF8"
  | "FILE_READ_FAILED"
  | "INVALID_RANGE"
  | "INVALID_PATTERN"
  | "DISCOVERY_ERROR"
  | "SEARCH_UNAVAILABLE"
  | "SEARCH_ERROR"
  | "RUNTIME_INVARIANT"
  | "INVALID_PATCH"
  | "EMPTY_PATCH"
  | "PATCH_TOO_LARGE"
  | "TOO_MANY_FILES"
  | "TOO_MANY_HUNKS"
  | "PATH_NOT_FOUND"
  | "NOT_A_REGULAR_FILE"
  | "TARGET_ALREADY_EXISTS"
  | "MOVE_DESTINATION_EXISTS"
  | "FILE_TOO_LARGE_FOR_PATCH"
  | "PATCH_CONTEXT_MISMATCH"
  | "PATCH_CONTEXT_AMBIGUOUS"
  | "PATCH_CONFLICT"
  | "PATCH_STALE"
  | "HASH_GUARD_MISMATCH"
  | "PATCH_BUDGET_EXCEEDED"
  | "PATCH_COMMIT_FAILED_ROLLED_BACK"
  | "PATCH_UNCERTAIN"
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
  | "PROCESS_UNCERTAIN"
  | "NOT_A_GIT_REPOSITORY"
  | "GIT_UNAVAILABLE"
  | "INVALID_GIT_PATH"
  | "INVALID_GIT_SCOPE"
  | "GIT_COMMAND_FAILED"
  | "GIT_UNSUPPORTED_PATH_ENCODING";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class RuntimeUnsupportedError extends RuntimeError {
  constructor(message = "The requested runtime is not supported.") {
    super("UNSUPPORTED_RUNTIME", message);
  }
}

export class RuntimeWorkspaceError extends RuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("WORKSPACE_ERROR", message, options);
  }
}

export class RuntimeBoundaryError extends RuntimeError {
  constructor(message: string) {
    super("PATH_OUTSIDE_WORKSPACE", message);
  }
}

export class RuntimePathNotFoundError extends RuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("PATH_NOT_FOUND", message, options);
  }
}

export class RuntimePathTypeError extends RuntimeError {
  constructor(message: string) {
    super("PATH_TYPE_ERROR", message);
  }
}

export class RuntimeBinaryFileError extends RuntimeError {
  constructor(message: string) {
    super("BINARY_FILE", message);
  }
}

export class RuntimeInvalidUtf8Error extends RuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_UTF8", message, options);
  }
}

export class RuntimeFileReadError extends RuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("FILE_READ_FAILED", message, options);
  }
}

export class RuntimeInvalidRangeError extends RuntimeError {
  constructor(message: string) {
    super("INVALID_RANGE", message);
  }
}

export class RuntimeInvalidPatternError extends RuntimeError {
  constructor(message: string) {
    super("INVALID_PATTERN", message);
  }
}

export class RuntimeDiscoveryError extends RuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("DISCOVERY_ERROR", message, options);
  }
}

export class RuntimeSearchUnavailableError extends RuntimeError {
  constructor(message = "The ripgrep executable is unavailable.", options?: ErrorOptions) {
    super("SEARCH_UNAVAILABLE", message, options);
  }
}

export class RuntimeSearchError extends RuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("SEARCH_ERROR", message, options);
  }
}

export class RuntimeInvariantError extends RuntimeError {
  constructor(message: string) {
    super("RUNTIME_INVARIANT", message);
  }
}

export type RuntimeGitErrorCode =
  | "NOT_A_GIT_REPOSITORY"
  | "GIT_UNAVAILABLE"
  | "INVALID_GIT_PATH"
  | "INVALID_GIT_SCOPE"
  | "GIT_COMMAND_FAILED"
  | "GIT_UNSUPPORTED_PATH_ENCODING";

export class RuntimeGitError extends RuntimeError {
  constructor(code: RuntimeGitErrorCode, message = `Git operation failed: ${code}.`) {
    super(code, message);
  }
}
