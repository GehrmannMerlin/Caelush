import * as request from "@caelush/llm/request";
import { describe, expect, it } from "vitest";

describe("LLM request subpath", () => {
  it("exposes provider-independent request contracts without gateway symbols", () => {
    expect(
      request.LLMRequestSchema.parse({
        model: { provider: "fixture", model: "fixture-model" },
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toEqual({
      model: { provider: "fixture", model: "fixture-model" },
      messages: [{ role: "user", content: "hello" }],
    });
    expect((request as Record<string, unknown>).LLMGateway).toBeUndefined();
  });
});
