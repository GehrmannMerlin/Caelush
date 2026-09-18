import type { ToolInvocation } from "@caelush/protocol";

import type { AgentToolResult } from "./tool-result.js";

/**
 * What a UI is told about one Tool invocation.
 *
 * ```text
 * presentInvocation   title and summary for a call that has begun
 * presentResult       title, summary and an optional bounded output preview
 * presentShellCommand the safe label used where a shell command would otherwise be shown
 * ```
 *
 * Presentation is a **projection**, never an input. It may not change Tool arguments, a Security
 * decision, an execution result or Run state, and it is never read back into the pipeline. A
 * projector that throws leaves the invocation running rather than altering it, which is why every
 * consumer of this port calls it defensively.
 *
 * The port lives in the Agent Tool Layer because it is a general boundary: the Coding overlay
 * supplies the implementation, the CLI/Web consume the durable and transient events it decorates.
 */
export interface ToolInvocationPresentation {
  readonly title: string;
  readonly summary: string;
}

export interface ToolResultPresentation {
  readonly title: string;
  readonly summary: string;
  readonly output?:
    | {
        readonly stream: "stdout" | "stderr";
        readonly chunk: string;
      }
    | undefined;
}

export interface ToolPresentationPort {
  presentInvocation(input: { readonly invocation: ToolInvocation }): ToolInvocationPresentation;
  presentResult(input: {
    readonly invocation: ToolInvocation;
    readonly result?: AgentToolResult | undefined;
  }): ToolResultPresentation;
  presentShellCommand(input: { readonly invocation: ToolInvocation }): string;
}
