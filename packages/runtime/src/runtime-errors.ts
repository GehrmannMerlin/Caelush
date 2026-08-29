export type RuntimeErrorCode =
  | "UNSUPPORTED_RUNTIME"
  | "WORKSPACE_ERROR"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PATH_NOT_FOUND"
  | "PATH_TYPE_ERROR"
  | "BINARY_FILE"
  | "INVALID_UTF8"
  | "FILE_READ_FAILED"
  | "INVALID_RANGE"
  | "INVALID_PATTERN"
  | "DISCOVERY_ERROR"
  | "SEARCH_UNAVAILABLE"
  | "SEARCH_ERROR"
  | "RUNTIME_INVARIANT";

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
