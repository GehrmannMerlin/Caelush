import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILTIN_TOOL_ORDER,
  ToolRegistryBuilder,
  createDefaultBuiltinToolRegistrations,
} from "../src/index.js";

describe("default built-in catalog", () => {
  it("uses one injected resolver and the canonical order", () => {
    const resolver = createLocalRuntimeResolver(new LocalRuntime());
    const registrations = createDefaultBuiltinToolRegistrations(resolver);
    const builder = new ToolRegistryBuilder();
    for (const registration of registrations) builder.register(registration);
    const registry = builder.build();
    expect(registry.names()).toEqual(DEFAULT_BUILTIN_TOOL_ORDER);
    expect(registry.modelDefinitions().map((definition) => definition.name)).toEqual(
      DEFAULT_BUILTIN_TOOL_ORDER,
    );
    expect(registrations.every((registration) => registration.handler !== undefined)).toBe(true);

    for (const definition of registry.modelDefinitions()) {
      expect(Buffer.byteLength(definition.description, "utf8")).toBeLessThanOrEqual(256);
      expect(definition.description).toContain("Purpose:");
      expect(definition.description).toContain("When:");
      expect(definition.description).toContain("When not:");
      expect(definition.description).toContain("Side effects:");
      expect(definition.description).toContain("Safety:");
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
