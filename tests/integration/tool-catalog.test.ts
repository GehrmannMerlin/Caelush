import { describe, expect, it } from "vitest";
import { validateAIModelRequest } from "../../packages/ai/src/request/request-validator.js";
import { toAIToolSpec } from "../../packages/core/src/ai-invocation-projection.js";
import { modelDescriptor } from "../../packages/ai/test/support/fixtures.js";
import type { ToolDefinition } from "../../packages/protocol/src/index.js";
import type { ToolHandler } from "../../packages/tools/src/handler.js";
import { ToolRegistryBuilder } from "../../packages/tools/src/registry-builder.js";

/**
 * The ToolRegistry catalog at the AI model-invocation boundary.
 *
 * Phase 2D cut this test over from the retired `@caelush/llm` request schema to the
 * frozen `@caelush/ai` contract, so it now asserts against the surface production
 * actually uses.
 */

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

const MODEL = modelDescriptor({
  ref: { provider: "local", model: "test-model" },
  api: "test-api",
});

describe("ToolRegistry model catalog integration", () => {
  it("feeds the registry catalog into an AI model request and strips runtime metadata", () => {
    const handler: ToolHandler = {
      async execute() {
        return { content: "unused", details: { echoed: "unused" }, isError: false };
      },
    };
    const registry = new ToolRegistryBuilder().register({ definition, handler }).build();
    const specs = registry.modelDefinitions().map(toAIToolSpec);

    // The request is validated against the resolved descriptor, exactly as the agent
    // path validates it before any provider call.
    const request = {
      model: { provider: "local", model: "test-model" },
      messages: [{ role: "user" as const, content: "echo hello" }],
      tools: specs,
      toolChoice: { type: "AUTO" as const },
    };
    validateAIModelRequest(request, MODEL);

    expect(request.tools).toEqual(specs);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toEqual({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    });

    // Runtime metadata is not part of `AIToolSpec` at all, so it has no way to reach a
    // provider request.
    const serialized = JSON.stringify(specs);
    for (const forbidden of [
      "riskLevel",
      "CRITICAL",
      "requiredCapabilities",
      "FS_READ",
      "runtimeRequirements",
      "outputSchema",
      "handler",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });
});
