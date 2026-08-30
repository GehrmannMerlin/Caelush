import type { JsonObject, RunId, StepId, ToolInvocationId } from "@caelush/protocol";
import type { ToolExecutionResult } from "./execution-result.js";
import type { ToolExecutionEnvironment } from "./execution-environment.js";

export interface ToolExecutionRequest {
  readonly signal?: AbortSignal;
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly invocationId: ToolInvocationId;
  readonly externalCallId: string;
  readonly args: Readonly<JsonObject>;
  readonly environment: ToolExecutionEnvironment;
}

export interface ToolHandler {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}
