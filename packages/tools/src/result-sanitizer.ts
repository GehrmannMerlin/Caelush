import type { ToolInvocation, ToolName } from "@caelush/protocol";
import type { ToolExecutionResult } from "./execution-result.js";

export interface ToolResultSanitizerPort {
  sanitize(input: {
    readonly toolName: ToolName;
    readonly result: ToolExecutionResult;
    readonly invocation: ToolInvocation;
  }): ToolExecutionResult;
}
