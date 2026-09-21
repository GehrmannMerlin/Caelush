import { assertAIMessage, type AIToolResultMessage } from "@caelush/ai";

import type { ToolCallRequest } from "../call/tool-call-preparer.js";
import { AgentToolResultBatchError } from "../batch/batch-errors.js";

/**
 * The canonical Tool Result batch normalizer.
 *
 * ```ts
 * export interface ToolResultBatchNormalizer {
 *   normalize(input: {
 *     readonly requests: readonly ToolCallRequest[];
 *     readonly results: readonly AIToolResultMessage[];
 *   }): readonly AIToolResultMessage[];
 * }
 * ```
 *
 * ## What it owns, and what it does not
 *
 * ```text
 * owns      identity   shape   multiplicity   matching   ordering
 * not owns  truncation   sanitization   observation reads   feedback construction   execution
 * ```
 *
 * This is a **defense**, not a producer. A caller has already built a safe model view; this object
 * proves that view is answerable to the request that produced it. It never reads a durable observation,
 * never truncates content and never invents a missing result — a missing result is a failure, not an
 * invitation to fabricate one.
 *
 * ## Order is an authority, not a preference
 *
 * A provider may report Tool results in completion order. The model's conversation, however, must
 * present them in the order the assistant issued the calls, because that is the order the model's own
 * message describes. `requests` is therefore the ordering authority: input
 * `[call_3, call_1, call_2]` normalizes to `[call_1, call_2, call_3]`.
 *
 * ## Why it takes `ToolCallRequest` rather than the raw decision
 *
 * `ToolCallRequest` is the Tool Layer's own canonical call shape, so the normalizer needs no Core type,
 * no model decision and no provider shape. It shares that vocabulary with the batch coordinator and the
 * model feedback projector, which is what lets the three compose without an adapter between them.
 */
export interface ToolResultBatchNormalizer {
  normalize(input: {
    readonly requests: readonly ToolCallRequest[];
    readonly results: readonly AIToolResultMessage[];
  }): readonly AIToolResultMessage[];
}

/**
 * Build the canonical normalizer.
 *
 * It is stateless: no clock, no store, no registry and no configuration. Everything it decides is a
 * function of the two arguments, which is what makes "same batch in, same batch out" checkable.
 */
export function createToolResultBatchNormalizer(): ToolResultBatchNormalizer {
  return {
    normalize(input: {
      readonly requests: readonly ToolCallRequest[];
      readonly results: readonly AIToolResultMessage[];
    }): readonly AIToolResultMessage[] {
      return normalizeToolResultBatch(input.requests, input.results);
    },
  };
}

/**
 * Refuse a result batch that does not answer its request batch exactly.
 *
 * The checks run in this order, and the order is deliberate:
 *
 * ```text
 * 1  the request batch itself is unambiguous        duplicate request ID
 * 2  every result is structurally a Tool result     invalid result
 * 3  every result answers a requested call          duplicate / unexpected result
 * 4  every requested call is answered               missing result
 * 5  each answer names the right Tool               tool name mismatch
 * 6  the counts agree                               unexpected result
 * ```
 *
 * Checks 1–3 happen before any matching, so an ambiguous input is refused rather than resolved by an
 * arbitrary winner. Two results claiming the same call must never be reconciled by "first one wins".
 */
export function normalizeToolResultBatch(
  requests: readonly ToolCallRequest[],
  results: readonly AIToolResultMessage[],
): readonly AIToolResultMessage[] {
  const requestById = new Map<string, ToolCallRequest>();
  for (const request of requests) {
    if (requestById.has(request.externalCallId)) {
      throw new AgentToolResultBatchError("DUPLICATE_REQUEST_ID", {
        toolCallId: request.externalCallId,
      });
    }
    requestById.set(request.externalCallId, request);
  }

  const parsedResults: AIToolResultMessage[] = [];
  for (const result of results) {
    if (!isAIToolResultMessage(result)) {
      throw new AgentToolResultBatchError("INVALID_RESULT", {
        requestCount: requests.length,
        resultCount: results.length,
      });
    }
    parsedResults.push({
      role: "tool",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      content: result.content,
      isError: result.isError,
    });
  }

  const resultById = new Map<string, AIToolResultMessage>();
  for (const result of parsedResults) {
    if (resultById.has(result.toolCallId)) {
      throw new AgentToolResultBatchError("DUPLICATE_RESULT", {
        toolCallId: result.toolCallId,
      });
    }
    if (!requestById.has(result.toolCallId)) {
      throw new AgentToolResultBatchError("UNEXPECTED_RESULT", {
        toolCallId: result.toolCallId,
        resultCount: results.length,
      });
    }
    resultById.set(result.toolCallId, result);
  }

  for (const request of requests) {
    const result = resultById.get(request.externalCallId);
    if (result === undefined) {
      throw new AgentToolResultBatchError("MISSING_RESULT", {
        toolCallId: request.externalCallId,
        requestCount: requests.length,
        resultCount: results.length,
      });
    }
    if (result.toolName !== request.toolName) {
      throw new AgentToolResultBatchError("TOOL_NAME_MISMATCH", {
        toolCallId: request.externalCallId,
        toolName: request.toolName,
      });
    }
  }

  if (resultById.size !== requestById.size) {
    throw new AgentToolResultBatchError("UNEXPECTED_RESULT", {
      requestCount: requests.length,
      resultCount: results.length,
    });
  }

  // Request order is the authority. Every result is already known to exist and to match.
  return Object.freeze(
    requests.map((request) => {
      const result = resultById.get(request.externalCallId);
      if (result === undefined) {
        throw new AgentToolResultBatchError("MISSING_RESULT", {
          toolCallId: request.externalCallId,
        });
      }
      return result;
    }),
  );
}

/**
 * Whether a value is a well-formed `AIToolResultMessage`.
 *
 * The AI package's own assertion is the authority, so the Tool Layer never grows a second, weaker
 * definition of "a valid model Tool result". It rejects unknown fields as well as wrong shapes, which
 * is what keeps a stray `rawArtifactRef` or provider option from riding into model history.
 */
function isAIToolResultMessage(value: unknown): value is AIToolResultMessage {
  try {
    assertAIMessage(value);
  } catch {
    return false;
  }
  return (value as { readonly role?: unknown }).role === "tool";
}
