import type { ToolDefinition } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_REGISTRY_OPTIONS } from "../src/options.js";
import type { ToolHandler, ToolRegistration } from "../src/index.js";
import { ToolRegistryBuilder } from "../src/registry-builder.js";

const handler: ToolHandler = {
  async execute() {
    return { content: "unused", details: {}, isError: false };
  },
};

function definition(name: string, description = `Description for ${name}.`): ToolDefinition {
  return {
    name,
    description,
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

function registration(name: string, description?: string): ToolRegistration {
  return { definition: definition(name, description), handler };
}

describe("ToolRegistryBuilder", () => {
  it("builds an ordered registry and returns the same instance on repeat build", async () => {
    const builder = new ToolRegistryBuilder();
    builder.register(registration("echo_value")).register(registration("lookup_value"));

    const registry = await builder.build();

    expect(registry.names()).toEqual(["echo_value", "lookup_value"]);
    expect(await builder.build()).toBe(registry);
  });

  it("rejects duplicate names without shadowing", () => {
    const builder = new ToolRegistryBuilder();
    builder.register(registration("echo_value"));

    expect(() => builder.register(registration("echo_value"))).toThrowError(
      expect.objectContaining({ reason: "DUPLICATE_TOOL_NAME" }),
    );
  });

  it("rejects registration after successful build", async () => {
    const builder = new ToolRegistryBuilder();
    builder.register(registration("echo_value"));
    await builder.build();

    expect(() => builder.register(registration("lookup_value"))).toThrowError(
      expect.objectContaining({ reason: "BUILDER_FINALIZED" }),
    );
  });

  it("fails atomically for invalid schemas and budget overflow", async () => {
    const invalidBuilder = new ToolRegistryBuilder();
    invalidBuilder.register({
      definition: {
        ...definition("invalid_schema"),
        // A remote reference is not compilable by the frozen schema runtime, so this fails inside the
        // schema compiler rather than in the semantic policy in front of it.
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { value: { $ref: "https://example.com/value.json" } },
        },
      },
      handler,
    });
    expect(() => invalidBuilder.build()).toThrowError(
      expect.objectContaining({ reason: "INVALID_INPUT_SCHEMA", toolName: "invalid_schema" }),
    );

    const policyBuilder = new ToolRegistryBuilder();
    policyBuilder.register({
      definition: {
        ...definition("open_schema"),
        inputSchema: { type: "object", additionalProperties: true },
      },
      handler,
    });
    expect(() => policyBuilder.build()).toThrowError(
      expect.objectContaining({ reason: "INPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE" }),
    );

    const budgetBuilder = new ToolRegistryBuilder({
      ...DEFAULT_TOOL_REGISTRY_OPTIONS,
      maxCatalogBytes: 10,
    });
    budgetBuilder.register(registration("echo_value"));
    expect(() => budgetBuilder.build()).toThrowError(
      expect.objectContaining({ reason: "TOOL_CATALOG_TOO_LARGE" }),
    );
  });

  it("enforces the tool count limit", () => {
    const builder = new ToolRegistryBuilder({ ...DEFAULT_TOOL_REGISTRY_OPTIONS, maxTools: 1 });
    builder.register(registration("echo_value"));

    expect(() => builder.register(registration("lookup_value"))).toThrowError(
      expect.objectContaining({ reason: "TOOL_LIMIT_EXCEEDED" }),
    );
  });
});
