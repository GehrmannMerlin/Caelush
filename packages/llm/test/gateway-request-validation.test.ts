import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@caelush/protocol";
import type { LLMCapabilities } from "../src/index.js";
import {
  LLMCapabilityUnsupportedError,
  LLMGateway,
  LLMInvalidRequestError,
  LLMProviderRegistry,
} from "../src/index.js";
import { FakeLLMProvider } from "./support/fake-provider.js";

const model = { provider: "local", model: "test-model" };
const tool: ToolDefinition = {
  name: "list_files",
  description: "List files",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { kind: "local" },
};

function gatewayWithCapabilities(capabilities: Partial<LLMCapabilities>) {
  const provider = new FakeLLMProvider({
    id: "local",
    eventsForContext: (_request, context) => [
      { type: "stream.start", payload: { callId: context.callId, providerId: "local", model } },
      { type: "stream.finish", payload: { finishReason: "STOP" } },
    ],
    capabilities: {
      textStreaming: "SUPPORTED",
      toolCalling: "UNKNOWN",
      parallelToolCalls: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      reasoningSummary: "UNKNOWN",
      ...capabilities,
    },
  });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  return new LLMGateway({ providers });
}

describe("LLM gateway request preflight", () => {
  it("rejects semantic tool and known limit violations synchronously", () => {
    const gateway = gatewayWithCapabilities({ maxOutputTokens: 100 });
    expect(() => gateway.stream({ model, messages: [], tools: [tool, tool] })).toThrow(
      LLMInvalidRequestError,
    );
    expect(() => gateway.stream({ model, messages: [], maxOutputTokens: 101 })).toThrow(
      LLMInvalidRequestError,
    );
  });

  it("allows UNKNOWN capabilities but rejects UNSUPPORTED tool calling", () => {
    expect(() =>
      gatewayWithCapabilities({ toolCalling: "UNKNOWN" }).stream({
        model,
        messages: [],
        tools: [tool],
      }),
    ).not.toThrow();
    expect(() =>
      gatewayWithCapabilities({ toolCalling: "UNSUPPORTED" }).stream({
        model,
        messages: [],
        tools: [tool],
      }),
    ).toThrow(LLMCapabilityUnsupportedError);
  });
});
