import type { ToolDefinition } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { ToolHandler, ToolRegistration } from "../src/index.js";
import { ToolRegistryBuilder } from "../src/registry-builder.js";

function createDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `Return ${name} value.`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { echoed: { type: "string" } },
      required: ["echoed"],
      additionalProperties: false,
    },
    riskLevel: "LOW",
    requiredCapabilities: [],
    runtimeRequirements: {},
  };
}

describe("tool catalog and runtime consistency", () => {
  it("derives every model definition from a resolvable registration", () => {
    let executionCount = 0;
    const handler: ToolHandler = {
      async execute() {
        executionCount += 1;
        return { content: "never", details: { echoed: "never" }, isError: false };
      },
    };
    const registrations: ToolRegistration[] = [
      { definition: createDefinition("echo_value"), handler },
      { definition: createDefinition("lookup_value"), handler },
    ];
    const registry = new ToolRegistryBuilder()
      .register(registrations[0]!)
      .register(registrations[1]!)
      .build();

    const definitions = registry.modelDefinitions();
    expect(definitions).toHaveLength(2);
    expect(registry.size).toBe(registry.names().length);
    expect(definitions.map(({ name }) => name)).toEqual(registry.names());
    for (const modelDefinition of definitions) {
      const resolved = registry.resolve(modelDefinition.name);
      expect(resolved).toBeDefined();
      expect(resolved?.definition).toBe(modelDefinition);
      expect(resolved?.inputValidator.validate({ value: "hello" })).toEqual({ valid: true });
      expect(resolved?.inputValidator.validate({ value: 1 })).toMatchObject({ valid: false });
      expect(resolved?.inputValidator.validate({ value: "hello", extra: true })).toMatchObject({
        valid: false,
      });
      expect(resolved?.outputValidator.validate({ echoed: "hello" })).toEqual({ valid: true });
      expect(resolved?.outputValidator.validate({ echoed: 1 })).toMatchObject({ valid: false });
    }
    expect(executionCount).toBe(0);
  });
});
