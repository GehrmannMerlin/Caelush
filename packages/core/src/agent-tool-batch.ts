import type { AgentToolResult } from "@caelush/agent";
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

/**
 * The compatibility observation policy of a host that configured no Context policy.
 *
 * It is the legacy Core's own long-standing default — the same ratios the Context runtime's
 * policy factory derives from a real effective input limit — and it is exported so the two
 * Core boundaries that need it (Tool result projection and the Context compatibility adapter)
 * cannot drift into two different defaults.
 */
export function defaultObservationPolicy(): AgentToolObservationPolicy {
  return {
    maxSingleObservationTokens: Math.max(1, Math.floor(LEGACY_EFFECTIVE_INPUT_LIMIT * 0.1)),
    maxObservationBatchTokens: Math.max(1, Math.floor(LEGACY_EFFECTIVE_INPUT_LIMIT * 0.22)),
  };
}

/**
 * Project one Tool batch onto the frozen model-facing Tool results.
 *
 * ```text
 * ToolBatchItemResult  raw output, invocation id, observation id, artifact pointer
 *        ↓
 * observation projection (the one truncation policy the workspace owns)
 *        ↓
 * AgentToolResult      externalCallId, toolName, summary content, isError
 * ```
 *
 * This is the *only* place a raw Tool result becomes model-facing. The Tool Layer's unbounded
 * output, its invocation identity, its observation record and its durable artifact pointer stop
 * here: `AgentToolResult` is a frozen general-Agent contract and has no field for any of them.
 *
 * Results are projected in the order they were reported, which the caller has already established
 * is assistant source order, and the policy is applied to the batch as a whole so two identical
 * batches project identically.
 */
export function toAgentToolResults(
  requests: readonly AgentToolRequest[],
  results: readonly ToolBatchItemResult[],
  policy: AgentToolObservationPolicy = defaultObservationPolicy(),
): readonly AgentToolResult[] {
  return projectToolResultBatch(requests, results, policy).map((projected) => ({
    externalCallId: projected.toolCallId,
    toolName: projected.toolName,
    content: projected.content,
    isError: projected.isError,
  }));
}

export function toLLMToolResultMessages(
  requests: readonly AgentToolRequest[],
  results: readonly ToolBatchItemResult[],
  policy: AgentToolObservationPolicy = defaultObservationPolicy(),
): readonly LLMToolResultMessage[] {
  return projectToolResultBatch(requests, results, policy);
}

/**
 * The one observation projection a Tool batch is rendered through.
 *
 * Both the durable legacy message encoding and the frozen model-facing result are derived from
 * this single projection, so a workspace can never end up with two different truncations of one
 * Tool output — one stored and one shown.
 */
function projectToolResultBatch(
  requests: readonly AgentToolRequest[],
  results: readonly ToolBatchItemResult[],
  policy: AgentToolObservationPolicy,
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
