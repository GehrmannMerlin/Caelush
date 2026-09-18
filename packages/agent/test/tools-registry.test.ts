import type { JsonObject } from "@caelush/ai";
import { describe, expect, it } from "vitest";
import {
  AgentToolRegistrationError,
  AgentToolRegistryStateError,
  DEFAULT_TOOL_REGISTRY_OPTIONS,
  DefaultAgentToolRegistryBuilder,
  type AgentTool,
} from "@caelush/agent";

/**
 * The canonical registry contract.
 *
 * Every case here is behaviour the legacy registry already had and that the migration had to keep:
 * duplicate rejection, the tool limit, stable order, immutability under caller mutation and the
 * exact three-field model projection. The canonical registry is now the one implementation of each.
 */

const inputSchema: JsonObject = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};

const resultSchema: JsonObject = {
  type: "object",
  properties: { echoed: { type: "string" } },
  required: ["echoed"],
  additionalProperties: false,
};

function tool(name: string, overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name,
    description: `Tool ${name}.`,
    inputSchema,
    label: `Tool ${name}`,
    resultDetailsSchema: resultSchema,
    executionMode: "SEQUENTIAL",
    execute: async () => ({ content: "ok", details: { echoed: "ok" }, isError: false }),
    ...overrides,
  };
}

