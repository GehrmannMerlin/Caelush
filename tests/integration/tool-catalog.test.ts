import type { ToolDefinition } from "../../packages/protocol/src/index.js";
import { describe, expect, it } from "vitest";
import { LLMRequestSchema } from "../../packages/llm/src/request.js";
import { toAISDKTools } from "../../packages/llm/src/providers/openai-compatible/tools.js";
import type { ToolHandler } from "../../packages/tools/src/handler.js";
import { ToolRegistryBuilder } from "../../packages/tools/src/registry-builder.js";

const definition: ToolDefinition = {
  name: "echo_value",
  description: "Return the supplied value.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string", description: "Value to return." } },
    required: ["value"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  },
  riskLevel: "CRITICAL",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { runtime: "local" },
};

describe("ToolRegistry model catalog integration", () => {
  it("feeds the registry catalog into LLMRequest and strips runtime metadata for providers", () => {
    const handler: ToolHandler = {
      async execute() {
        return { content: "unused", details: { echoed: "unused" }, isError: false };
      },
    };
    const registry = new ToolRegistryBuilder().register({ definition, handler }).build();
    const modelDefinitions = registry.modelDefinitions();

    expect(
      LLMRequestSchema.parse({
        model: { provider: "local", model: "test-model" },
        messages: [{ role: "user", content: "echo hello" }],
        tools: modelDefinitions,
      }).tools,
    ).toEqual(modelDefinitions);

    const projected = toAISDKTools(modelDefinitions)?.echo_value;
    expect(projected).toMatchObject({ description: definition.description });
    expect(projected).not.toHaveProperty("riskLevel");
    expect(projected).not.toHaveProperty("requiredCapabilities");
    expect(projected).not.toHaveProperty("runtimeRequirements");
    expect(projected).not.toHaveProperty("outputSchema");
  });
});
