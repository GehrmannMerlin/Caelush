import { describe, expect, it } from "vitest";
import { mapOpenAICompatibleFinishReason } from "../../../src/adapters/openai-compatible/finish-reason.js";

describe("OpenAI-compatible finish reason mapping", () => {
  it("maps the four known native reasons", () => {
    expect(mapOpenAICompatibleFinishReason("stop")).toBe("STOP");
    expect(mapOpenAICompatibleFinishReason("length")).toBe("LENGTH");
    expect(mapOpenAICompatibleFinishReason("tool-calls")).toBe("TOOL_CALLS");
    expect(mapOpenAICompatibleFinishReason("content-filter")).toBe("CONTENT_FILTER");
  });

  it("maps every unknown reason to OTHER and never to STOP", () => {
    for (const reason of [
      "unknown",
      "other",
      "error",
      "insufficient_system_resource",
      "content_filter",
      "STOP",
      "",
      "   ",
    ]) {
      expect(mapOpenAICompatibleFinishReason(reason), reason).toBe("OTHER");
      expect(mapOpenAICompatibleFinishReason(reason), reason).not.toBe("STOP");
    }
  });

  it("is case sensitive, so a provider variant is not silently upgraded", () => {
    expect(mapOpenAICompatibleFinishReason("Stop")).toBe("OTHER");
    expect(mapOpenAICompatibleFinishReason("TOOL_CALLS")).toBe("OTHER");
  });

  it("is total for the AI finish reason set", () => {
    const mapped = new Set(
      ["stop", "length", "tool-calls", "content-filter", "anything-else"].map(
        mapOpenAICompatibleFinishReason,
      ),
    );

    expect([...mapped].sort()).toEqual(["CONTENT_FILTER", "LENGTH", "OTHER", "STOP", "TOOL_CALLS"]);
  });
});
