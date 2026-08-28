import {
  LLMToolResultMessageSchema,
  type LLMToolResultMessage,
} from "@caelush/llm/messages";
import {
  AgentToolResultBatchError,
} from "./agent-errors.js";
import type { AgentToolRequest } from "./agent-decision.js";

export function normalizeToolResultBatch(
  requests: readonly AgentToolRequest[],
  results: readonly LLMToolResultMessage[],
): readonly LLMToolResultMessage[] {
  const requestById = new Map<string, AgentToolRequest>();
  for (const request of requests) {
    if (requestById.has(request.externalCallId)) {
      throw new AgentToolResultBatchError("DUPLICATE_REQUEST_ID", {
        toolCallId: request.externalCallId,
      });
    }
    requestById.set(request.externalCallId, request);
  }

  const parsedResults: LLMToolResultMessage[] = [];
  for (const result of results) {
    const parsed = LLMToolResultMessageSchema.safeParse(result);
    if (!parsed.success) {
      throw new AgentToolResultBatchError("INVALID_RESULT", {
        requestCount: requests.length,
        resultCount: results.length,
      });
    }
    parsedResults.push(parsed.data);
  }

  const resultById = new Map<string, LLMToolResultMessage>();
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

  return requests.map((request) => resultById.get(request.externalCallId)!);
}
