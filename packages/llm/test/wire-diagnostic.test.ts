import { describe, expect, it } from "vitest";
import {
  createSafeLLMWireDiagnostic,
  summarizeLLMWireRequest,
  type LLMRequest,
} from "../src/index.js";

const request: LLMRequest = {
  model: { provider: "deepseek", model: "deepseek-chat" },
  messages: [
    { role: "system", content: "secret system prompt" },
    { role: "user", content: "secret user request" },
  ],
  tools: [
    {
      name: "read_file",
      description: "secret tool description",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      riskLevel: "LOW",
      requiredCapabilities: [],
      runtimeRequirements: {},
    },
  ],
};

describe("safe model wire diagnostics", () => {
  it("is opt-in and records only roles, names, and timing-safe metadata", () => {
    const events: unknown[] = [];
    expect(
      createSafeLLMWireDiagnostic({ env: {}, sink: (event) => events.push(event) }),
    ).toBeUndefined();
    const diagnostic = createSafeLLMWireDiagnostic({
      env: { CAELUSH_DEBUG_MODEL_WIRE: "1" },
      sink: (event) => events.push(event),
    });
    expect(diagnostic).toBeDefined();
    diagnostic?.record(summarizeLLMWireRequest(request, "call-1"));
    diagnostic?.record({
      phase: "RESPONSE",
      callId: "call-1",
      providerId: "deepseek",
      model: "deepseek-chat",
      finishReason: "STOP",
      toolNames: [],
      durationMs: 12,
    });
    const trace = JSON.stringify(events);
    expect(trace).toContain("read_file");
    expect(trace).toContain("system");
    expect(trace).not.toContain("secret system prompt");
    expect(trace).not.toContain("secret user request");
    expect(trace).not.toContain("secret tool description");
  });
});
