import type { AgentTool, AgentToolRegistry } from "@caelush/agent";
import { DefaultAgentToolRegistryBuilder } from "@caelush/agent";
import type { JsonObject } from "@caelush/ai";
import { describe, expect, it } from "vitest";
import {
  CodingToolCatalogBuilder,
  CodingToolCatalogError,
  DEFAULT_MAX_CODING_TOOLS,
  createCodingToolCatalog,
  normalizeToolArgumentsForCompatibility,
  type CodingToolDefinition,
} from "@caelush/coding-agent";

/**
 * The Coding Tool overlay.
 *
 * ```text
 * AgentToolRegistry   the executable, general Tools
 * CodingToolCatalog   the Coding metadata keyed by the same ToolName
 * ```
 *
 * The catalog is an *overlay*, not a mirror: every catalog name must resolve in the active registry,
 * and a purely generic Tool may have no Coding metadata at all.
 */

const inputSchema: JsonObject = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

function agentTool(name: string): AgentTool {
  return {
    name,
    description: `Tool ${name}.`,
    inputSchema,
    label: name,
    resultDetailsSchema: { type: "object", additionalProperties: false },
    executionMode: "SEQUENTIAL",
    execute: async () => ({ content: "ok", details: {}, isError: false }),
  };
}

function registryWith(names: readonly string[]): AgentToolRegistry {
  const builder = new DefaultAgentToolRegistryBuilder();
  for (const name of names) builder.register(agentTool(name));
  return builder.build();
}

