import * as errors from "@caelush/llm/errors";
import { describe, expect, it } from "vitest";

describe("LLM error subpath", () => {
  it("exposes sanitized LLM errors without provider implementation symbols", () => {
    expect(new errors.LLMNetworkError()).toBeInstanceOf(errors.LLMError);
    expect((errors as Record<string, unknown>).LLMGateway).toBeUndefined();
    expect((errors as Record<string, unknown>).createOpenAICompatibleLLMProvider).toBeUndefined();
  });
});
