import type { ToolInvocation } from "@caelush/protocol";
import type { ToolExecutionResult } from "./execution-result.js";

export interface ToolInvocationPresentation {
  readonly title: string;
  readonly summary: string;
}

export interface ToolResultPresentation {
  readonly title: string;
  readonly summary: string;
  readonly output?: {
    readonly stream: "stdout" | "stderr";
    readonly chunk: string;
  };
}

export interface ToolPresentationPort {
  presentInvocation(input: { readonly invocation: ToolInvocation }): ToolInvocationPresentation;
  presentResult(input: {
    readonly invocation: ToolInvocation;
    readonly result?: ToolExecutionResult;
  }): ToolResultPresentation;
  presentShellCommand(input: { readonly invocation: ToolInvocation }): string;
}
