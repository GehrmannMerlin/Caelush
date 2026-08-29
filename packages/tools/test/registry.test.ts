import type { ToolDefinition } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import type { ToolHandler, ToolRegistration } from "../src/index.js";
import { ToolRegistryBuilder } from "../src/registry-builder.js";

const definition: ToolDefinition = {
  name: "echo_value",
  description: "Return the supplied value.",
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
  riskLevel: "HIGH",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { runtime: "local" },
};

const handler: ToolHandler = {
  async execute() {
    throw new Error("must not execute during registry tests");
  },
};

function createRegistry() {
  const registration: ToolRegistration = { definition, handler };
  return new ToolRegistryBuilder().register(registration).build();
}

describe("ToolRegistry", () => {
  it("resolves model definitions and compiled validators without executing handlers", () => {
    const registry = createRegistry();
    const resolved = registry.resolve("echo_value");

    expect(registry.size).toBe(1);
    expect(registry.has("echo_value")).toBe(true);
    expect(registry.has("missing_tool")).toBe(false);
    expect(registry.resolve("missing_tool")).toBeUndefined();
    expect(registry.modelDefinitions()).toEqual([definition]);
    expect(resolved?.handler).toBe(handler);
    expect(resolved?.inputValidator.validate({ value: "hello" })).toEqual({ valid: true });
    expect(resolved?.outputValidator.validate({ echoed: "hello" })).toEqual({ valid: true });
    expect(() => {
      if (resolved !== undefined) {
        (resolved.inputValidator as { validate: () => unknown }).validate = () => ({ valid: true });
      }
    }).toThrow();
  });

  it("freezes copied definitions and nested schemas against caller mutation", () => {
    const mutableDefinition = structuredClone(definition);
    const registry = new ToolRegistryBuilder()
      .register({ definition: mutableDefinition, handler })
      .build();

    mutableDefinition.description = "changed";
    mutableDefinition.inputSchema.properties = { changed: { type: "number" } };

    expect(registry.modelDefinitions()[0]).toMatchObject({
      description: "Return the supplied value.",
      inputSchema: { properties: { value: { type: "string" } } },
    });
    expect(Object.isFrozen(registry.modelDefinitions()[0])).toBe(true);
    expect(Object.isFrozen(registry.modelDefinitions()[0]?.inputSchema)).toBe(true);
  });

  it("does not allow returned definitions to change later snapshots", () => {
    const registry = createRegistry();
    const returned = registry.modelDefinitions()[0] as { description: string };

    expect(() => {
      returned.description = "changed";
    }).toThrow();
    expect(registry.modelDefinitions()[0]?.description).toBe("Return the supplied value.");
  });
});
