import { describe, expect, it } from "vitest";
import { LLMCapabilityUnsupportedError, LLMInvalidRequestError } from "../src/index.js";
import { validateLLMRequestSemantics, validateTimeoutMs } from "../src/request-validation.js";

const model = { provider: "local", model: "test-model" };
const tool = {
  name: "list_files",
  description: "List files",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { kind: "local" },
} as const;
const capabilities = {
  textStreaming: "SUPPORTED",
  toolCalling: "SUPPORTED",
  parallelToolCalls: "UNKNOWN",
  structuredOutput: "UNKNOWN",
  vision: "UNKNOWN",
  reasoningSummary: "UNKNOWN",
};

describe("LLM gateway request semantics", () => {
  it("requires a named tool to exist", () => {
    expect(() =>
      validateLLMRequestSemantics(
        { model, messages: [], tools: [tool], toolChoice: { type: "TOOL", toolName: "missing" } },
        capabilities,
      ),
    ).toThrow(LLMInvalidRequestError);
  });

  it("requires tools for REQUIRED and rejects duplicate tool names", () => {
    expect(() =>
      validateLLMRequestSemantics(
        { model, messages: [], toolChoice: { type: "REQUIRED" } },
        capabilities,
      ),
    ).toThrow(LLMInvalidRequestError);
    expect(() =>
      validateLLMRequestSemantics(
        { model, messages: [], tools: [tool, tool] },
        capabilities,
      ),
    ).toThrow(LLMInvalidRequestError);
  });

  it("rejects unsupported tool calling and known output limits", () => {
    expect(() =>
      validateLLMRequestSemantics(
        { model, messages: [], tools: [tool] },
        { ...capabilities, toolCalling: "UNSUPPORTED" },
      ),
    ).toThrow(LLMCapabilityUnsupportedError);
    expect(() =>
      validateLLMRequestSemantics(
        { model, messages: [], maxOutputTokens: 101 },
        { ...capabilities, maxOutputTokens: 100 },
      ),
    ).toThrow(LLMInvalidRequestError);
  });

  it("allows unknown output limits and validates timeout values", () => {
    expect(() =>
      validateLLMRequestSemantics(
        { model, messages: [], maxOutputTokens: 100_000 },
        { ...capabilities, maxOutputTokens: undefined },
      ),
    ).not.toThrow();
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateTimeoutMs(timeoutMs)).toThrow(LLMInvalidRequestError);
    }
    expect(() => validateTimeoutMs(1)).not.toThrow();
  });
});
