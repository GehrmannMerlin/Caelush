import type { RunId } from "@caelush/protocol";

export class ToolDispatcherInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolDispatcherInputError";
  }
}

export class ToolDispatcherBusyError extends Error {
  constructor(runId: RunId) {
    super(`Tool call for Run ${runId} is already active.`);
    this.name = "ToolDispatcherBusyError";
  }
}

export class ToolDispatcherInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolDispatcherInfrastructureError";
  }
}

export class ToolDispatcherInvariantError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolDispatcherInvariantError";
  }
}