describe("AgentToolRegistry", () => {
  it("resolves Tools, ordering and compiled validators without executing anything", async () => {
    let executions = 0;
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(
      tool("echo_value", {
        execute: async () => {
          executions += 1;
          return { content: "ok", details: { echoed: "ok" }, isError: false };
        },
      }),
    );
    builder.register(tool("lookup_value"));
    const registry = builder.build();

    expect(registry.size).toBe(2);
    expect(registry.names()).toEqual(["echo_value", "lookup_value"]);
    expect(registry.has("echo_value")).toBe(true);
    expect(registry.has("missing_tool")).toBe(false);
    expect(registry.resolve("missing_tool")).toBeUndefined();

    const resolved = registry.resolve("echo_value");
    expect(resolved?.tool.name).toBe("echo_value");
    expect(resolved?.inputValidator.validate({ value: "hello" })).toEqual({ valid: true });
    expect(resolved?.inputValidator.validate({ value: 1 })).toMatchObject({ valid: false });
    expect(resolved?.inputValidator.validate({ value: "hello", extra: true })).toMatchObject({
      valid: false,
    });
    expect(resolved?.resultValidator.validate({ echoed: "hello" })).toEqual({ valid: true });
    expect(resolved?.resultValidator.validate({})).toMatchObject({ valid: false });
    expect(executions).toBe(0);
  });

  it("rejects duplicate names instead of shadowing them", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(tool("echo_value"));

    expect(() => builder.register(tool("echo_value"))).toThrowError(
      expect.objectContaining({ reason: "DUPLICATE_TOOL_NAME", toolName: "echo_value" }),
    );
    expect(builder.build().size).toBe(1);
  });

  it("enforces the tool count limit", () => {
    const builder = new DefaultAgentToolRegistryBuilder({
      ...DEFAULT_TOOL_REGISTRY_OPTIONS,
      maxTools: 1,
    });
    builder.register(tool("echo_value"));

    expect(() => builder.register(tool("lookup_value"))).toThrowError(
      expect.objectContaining({ reason: "TOOL_LIMIT_EXCEEDED" }),
    );
  });

  it("finalizes on build and returns the same registry for a repeated build", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(tool("echo_value"));
    const registry = builder.build();

    expect(builder.build()).toBe(registry);
    expect(() => builder.register(tool("lookup_value"))).toThrowError(AgentToolRegistryStateError);
    expect(() => builder.register(tool("lookup_value"))).toThrowError(
      expect.objectContaining({ reason: "BUILDER_FINALIZED" }),
    );
  });

  it("rejects an invalid Tool registration before it can reach the registry", () => {
    const builder = new DefaultAgentToolRegistryBuilder();

    expect(() => builder.register({} as unknown as AgentTool)).toThrowError(
      AgentToolRegistrationError,
    );
    expect(() => builder.register(tool("NotAToolName"))).toThrowError(
      expect.objectContaining({ reason: "INVALID_DEFINITION" }),
    );
  });

  it("refuses an open input schema, an open result schema and an oversized description", () => {
    const open = new DefaultAgentToolRegistryBuilder();
    open.register(tool("open_tool", { inputSchema: { type: "object" } }));
    expect(() => open.build()).toThrowError(
      expect.objectContaining({ reason: "INPUT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE" }),
    );

    const openResult = new DefaultAgentToolRegistryBuilder();
    openResult.register(tool("open_result", { resultDetailsSchema: { type: "object" } }));
    expect(() => openResult.build()).toThrowError(
      expect.objectContaining({ reason: "RESULT_SCHEMA_ADDITIONAL_PROPERTIES_NOT_FALSE" }),
    );

    const wordy = new DefaultAgentToolRegistryBuilder({
      ...DEFAULT_TOOL_REGISTRY_OPTIONS,
      maxDescriptionBytes: 4,
    });
    wordy.register(tool("wordy_tool"));
    expect(() => wordy.build()).toThrowError(
      expect.objectContaining({ reason: "TOOL_DESCRIPTION_TOO_LARGE" }),
    );
  });

  it("refuses external references and async schemas", () => {
    const remoteRef = new DefaultAgentToolRegistryBuilder();
    remoteRef.register(
      tool("remote_ref", {
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { value: { $ref: "https://example.com/value.json" } },
        },
      }),
    );
    expect(() => remoteRef.build()).toThrowError(
      expect.objectContaining({ reason: "INVALID_INPUT_SCHEMA" }),
    );

    const asyncSchema = new DefaultAgentToolRegistryBuilder();
    asyncSchema.register(
      tool("async_schema", {
        inputSchema: { type: "object", additionalProperties: false, $async: true },
      }),
    );
    expect(() => asyncSchema.build()).toThrowError(
      expect.objectContaining({ reason: "INVALID_INPUT_SCHEMA" }),
    );
  });

  it("does not coerce, default or strip anything while validating", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(
      tool("typed_tool", {
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "integer", default: 7 },
            label: { type: "string" },
          },
          required: ["label"],
          additionalProperties: false,
        },
      }),
    );
    const registry = builder.build();
    const validator = registry.resolve("typed_tool")!.inputValidator;

    // No coercion: a string where an integer is declared is a violation, not a conversion.
    expect(validator.validate({ label: "x", count: "3" })).toMatchObject({ valid: false });
    // No defaults: the missing optional property is not injected, and the call is still valid.
    expect(validator.validate({ label: "x" })).toEqual({ valid: true });
    // No property removal: an unknown property is a violation, not something to drop.
    expect(validator.validate({ label: "x", extra: true })).toMatchObject({ valid: false });
  });

  it("bounds the model catalog by the AI-visible spec only", () => {
    const builder = new DefaultAgentToolRegistryBuilder({
      ...DEFAULT_TOOL_REGISTRY_OPTIONS,
      maxCatalogBytes: 10,
    });
    builder.register(tool("echo_value"));

    expect(() => builder.build()).toThrowError(
      expect.objectContaining({ reason: "TOOL_CATALOG_TOO_LARGE" }),
    );
  });

  it("validates every registry option as a positive integer", () => {
    expect(
      () =>
        new DefaultAgentToolRegistryBuilder({
          ...DEFAULT_TOOL_REGISTRY_OPTIONS,
          maxTools: 0,
        }),
    ).toThrowError(expect.objectContaining({ reason: "INVALID_REGISTRY_OPTION" }));
    expect(
      () =>
        new DefaultAgentToolRegistryBuilder({
          ...DEFAULT_TOOL_REGISTRY_OPTIONS,
          maxCatalogBytes: Number.NaN,
        }),
    ).toThrowError(expect.objectContaining({ reason: "INVALID_REGISTRY_OPTION" }));
  });

  it("keeps the frozen Phase 7A budget defaults", () => {
    expect(DEFAULT_TOOL_REGISTRY_OPTIONS).toEqual({
      maxTools: 64,
      maxDescriptionBytes: 8192,
      maxInputSchemaBytes: 5000,
      maxResultSchemaBytes: 16384,
      maxCatalogBytes: 256 * 1024,
    });
  });
});

