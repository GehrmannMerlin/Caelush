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
  });
});
