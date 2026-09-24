import type { ToolCallRequest, ToolResultBatchNormalizer } from "@caelush/agent";
import { createToolResultBatchNormalizer } from "@caelush/agent";
import type { AIToolResultMessage } from "@caelush/ai";
import type { AgentToolRequest } from "./agent-decision.js";

/**
 * The legacy entry point of the canonical Tool Result batch normalizer.
 *
 * ```text
 * canonical declaration   @caelush/agent  ToolResultBatchNormalizer
 * this module             a delegation to it, over the legacy message vocabulary
 * ```
 *
 * Phase 4D moved the authority. Core no longer owns a second implementation of "duplicate request,
 * duplicate result, unexpected result, missing result, tool-name mismatch, original request order" —
 * it calls the canonical normalizer, which is the same code the production Tool turn uses through
 * `ModelToolFeedbackProjector` output.
 *
 * Keeping the entry point matters for two reasons:
 *
 * ```text
 * the durable conversation ledger still speaks LLMToolResultMessage
 * the legacy callers and their tests keep working unchanged
 * ```
 *
 * The two message shapes differ by exactly one field — the legacy one may carry `rawArtifactRef`, which
 * the frozen `AIToolResultMessage` deliberately has no field for — so the projection is a field
 * selection in each direction rather than a second algorithm. The identity, shape, multiplicity,
 * matching and ordering checks all happen inside the canonical normalizer.
 */

const canonicalNormalizer: ToolResultBatchNormalizer = createToolResultBatchNormalizer();

export function normalizeToolResultBatch(
  requests: readonly AgentToolRequest[],
  results: readonly AIToolResultMessage[],
): readonly AIToolResultMessage[] {
  const normalized = canonicalNormalizer.normalize({
    requests: requests.map(toCanonicalRequest),
    results: results.map(toCanonicalResult),
  });

  return normalized;
}

/** The legacy call shape as the canonical Tool Layer's own call request. */
function toCanonicalRequest(request: AgentToolRequest): ToolCallRequest {
  return {
    externalCallId: request.externalCallId,
    toolName: request.toolName,
    args: request.args,
  };
}

/**
 * The legacy result message as the canonical `AIToolResultMessage`.
 *
 * The field selection is deliberately explicit: a legacy message that also carried a provider option or
 * another non-canonical field would project down to the frozen five fields rather than smuggling the
 * extra one into the model contract.
 */
function toCanonicalResult(message: AIToolResultMessage): AIToolResultMessage {
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    isError: message.isError,
  };
}
