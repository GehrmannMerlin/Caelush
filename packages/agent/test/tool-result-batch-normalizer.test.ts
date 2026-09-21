import type { AIToolResultMessage } from "@caelush/ai";
import { describe, expect, it } from "vitest";

import {
  AgentToolResultBatchError,
  createToolResultBatchNormalizer,
  type ToolCallRequest,
  type ToolResultBatchNormalizer,
} from "../src/index.js";

/**
 * The canonical Tool Result batch normalizer.
 *
 * ```text
 * requests + results  →  identity · shape · multiplicity · matching · ordering
 * ```
 *
 * It is a *defense*, not a producer: it never truncates, never sanitizes, never reads an observation
 * and never invents a missing result. These tests pin each refusal and the ordering authority.
 */

const normalizer: ToolResultBatchNormalizer = createToolResultBatchNormalizer();

function request(externalCallId: string, toolName = "read_file"): ToolCallRequest {
  return { externalCallId, toolName, args: {} };
}

function result(
  toolCallId: string,
  toolName = "read_file",
  content = "body",
  isError = false,
): AIToolResultMessage {
  return { role: "tool", toolCallId, toolName, content, isError };
}

/** The reason a normalizer call was refused, or `undefined` when it was accepted. */
function refusalOf(
  requests: readonly ToolCallRequest[],
  results: readonly AIToolResultMessage[],
): string | undefined {
  try {
    normalizer.normalize({ requests, results });
    return undefined;
  } catch (error) {
    if (error instanceof AgentToolResultBatchError) return error.reason;
    throw error;
  }
}

describe("canonical Tool result batch normalizer — ordering", () => {
  it("returns an already-ordered batch unchanged", () => {
    const requests = [request("call_1"), request("call_2"), request("call_3")];
    const normalized = normalizer.normalize({
      requests,
      results: [result("call_1"), result("call_2"), result("call_3")],
    });
    expect(normalized.map((message) => message.toolCallId)).toEqual(["call_1", "call_2", "call_3"]);
  });

  it("reorders a completion-order batch onto the request order", () => {
    const requests = [request("call_1"), request("call_2"), request("call_3")];
    const normalized = normalizer.normalize({
      requests,
      // A provider may report results in completion order. `requests` is the ordering authority.
      results: [result("call_3"), result("call_1"), result("call_2")],
    });
    expect(normalized.map((message) => message.toolCallId)).toEqual(["call_1", "call_2", "call_3"]);
  });

  it("preserves each result's own content and error flag through reordering", () => {
    const requests = [request("call_a"), request("call_b")];
    const normalized = normalizer.normalize({
      requests,
      results: [
        result("call_b", "read_file", "from b", true),
        result("call_a", "read_file", "from a"),
      ],
    });
    expect(normalized).toEqual([
      {
        role: "tool",
        toolCallId: "call_a",
        toolName: "read_file",
        content: "from a",
        isError: false,
      },
      {
        role: "tool",
        toolCallId: "call_b",
        toolName: "read_file",
        content: "from b",
        isError: true,
      },
    ]);
  });

  it("accepts an empty batch", () => {
    expect(normalizer.normalize({ requests: [], results: [] })).toEqual([]);
  });
});

describe("canonical Tool result batch normalizer — refusals", () => {
  it("refuses a duplicate request id", () => {
    expect(refusalOf([request("call_a"), request("call_a")], [result("call_a")])).toBe(
      "DUPLICATE_REQUEST_ID",
    );
  });

  it("refuses an invalid result object", () => {
    for (const invalid of [
      null,
      undefined,
      42,
      "tool",
      [],
      {
        role: "assistant",
        toolCallId: "call_a",
        toolName: "read_file",
        content: "",
        isError: false,
      },
      // A smuggled non-canonical field: `AIToolResultMessage` has exactly five fields.
      {
        role: "tool",
        toolCallId: "call_a",
        toolName: "read_file",
        content: "",
        isError: false,
        rawArtifactRef: "artifact:x",
      },
      { role: "tool", toolCallId: "", toolName: "read_file", content: "", isError: false },
      { role: "tool", toolCallId: "call_a", toolName: "read_file", content: "", isError: "no" },
    ]) {
      expect(
        refusalOf([request("call_a")], [invalid as unknown as AIToolResultMessage]),
        `expected ${JSON.stringify(invalid)} to be refused`,
      ).toBe("INVALID_RESULT");
    }
  });

  it("refuses a duplicate result", () => {
    expect(
      refusalOf([request("call_a"), request("call_b")], [result("call_a"), result("call_a")]),
    ).toBe("DUPLICATE_RESULT");
  });

  it("refuses a result nobody requested", () => {
    expect(refusalOf([request("call_a")], [result("call_a"), result("call_ghost")])).toBe(
      "UNEXPECTED_RESULT",
    );
  });

  it("refuses a missing result", () => {
    expect(refusalOf([request("call_a"), request("call_b")], [result("call_a")])).toBe(
      "MISSING_RESULT",
    );
  });

  it("refuses a Tool name mismatch", () => {
    expect(refusalOf([request("call_a", "read_file")], [result("call_a", "exec_command")])).toBe(
      "TOOL_NAME_MISMATCH",
    );
  });

  it("refuses an empty result set against a non-empty request set", () => {
    expect(refusalOf([request("call_a")], [])).toBe("MISSING_RESULT");
  });

  it("refuses an empty request set with a result present", () => {
    expect(refusalOf([], [result("call_a")])).toBe("UNEXPECTED_RESULT");
  });

  it("carries bounded metadata and no raw content", () => {
    const failure = (() => {
      try {
        normalizer.normalize({
          requests: [request("call_a", "read_file")],
          results: [result("call_a", "exec_command", "SECRET BODY")],
        });
      } catch (error) {
        return error as AgentToolResultBatchError;
      }
      return undefined;
    })();

    expect(failure?.reason).toBe("TOOL_NAME_MISMATCH");
    expect(failure?.metadata).toEqual({ toolCallId: "call_a", toolName: "read_file" });
    // The refused content never enters the error, so a logged failure cannot leak Tool output.
    expect(JSON.stringify(failure)).not.toContain("SECRET BODY");
  });
});

describe("canonical Tool result batch normalizer — what it does not do", () => {
  it("does not truncate, sanitize or rewrite content", () => {
    const body = "x".repeat(50_000);
    const normalized = normalizer.normalize({
      requests: [request("call_a")],
      results: [result("call_a", "read_file", body)],
    });
    expect(normalized[0]!.content).toBe(body);
  });

  it("produces exactly one result per request", () => {
    const requests = [request("a"), request("b"), request("c"), request("d")];
    const normalized = normalizer.normalize({
      requests,
      results: [result("d"), result("b"), result("a"), result("c")],
    });
    expect(normalized).toHaveLength(requests.length);
    expect(new Set(normalized.map((message) => message.toolCallId)).size).toBe(requests.length);
  });

  it("returns a frozen, request-ordered batch", () => {
    const normalized = normalizer.normalize({
      requests: [request("call_a")],
      results: [result("call_a")],
    });
    expect(Object.isFrozen(normalized)).toBe(true);
  });
});
