import type {
  AgentToolExecutionOutput,
  AgentToolExecutionResult,
  AgentToolExecutionReturn,
} from "@caelush/agent";

/** Keep direct Tool behavior assertions on the three-field result, unwrapping the internal envelope. */
export function unwrapAgentToolResult(
  output: AgentToolExecutionReturn | AgentToolExecutionResult | AgentToolExecutionOutput,
): AgentToolExecutionResult {
  return "result" in output ? output.result : output;
}

export async function executeAgentToolResult<TInput>(
  tool: {
    execute(
      input: TInput,
    ): Promise<AgentToolExecutionReturn | AgentToolExecutionResult | AgentToolExecutionOutput>;
  },
  input: TInput,
): Promise<AgentToolExecutionResult> {
  return unwrapAgentToolResult(await tool.execute(input));
}
