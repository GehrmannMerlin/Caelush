import * as messages from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";

describe("LLM message subpath", () => {
  it("exposes only the provider-independent message contract", () => {
    expect(messages.LLMMessageSchema.parse({ role: "system", content: "context" })).toEqual({
      role: "system",
      content: "context",
    });
    expect(messages.LLMUserMessageSchema.parse({ role: "user", content: "hello" })).toEqual({
      role: "user",
      content: "hello",
    });
    expect(messages.LLMGateway).toBeUndefined();
    expect(messages.createOpenAICompatibleLLMProvider).toBeUndefined();
  });
});
