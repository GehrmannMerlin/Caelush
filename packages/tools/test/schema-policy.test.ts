import type { ToolDefinition } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ToolRegistrationError } from "../src/errors.js";
import { DEFAULT_TOOL_REGISTRY_OPTIONS } from "../src/options.js";
import { validateToolDefinitionSemantics } from "../src/schema-policy.js";
import { ToolSchemaRuntime } from "../src/schema-runtime.js";

const baseDefinition: ToolDefinition = {
  name: "echo_value",
  description: "Return a value.",
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

function definitionWith(changes: Partial<ToolDefinition>): ToolDefinition {
  return { ...baseDefinition, ...changes };
}

describe("tool definition semantic policy", () => {
  it("compiles valid input and output schemas without rewriting them", () => {
    const result = validateToolDefinitionSemantics(
      baseDefinition,
      DEFAULT_TOOL_REGISTRY_OPTIONS,
      new ToolSchemaRuntime(),
    );

    expect(result.input.validate({ value: "hello" })).toEqual({ valid: true });
    expect(result.output.validate({ echoed: "hello" })).toEqual({ valid: true });
  });

  it.each([
    ["whitespace description", definitionWith({ description: "   " }), "EMPTY_DESCRIPTION"],
    [
      "input root",
      definitionWith({ inputSchema: { type: "array", items: { type: "string" } } }),
      "INPUT_SCHEMA_NOT_OBJECT",
    ],
    [
      "input additionalProperties",
      definitionWith({
        inputSchema: { type: "object", additionalProperties: true },
      }),
      "INPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE",
    ],
    [
      "output additionalProperties",
      definitionWith({
        outputSchema: { type: "object", additionalProperties: true },
      }),
      "OUTPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE",
    ],
    [
      "remote ref",
      definitionWith({
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { value: { $ref: "https://example.com/value.json" } },
        },
      }),
      "INVALID_INPUT_SCHEMA",
    ],
    [
      "async schema",
      definitionWith({
        inputSchema: { type: "object", additionalProperties: false, $async: true },
      }),
      "INVALID_INPUT_SCHEMA",
    ],
  ])("rejects %s with reason %s", (_label, definition, reason) => {
    expect(() =>
      validateToolDefinitionSemantics(
        definition,
        DEFAULT_TOOL_REGISTRY_OPTIONS,
        new ToolSchemaRuntime(),
      ),
    ).toThrowError(expect.objectContaining({ reason }));
  });

  it("rejects oversized descriptions and schemas without compaction", () => {
    expect(() =>
      validateToolDefinitionSemantics(
        definitionWith({ description: "x".repeat(10) }),
        { ...DEFAULT_TOOL_REGISTRY_OPTIONS, maxDescriptionBytes: 9 },
        new ToolSchemaRuntime(),
      ),
    ).toThrowError(expect.objectContaining({ reason: "TOOL_DESCRIPTION_TOO_LARGE" }));

    expect(() =>
      validateToolDefinitionSemantics(
        baseDefinition,
        { ...DEFAULT_TOOL_REGISTRY_OPTIONS, maxInputSchemaBytes: 10 },
        new ToolSchemaRuntime(),
      ),
    ).toThrowError(expect.objectContaining({ reason: "TOOL_SCHEMA_TOO_LARGE" }));
  });

  it("accepts local definitions and rejects malformed schemas closed", () => {
    const definition = definitionWith({
      inputSchema: {
        $defs: { value: { type: "string" } },
        type: "object",
        properties: { value: { $ref: "#/$defs/value" } },
        required: ["value"],
        additionalProperties: false,
      },
    });
    expect(() =>
      validateToolDefinitionSemantics(
        definition,
        DEFAULT_TOOL_REGISTRY_OPTIONS,
        new ToolSchemaRuntime(),
      ),
    ).not.toThrow();

    expect(() =>
      validateToolDefinitionSemantics(
        definitionWith({
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["missing"],
            additionalProperties: false,
          },
        }),
        DEFAULT_TOOL_REGISTRY_OPTIONS,
        new ToolSchemaRuntime(),
      ),
    ).toThrowError(ToolRegistrationError);
  });
});