function codingDefinition(
  name: string,
  overrides: Partial<CodingToolDefinition> = {},
): CodingToolDefinition {
  return {
    tool: agentTool(name),
    security: {
      riskLevel: "LOW",
      requiredCapabilities: ["FS_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    },
    ...overrides,
  };
}

describe("CodingToolCatalog", () => {
  it("keys Coding metadata by ToolName and preserves registration order", () => {
    const registry = registryWith(["read_file", "exec_command"]);
    const catalog = createCodingToolCatalog({
      registry,
      definitions: [
        codingDefinition("read_file"),
        codingDefinition("exec_command", {
          security: {
            riskLevel: "HIGH",
            requiredCapabilities: ["SHELL_EXEC", "PROCESS_START"],
            runtimeRequirements: { runtimeKinds: ["local"] },
          },
        }),
      ],
    });

    expect(catalog.size).toBe(2);
    expect(catalog.names()).toEqual(["read_file", "exec_command"]);
    expect(catalog.has("read_file")).toBe(true);
    expect(catalog.has("missing_tool")).toBe(false);
    expect(catalog.get("exec_command")?.security.riskLevel).toBe("HIGH");
    expect(catalog.get("missing_tool")).toBeUndefined();
  });

  it("requires the executable AgentTool to be the field named `tool`", () => {
    const registry = registryWith(["read_file"]);
    const definition = codingDefinition("read_file");
    const catalog = createCodingToolCatalog({ registry, definitions: [definition] });

    // `CodingToolDefinition` composes an AgentTool rather than extending one: the Coding metadata
    // never travels on the executable Tool the registry resolves.
    expect(catalog.get("read_file")?.tool.name).toBe("read_file");
    expect(catalog.get("read_file")).not.toHaveProperty("agentTool");
    expect(catalog.get("read_file")).not.toHaveProperty("execute");
  });

  it("carries security facts, effects, presentation and prompt snippets as data", () => {
    const registry = registryWith(["read_file"]);
    const facts = { resourceAccesses: [{ operation: "READ", path: "src/index.ts" }] };
    const catalog = createCodingToolCatalog({
      registry,
      definitions: [
        codingDefinition("read_file", {
          securityFactsProjector: () => facts,
          effectProjector: () => [],
          promptSnippet: "Prefer read_file over a shell read.",
        }),
      ],
    });

    const entry = catalog.get("read_file")!;
    expect(entry.securityFactsProjector?.({ path: "x" })).toBe(facts);
    expect(
      entry.effectProjector?.({
        request: { path: "x" },
        result: { content: "", details: {}, isError: false },
        now: 1,
      }),
    ).toEqual([]);
    expect(entry.promptSnippet).toBe("Prefer read_file over a shell read.");
  });

  it("rejects a dangling Coding entry that the active registry cannot execute", () => {
    const registry = registryWith(["read_file"]);

    expect(() =>
      createCodingToolCatalog({
        registry,
        definitions: [codingDefinition("read_file"), codingDefinition("apply_patch")],
      }),
    ).toThrowError(
      expect.objectContaining({ reason: "DANGLING_CODING_TOOL", toolName: "apply_patch" }),
    );
  });

  it("rejects a duplicate Coding entry instead of shadowing it", () => {
    const builder = new CodingToolCatalogBuilder().forRegistry(registryWith(["read_file"]));
    builder.register(codingDefinition("read_file"));

    expect(() => builder.register(codingDefinition("read_file"))).toThrowError(
      expect.objectContaining({ reason: "DUPLICATE_CODING_TOOL" }),
    );
  });

  it("rejects a malformed definition and a non-positive limit", () => {
    const builder = new CodingToolCatalogBuilder();
    expect(() => builder.register({} as CodingToolDefinition)).toThrowError(
      expect.objectContaining({ reason: "INVALID_CODING_TOOL" }),
    );
    expect(() => new CodingToolCatalogBuilder({ maxTools: 0 })).toThrowError(
      CodingToolCatalogError,
    );
    expect(DEFAULT_MAX_CODING_TOOLS).toBe(64);
  });

  it("finalizes on build and returns the same catalog for a repeated build", () => {
    const builder = new CodingToolCatalogBuilder().forRegistry(registryWith(["read_file"]));
    builder.register(codingDefinition("read_file"));
    const catalog = builder.build();

    expect(builder.build()).toBe(catalog);
    expect(() => builder.register(codingDefinition("exec_command"))).toThrowError(
      expect.objectContaining({ reason: "CATALOG_BUILDER_FINALIZED" }),
    );
  });

  it("builds an unaligned overlay when no registry was declared", () => {
    const builder = new CodingToolCatalogBuilder();
    builder.register(codingDefinition("anything_at_all"));

    // No correspondence claim is made, so nothing is dangling.
    expect(builder.build().names()).toEqual(["anything_at_all"]);
  });

  it("ignores caller mutation and refuses to let a returned names view change it", () => {
    const registry = registryWith(["read_file"]);
    const mutable = codingDefinition("read_file");
    const catalog = createCodingToolCatalog({ registry, definitions: [mutable] });

    (mutable.security as { riskLevel: string }).riskLevel = "CRITICAL";
    expect(catalog.get("read_file")?.security.riskLevel).toBe("LOW");

    const names = catalog.names() as string[];
    expect(() => names.push("injected")).toThrow();
    expect(catalog.names()).toEqual(["read_file"]);
  });

  it("never executes policy, a Runtime operation or an effect", () => {
    const registry = registryWith(["read_file"]);
    let called = 0;
    const catalog = createCodingToolCatalog({
      registry,
      definitions: [
        codingDefinition("read_file", {
          securityFactsProjector: () => {
            called += 1;
            return { resourceAccesses: [] };
          },
          effectProjector: () => {
            called += 1;
            return [];
          },
        }),
      ],
    });

    expect(catalog.get("read_file")).toBeDefined();
    expect(called).toBe(0);
  });
});

describe("Coding Tool numeric compatibility normalization", () => {
  const numericSchema: JsonObject = {
    type: "object",
    properties: {
      cmd: { type: "string" },
      yield_time_ms: { type: "integer", minimum: 250, maximum: 30000 },
      ratio: { type: "number" },
      nested: {
        type: "object",
        properties: { retries: { type: "integer", minimum: 0 } },
        additionalProperties: false,
      },
      items: { type: "array", items: { type: "integer" } },
    },
    required: ["cmd"],
    additionalProperties: false,
  };

  it("converts only fields the schema declares as number or integer", () => {
    const normalized = normalizeToolArgumentsForCompatibility(
      { inputSchema: numericSchema },
      {
        cmd: "3",
        yield_time_ms: "3000",
        ratio: "0.5",
        nested: { retries: "2" },
        items: ["1", "2"],
      },
    );

    expect(normalized).toEqual({
      cmd: "3",
      yield_time_ms: 3000,
      ratio: 0.5,
      nested: { retries: 2 },
      items: [1, 2],
    });
  });

  it("leaves fuzzy strings, unsafe integers and undeclared fields alone", () => {
    const normalized = normalizeToolArgumentsForCompatibility(
      { inputSchema: numericSchema },
      {
        cmd: "pnpm test",
        yield_time_ms: "soon",
        ratio: "3 seconds",
        nested: { retries: "9007199254740992" },
        items: ["0x10"],
        extra: "9",
      },
    );

    expect(normalized.yield_time_ms).toBe("soon");
    expect(normalized.ratio).toBe("3 seconds");
    expect((normalized.nested as JsonObject).retries).toBe("9007199254740992");
    expect(normalized.items).toEqual(["0x10"]);
    expect(normalized.extra).toBe("9");
  });

  it("never mutates the caller's arguments", () => {
    const raw: JsonObject = { cmd: "pnpm test", yield_time_ms: "3000" };
    normalizeToolArgumentsForCompatibility({ inputSchema: numericSchema }, raw);

    expect(raw).toEqual({ cmd: "pnpm test", yield_time_ms: "3000" });
  });

  it("injects no default and removes no property", () => {
    const normalized = normalizeToolArgumentsForCompatibility(
      { inputSchema: numericSchema },
      { cmd: "pnpm test", unknown_property: true },
    );

    expect(normalized).toEqual({ cmd: "pnpm test", unknown_property: true });
  });
});
