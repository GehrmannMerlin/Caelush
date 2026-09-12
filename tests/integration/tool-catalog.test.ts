import type { ToolDefinition } from "../../packages/protocol/src/index.js";
import { describe, expect, it } from "vitest";
import { LLMRequestSchema } from "../../packages/llm/src/request.js";
import { toAIToolSpec } from "../../packages/llm/src/compatibility/request-projection.js";
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
  it("feeds the registry catalog into LLMRequest and strips runtime metadata at the AI boundary", () => {
    const handler: ToolHandler = {
      async execute() {
        return { content: "unused", details: { echoed: "unused" }, isError: false };
      },
    };
    const registry = new ToolRegistryBuilder().register({ definition, handler }).build();
    const modelDefinitions = registry.modelDefinitions();

    const parsed = LLMRequestSchema.parse({
      model: { provider: "local", model: "test-model" },
      messages: [{ role: "user", content: "echo hello" }],
      tools: modelDefinitions,
    });
    expect(parsed.tools).toEqual(modelDefinitions);

    // The provider-facing projection is the legacy boundary's job since Phase 2B;
    // the SDK translation itself lives in `@caelush/ai` and is covered there.
    const projected = parsed.tools?.map(toAIToolSpec);
    expect(projected).toHaveLength(1);
    expect(projected?.[0]).toEqual({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    });

    const serialized = JSON.stringify(projected);
    for (const forbidden of [
      "riskLevel",
      "CRITICAL",
      "requiredCapabilities",
      "FS_READ",
      "runtimeRequirements",
      "outputSchema",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
