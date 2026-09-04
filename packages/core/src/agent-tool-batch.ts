import { LLMToolResultMessageSchema, type LLMToolResultMessage } from "@caelush/llm/messages";
import type { AgentToolRequest } from "./agent-decision.js";
import type { ToolBatchItemResult } from "@caelush/tools";
import { ToolBatchResultConversionError } from "./agent-errors.js";
import {
  projectToolObservationBatch,
  Utf8HeuristicTokenEstimator,
  type ContextPolicy,
} from "@caelush/context";

const modelObservationEstimator = new Utf8HeuristicTokenEstimator();

export type AgentToolObservationPolicy = Pick<
  ContextPolicy,
  "maxSingleObservationTokens" | "maxObservationBatchTokens"
>;

const LEGACY_EFFECTIVE_INPUT_LIMIT = 32_000;

function defaultObservationPolicy(): AgentToolObservationPolicy {
  return {
    maxSingleObservationTokens: Math.max(1, Math.floor(LEGACY_EFFECTIVE_INPUT_LIMIT * 0.1)),
    maxObservationBatchTokens: Math.max(1, Math.floor(LEGACY_EFFECTIVE_INPUT_LIMIT * 0.22)),
  };
}

export function toLLMToolResultMessages(
  requests: readonly AgentToolRequest[],
  results: readonly ToolBatchItemResult[],
  policy: AgentToolObservationPolicy = defaultObservationPolicy(),
): readonly LLMToolResultMessage[] {
  if (requests.length !== results.length) throw new ToolBatchResultConversionError();
  const projected = projectToolObservationBatch({
    observations: requests.map((request, index) => {
      const result = results[index];
      if (
        result === undefined ||
        result.externalCallId !== request.externalCallId ||
        result.toolName !== request.toolName
      ) {
        throw new ToolBatchResultConversionError();
      }
      return {
        sourceToolInvocationId: result.invocationId ?? result.externalCallId,
        toolName: result.toolName,
        content: result.content,
        ...(result.rawArtifactRef === undefined ? {} : { rawArtifactRef: result.rawArtifactRef }),
      };
    }),
    maxSingleObservationTokens: policy.maxSingleObservationTokens,
    maxObservationBatchTokens: policy.maxObservationBatchTokens,
    estimator: modelObservationEstimator,
  });
  return requests.map((request, index) => {
    const result = results[index];
    const observation = projected[index];
    if (result === undefined || observation === undefined)
      throw new ToolBatchResultConversionError();
    const message = {
      role: "tool" as const,
      toolCallId: result.externalCallId,
      toolName: result.toolName,
      content: observation.summary,
      isError: result.isError,
      ...(result.rawArtifactRef === undefined ? {} : { rawArtifactRef: result.rawArtifactRef }),
    };
    return LLMToolResultMessageSchema.parse(message);
  });
}
