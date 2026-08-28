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

export class ContextBuildError extends ContextError {
  constructor(
    message: string,
    code:
      | "CONTEXT_BUILD_FAILURE"
      | "CONTEXT_BUDGET_EXCEEDED"
      | "CONTEXT_CONVERSATION_INVALID" = "CONTEXT_BUILD_FAILURE",
    options?: ErrorOptions,
  ) {
    super(code, message, options);
  }
}

export interface ContextBudgetBreakdown {
  readonly maxInputTokens: number;
  readonly safetyMarginTokens: number;
  readonly systemTokens: number;
  readonly currentUserTokens: number;
  readonly mandatoryTokens: number;
}

export class ContextBudgetExceededError extends ContextBuildError {
  readonly breakdown: ContextBudgetBreakdown;

  constructor(breakdown: ContextBudgetBreakdown, options?: ErrorOptions) {
    super(
      "context mandatory content exceeds the input token budget",
      "CONTEXT_BUDGET_EXCEEDED",
      options,
    );
    this.breakdown = breakdown;
  }
}

export class ContextConversationError extends ContextBuildError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "CONTEXT_CONVERSATION_INVALID", options);
  }
}
