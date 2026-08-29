import type { JsonObject, RunId, StepId, ToolInvocationId } from "@caelush/protocol";
import type { ToolExecutionResult } from "./execution-result.js";

export interface ToolExecutionRequest {
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly invocationId: ToolInvocationId;
  readonly externalCallId: string;
  readonly args: Readonly<JsonObject>;
}

export interface ToolHandler {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}
