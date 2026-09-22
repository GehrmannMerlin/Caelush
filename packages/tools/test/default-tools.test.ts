import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILTIN_TOOL_ORDER,
  ToolRegistryBuilder,
  createDefaultBuiltinToolRegistrations,
} from "../src/index.js";

describe("default built-in catalog", () => {
  it("uses one injected resolver and the canonical order", async () => {
    const resolver = createLocalRuntimeResolver(new LocalRuntime());
    const registrations = createDefaultBuiltinToolRegistrations(resolver);
    const builder = new ToolRegistryBuilder();
    for (const registration of registrations) builder.register(registration);
    const registry = await builder.build();
    expect(registry.names()).toEqual(DEFAULT_BUILTIN_TOOL_ORDER);
    expect(registry.modelDefinitions().map((definition) => definition.name)).toEqual(
      DEFAULT_BUILTIN_TOOL_ORDER,
    );
    expect(registrations.every((registration) => registration.handler !== undefined)).toBe(true);

    for (const definition of registry.modelDefinitions()) {
      // Phase 4E moved usage guidance out of `AIToolSpec.description`. The description is now the
      // stable, concise statement of what the Tool is; the eight guidance fields travel as a Coding
      // `promptSnippet` through the budgeted Context path instead, exactly once.
      expect(Buffer.byteLength(definition.description, "utf8")).toBeLessThanOrEqual(256);
      expect(definition.description).not.toContain("Purpose:");
      expect(definition.description).not.toContain("When:");
      expect(definition.description).not.toContain("When not:");
      expect(definition.description).not.toContain("Args:");
      expect(definition.description).not.toContain("Side effects:");
      expect(definition.description).not.toContain("Safety:");
      expect(definition.description).not.toContain("Results:");
    }
    const readFile = registry.resolve("read_file")?.definition.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(readFile.offset?.default).toBe(1);
    expect(readFile.limit?.default).toBe(400);
    const exec = registry.resolve("exec_command")?.definition;
    const execProperties = exec?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(execProperties.yield_time_ms?.description).toContain("yield_time_ms");
    expect(exec?.inputSchema).not.toHaveProperty("properties.timeout_ms");
    expect(exec?.inputSchema).not.toHaveProperty("properties.background");
    expect(exec?.inputSchema).not.toHaveProperty("properties.shell");
  });
});
