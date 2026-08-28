import * as turn from "@caelush/llm/turn";
import { describe, expect, it } from "vitest";

describe("LLM turn subpath", () => {
  it("resolves provider-independent turn contracts from the built package", () => {
    expect(turn.FinishReasonSchema.parse("STOP")).toBe("STOP");
    expect(turn.LLMUsageSchema.parse({ inputTokens: 2 })).toEqual({ inputTokens: 2 });
    expect(turn.LLMToolCallSchema.parse({ id: "call_a", name: "read_file", input: {} })).toEqual({
      id: "call_a",
      name: "read_file",
      input: {},
    });
    expect(turn.LLMTurnResultSchema).toBeDefined();
    expect((turn as Record<string, unknown>).LLMGateway).toBeUndefined();
    expect((turn as Record<string, unknown>).createOpenAICompatibleLLMProvider).toBeUndefined();
  });
});
