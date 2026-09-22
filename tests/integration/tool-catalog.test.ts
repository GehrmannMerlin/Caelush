import { describe, expect, it } from "vitest";
import { DefaultAgentToolRegistryBuilder, type AgentTool } from "@caelush/agent";
import { validateAIModelRequest } from "../../packages/ai/src/request/request-validator.js";
import { modelDescriptor } from "../../packages/ai/test/support/fixtures.js";

/**
 * The canonical Tool registry catalog at the AI model-invocation boundary.
 *
 * ```text
 * AgentToolRegistry          the executable Tool and its model-facing spec
 *        ↓ modelSpecs()
 * AIToolSpec[]               name · description · inputSchema, frozen
 *        ↓
 * AI model request           validated against the resolved descriptor
 * ```
 *
 * Phase 2D cut this test over from the retired `@caelush/llm` request schema to the frozen
 * `@caelush/ai` contract. Phase 4F cut the registry over too: the legacy `ToolRegistryBuilder` and the
 * Core `toAIToolSpec` projection are both retired, and the canonical registry returns the
 * model-facing spec directly. The property under test is unchanged — runtime metadata cannot reach a
 * provider request — and it is now structural rather than projected: there is no wider Tool shape for
 * it to hide in on the way out.
 */

const tool: AgentTool = {
  name: "echo_value",
  description: "Return the supplied value.",
  label: "Echo value",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string", description: "Value to return." } },
    required: ["value"],
    additionalProperties: false,
  },
  resultDetailsSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  },
  executionMode: "SEQUENTIAL",
  async execute() {
    return { content: "unused", details: { echoed: "unused" }, isError: false };
  },
};

const MODEL = modelDescriptor({
  ref: { provider: "local", model: "test-model" },
  api: "test-api",
});

describe("canonical Tool registry model catalog integration", () => {
  it("feeds the registry catalog into an AI model request and strips runtime metadata", () => {
    const registry = new DefaultAgentToolRegistryBuilder().register(tool).build();
    const specs = registry.modelSpecs();

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
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });

    // Runtime metadata is not part of `AIToolSpec` at all, so it has no way to reach a provider
    // request. The registry holds it on the executable Tool and never on the model spec.
    const serialized = JSON.stringify(specs);
    for (const forbidden of [
      "riskLevel",
      "requiredCapabilities",
      "runtimeRequirements",
      "outputSchema",
      "resultDetailsSchema",
      "label",
      "executionMode",
      "execute",
      "prepareArguments",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }

    // And the executable Tool is still resolvable by name: one registry, one catalog, never two. The
    // registry deep-copies and re-freezes the Tool at registration, so the resolved value is equal to
    // what was registered rather than the same object reference.
    expect(registry.names()).toEqual(["echo_value"]);
    expect(registry.resolve("echo_value")?.tool).toEqual(tool);
    expect(registry.resolve("echo_value")?.tool.name).toBe(tool.name);
  });
});
