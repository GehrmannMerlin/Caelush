export class ToolBatchInputError extends Error {
  constructor(message = "Tool batch request is invalid.") {
    super(message);
    this.name = "ToolBatchInputError";
  }
}

export class ToolBatchInfrastructureError extends Error {
  constructor(
    message = "Tool batch execution infrastructure failed.",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ToolBatchInfrastructureError";
  }
}
