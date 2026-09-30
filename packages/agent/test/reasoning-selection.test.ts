import { describe, expect, it } from "vitest";
import { toAIModelSettings } from "../src/loop/context/context-engine-port.js";

describe("canonical reasoning model settings", () => {
  it("projects a durable canonical level without introducing provider-native fields", () => {
    expect(toAIModelSettings({ reasoning: { level: "HIGH" } })).toEqual({
      reasoning: { level: "HIGH" },
    });
    expect(toAIModelSettings({ reasoning: { level: "XHIGH" }, maxOutputTokens: 1024 })).toEqual({
      reasoning: { level: "XHIGH" },
      maxOutputTokens: 1024,
    });
  });
});
