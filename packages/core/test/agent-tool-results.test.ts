import { describe, expect, it } from "vitest";
import {
  AgentToolResultBatchError,
  normalizeToolResultBatch,
} from "../src/index.js";
import type { AgentToolRequest } from "../src/index.js";
import type { LLMToolResultMessage } from "@caelush/llm/messages";

function request(toolCallId: string, toolName = "read_file"): AgentToolRequest {
  return { externalCallId: toolCallId, toolName, args: { path: `${toolCallId}.ts` } };
}

function result(
  toolCallId: string,
  toolName = "read_file",
  isError = false,
): LLMToolResultMessage {
  return { role: "tool", toolCallId, toolName, content: `${toolCallId} output`, isError };
}

describe("Agent tool result batches", () => {
  it("accepts completion order but returns assistant source order", () => {
    const requests = [request("call_a"), request("call_b", "search_text")];
    const normalized = normalizeToolResultBatch(requests, [
      result("call_b", "search_text"),
      result("call_a"),
    ]);
    expect(normalized.map((item) => item.toolCallId)).toEqual(["call_a", "call_b"]);
  });

  it("accepts an error result as a valid result for its request", () => {
    const normalized = normalizeToolResultBatch([request("call_a")], [
      result("call_a", "read_file", true),
    ]);
    expect(normalized[0]?.isError).toBe(true);
  });

  it.each([
    ["missing", [request("call_a"), request("call_b")], [result("call_a")]],
    ["extra", [request("call_a")], [result("call_a"), result("call_b")]],
    ["duplicate", [request("call_a")], [result("call_a"), result("call_a")]],
    ["wrong-name", [request("call_a", "read_file")], [result("call_a", "search_text")]],
  ] as const)("rejects an inconsistent %s batch", (_kind, requests, results) => {
    expect(() => normalizeToolResultBatch(requests, results)).toThrow(AgentToolResultBatchError);
  });

  it("rejects duplicate request IDs before accepting results", () => {
    expect(() =>
      normalizeToolResultBatch([request("call_a"), request("call_a")], [result("call_a")]),
    ).toThrow(AgentToolResultBatchError);
  });

  it("rejects an invalid result message without exposing request arguments", () => {
    const secret = "CAELUSH_AGENT_KERNEL_SECRET_42";
    const requests = [{ externalCallId: "call_a", toolName: "read_file", args: { secret } }];
    const invalidResult = { role: "assistant", content: secret } as unknown as LLMToolResultMessage;
    try {
      normalizeToolResultBatch(requests, [invalidResult]);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentToolResultBatchError);
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});
