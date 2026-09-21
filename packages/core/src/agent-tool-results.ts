import type { ToolCallRequest, ToolResultBatchNormalizer } from "@caelush/agent";
import { createToolResultBatchNormalizer } from "@caelush/agent";
import type { AIToolResultMessage } from "@caelush/ai";
import type { LLMToolResultMessage } from "@caelush/llm/messages";
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
  results: readonly LLMToolResultMessage[],
): readonly LLMToolResultMessage[] {
  // `rawArtifactRef` is a durable artifact-linkage pointer, not model-facing content: the canonical
  // contract has no field for it, so it is dropped on the way in and restored from the caller's own
  // input on the way out. Only the position is taken from the canonical result, never the content.
  const legacyById = new Map<string, LLMToolResultMessage>();
  for (const result of results) legacyById.set(result.toolCallId, result);

  const normalized = canonicalNormalizer.normalize({
    requests: requests.map(toCanonicalRequest),
    results: results.map(toCanonicalResult),
  });

  return normalized.map((message) => {
    const legacy = legacyById.get(message.toolCallId);
    return {
      role: "tool" as const,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
      ...(legacy?.rawArtifactRef === undefined ? {} : { rawArtifactRef: legacy.rawArtifactRef }),
    };
  });
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
function toCanonicalResult(message: LLMToolResultMessage): AIToolResultMessage {
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    isError: message.isError,
  };
}