describe("AgentToolRegistry immutability", () => {
  it("ignores a caller mutating the schema it registered", () => {
    const mutableInput: Record<string, unknown> = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    };
    const mutableResult: Record<string, unknown> = { type: "object", additionalProperties: false };
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(
      tool("echo_value", {
        inputSchema: mutableInput as JsonObject,
        resultDetailsSchema: mutableResult as JsonObject,
      }),
    );
    const registry = builder.build();

    mutableInput.properties = { changed: { type: "number" } };
    mutableResult.additionalProperties = true;

    const spec = registry.modelSpecs()[0]!;
    expect(spec.inputSchema.properties).toEqual({ value: { type: "string" } });
    expect(registry.resolve("echo_value")!.tool.resultDetailsSchema.additionalProperties).toBe(
      false,
    );
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.inputSchema)).toBe(true);
  });

  it("ignores a caller mutating the Tool object it registered", () => {
    const mutable = tool("echo_value");
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(mutable);
    const registry = builder.build();

    (mutable as { description: string }).description = "changed";
    (mutable as { executionMode: string }).executionMode = "PARALLEL_SAFE";

    expect(registry.modelSpecs()[0]!.description).toBe("Tool echo_value.");
    expect(registry.resolve("echo_value")!.tool.executionMode).toBe("SEQUENTIAL");
  });

  it("refuses to let a returned names list or model spec change the registry", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(tool("echo_value"));
    const registry = builder.build();

    const names = registry.names() as string[];
    expect(() => names.push("injected")).toThrow();
    expect(registry.names()).toEqual(["echo_value"]);

    const spec = registry.modelSpecs()[0] as { description: string };
    expect(() => {
      spec.description = "changed";
    }).toThrow();
    expect(registry.modelSpecs()[0]!.description).toBe("Tool echo_value.");
    expect(registry.modelSpecs()).toBe(registry.modelSpecs());
  });

  it("never freezes the host object a Tool's execute closure captures", () => {
    const hostState = { count: 0 };
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(
      tool("stateful_tool", {
        execute: async () => {
          hostState.count += 1;
          return { content: "ok", details: {}, isError: false };
        },
      }),
    );
    const registry = builder.build();

    // The registry froze the Tool *description*, not the host object the closure owns.
    expect(Object.isFrozen(hostState)).toBe(false);
    hostState.count = 5;
    expect(hostState.count).toBe(5);
    expect(registry.resolve("stateful_tool")).toBeDefined();
  });
});

describe("AgentToolRegistry model spec projection", () => {
  it("projects exactly name, description and inputSchema", async () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(tool("echo_value"));
    const registry = builder.build();

    const spec = registry.modelSpecs()[0]!;
    expect(Object.keys(spec).sort()).toEqual(["description", "inputSchema", "name"]);
  });

  it("never leaks execution or Coding metadata", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(
      tool("echo_value", {
        label: "Echo",
        prepareArguments: (raw: Readonly<JsonObject>) => raw,
      }),
    );
    const registry = builder.build();

    const serialized = JSON.stringify(registry.modelSpecs());
    for (const forbidden of [
      "execute",
      "prepareArguments",
      "label",
      "resultDetailsSchema",
      "executionMode",
      "riskLevel",
      "requiredCapabilities",
      "runtimeRequirements",
      "securityFactsProjector",
      "effectProjector",
      "presentation",
      "promptSnippet",
    ]) {
      expect(serialized, `modelSpecs must not leak ${forbidden}`).not.toContain(forbidden);
    }
    expect(registry.modelSpecs()[0]).not.toHaveProperty("execute");
  });

  it("preserves registration order across many Tools", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    const names = ["read_file", "list_directory", "find_files", "search_text", "apply_patch"];
    for (const name of names) builder.register(tool(name));
    const registry = builder.build();

    expect(registry.names()).toEqual(names);
    expect(registry.modelSpecs().map((spec) => spec.name)).toEqual(names);
  });
});
