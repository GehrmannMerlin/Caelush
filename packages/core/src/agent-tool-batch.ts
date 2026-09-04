import { LLMToolResultMessageSchema, type LLMToolResultMessage } from "@caelush/llm/messages";
import type { AgentToolRequest } from "./agent-decision.js";
import type { ToolBatchItemResult } from "@caelush/tools";
import { ToolBatchResultConversionError } from "./agent-errors.js";
import { projectToolObservation, Utf8HeuristicTokenEstimator } from "@caelush/context";

const MAX_MODEL_OBSERVATION_TOKENS = 8192;
const modelObservationEstimator = new Utf8HeuristicTokenEstimator();

export function toLLMToolResultMessages(
  requests: readonly AgentToolRequest[],
  results: readonly ToolBatchItemResult[],
): readonly LLMToolResultMessage[] {
  if (requests.length !== results.length) throw new ToolBatchResultConversionError();
  return requests.map((request, index) => {
    const result = results[index];
    if (
      result === undefined ||
      result.externalCallId !== request.externalCallId ||
      result.toolName !== request.toolName
    ) {
      throw new ToolBatchResultConversionError();
    }
    const observation = projectToolObservation({
      sourceToolInvocationId: result.invocationId ?? result.externalCallId,
      toolName: result.toolName,
      content: result.content,
      maxObservationTokens: MAX_MODEL_OBSERVATION_TOKENS,
      estimator: modelObservationEstimator,
    });
    const message = {
      role: "tool" as const,
      toolCallId: result.externalCallId,
      toolName: result.toolName,
      content: observation.summary,
      isError: result.isError,
    };
    return LLMToolResultMessageSchema.parse(message);
  });
}
