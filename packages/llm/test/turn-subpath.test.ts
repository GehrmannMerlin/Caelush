import * as turn from "@caelush/llm/turn";
import { describe, expect, it } from "vitest";

const api = turn as Record<string, unknown>;

describe("LLM turn subpath", () => {
  it("resolves the durable finish-reason, usage and tool-call schemas", () => {
    expect(turn.FinishReasonSchema.parse("STOP")).toBe("STOP");
    expect(turn.LLMUsageSchema.parse({ inputTokens: 2 })).toEqual({ inputTokens: 2 });
    expect(turn.LLMToolCallSchema.parse({ id: "call_a", name: "read_file", input: {} })).toEqual({
      id: "call_a",
      name: "read_file",
      input: {},
    });
  });

  it("carries no model-invocation authority", () => {
    // Phase 2D retired the aggregate turn result with the rest of the invocation
    // surface: the subpath now holds only what durable storage decodes.
    for (const retired of [
      "LLMTurnResultSchema",
      "LLMGateway",
      "createOpenAICompatibleLLMProvider",
      "LLMProviderRegistry",
      "LLMError",
    ]) {
      expect(api[retired], retired).toBeUndefined();
    }
  });
});
