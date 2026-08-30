import type { JsonObject } from "@caelush/protocol";
import type {
  ToolExecutionResult,
  ToolResultSanitizerPort,
} from "@caelush/tools";
import { redactJson, redactText } from "./secret-redaction.js";

export class CaelushToolResultSanitizer implements ToolResultSanitizerPort {
  sanitize(input: {
    readonly toolName: import("@caelush/protocol").ToolName;
    readonly result: ToolExecutionResult;
    readonly invocation: import("@caelush/protocol").ToolInvocation;
  }): ToolExecutionResult {
    void input.toolName;
    void input.invocation;
    return {
      content: redactText(input.result.content),
      details: redactJson(input.result.details) as JsonObject,
      isError: input.result.isError,
    };
  }
}

export function sanitizeToolResult(
  input: Parameters<ToolResultSanitizerPort["sanitize"]>[0],
): ToolExecutionResult {
  return new CaelushToolResultSanitizer().sanitize(input);
}
