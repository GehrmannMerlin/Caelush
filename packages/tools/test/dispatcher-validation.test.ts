import { describe, expect, it } from "vitest";
import { ToolSchemaRuntime, type ResolvedTool } from "../src/index.js";
import { validateToolExecutionResult } from "../src/result-validation.js";

const resolvedTool = {
  definition: {
    name: "echo_value",
    description: "Echo a value.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { echoed: { type: "string" } },
      required: ["echoed"],
      additionalProperties: false,
    },
    riskLevel: "LOW",
    requiredCapabilities: [],
    runtimeRequirements: {},
  },
  handler: { execute: async () => ({ content: "", details: {}, isError: false }) },
  inputValidator: new ToolSchemaRuntime().compile({ type: "object", additionalProperties: false }),
  outputValidator: new ToolSchemaRuntime().compile({
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  }),
} as unknown as ResolvedTool;

describe("tool execution result validation", () => {
  it("rejects malformed runtime values instead of trusting TypeScript", () => {
    expect(() => validateToolExecutionResult(null, resolvedTool)).toThrow(/result/i);
    expect(() =>
      validateToolExecutionResult(
        { content: 1, details: { echoed: "hello" }, isError: false },
        resolvedTool,
      ),
    ).toThrow(/result/i);
  });

  it("rejects details that violate the registered output schema", () => {
    expect(() =>
      validateToolExecutionResult(
        { content: "safe", details: { echoed: 42 }, isError: false },
        resolvedTool,
      ),
    ).toThrow(/output/i);
  });

  it("rejects oversized details without lossy truncation", () => {
    expect(() =>
      validateToolExecutionResult(
        { content: "safe", details: { echoed: "hello" }, isError: false },
        resolvedTool,
        { maxModelContentBytes: 100, maxDetailsBytes: 4 },
      ),
    ).toThrow(/details/i);
  });
});
