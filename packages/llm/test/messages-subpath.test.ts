import * as messages from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";

const api = messages as Record<string, unknown>;

describe("LLM message subpath", () => {
  it("exposes only the durable conversation message contract", () => {
    expect(messages.LLMMessageSchema.parse({ role: "system", content: "context" })).toEqual({
      role: "system",
      content: "context",
    });
    expect(messages.LLMUserMessageSchema.parse({ role: "user", content: "hello" })).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("keeps the durable tool-result recovery pointer, which is not provider input", () => {
    // `rawArtifactRef` is Context recovery compatibility and is deliberately retained;
    // it is not an `AIToolResultMessage` field and must never become one.
    const parsed = messages.LLMToolResultMessageSchema.parse({
      role: "tool",
      toolCallId: "call_a",
      toolName: "read_file",
      content: "truncated",
      isError: false,
      rawArtifactRef: "artifact-1",
    });

    expect(parsed).toMatchObject({ rawArtifactRef: "artifact-1" });
  });

  it("carries no model-invocation authority", () => {
    for (const retired of [
      "LLMGateway",
      "createOpenAICompatibleLLMProvider",
      "LLMProviderRegistry",
      "LLMRequestSchema",
      "LLMError",
    ]) {
      expect(api[retired], retired).toBeUndefined();
    }
  });
});
