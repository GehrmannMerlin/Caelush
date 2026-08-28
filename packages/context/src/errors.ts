export class ContextError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ContextInvalidWorkspaceError extends ContextError {
  constructor(message: string, options?: ErrorOptions) {
    super("INVALID_WORKSPACE", message, options);
  }
}

export class ContextBoundaryError extends ContextError {
  constructor(message: string, options?: ErrorOptions) {
    super("WORKSPACE_BOUNDARY", message, options);
  }
}

export class ContextInstructionError extends ContextError {
  constructor(message: string, options?: ErrorOptions) {
    super("INSTRUCTION_READ_FAILURE", message, options);
  }
}

export class ContextIOError extends ContextError {
  constructor(message: string, options?: ErrorOptions) {
    super("FILESYSTEM_IO", message, options);
  }
}

export class ContextIgnoreError extends ContextError {
  constructor(message: string, options?: ErrorOptions) {
    super("IGNORE_POLICY_FAILURE", message, options);
  }
}

export class ContextDiscoveryError extends ContextError {
  constructor(message: string, options?: ErrorOptions) {
    super("DISCOVERY_FAILURE", message, options);
  }
}
