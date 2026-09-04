import type { ToolDefinition } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createBuiltinToolModelGuidance,
  filterToolRegistryForEnvironment,
  ToolRegistryBuilder,
  type ToolHandler,
} from "../src/index.js";

const names = ["read_file", "git_status", "git_diff"] as const;
const handler: ToolHandler = {
  execute: async () => ({ content: "ok", details: {}, isError: false }),
};

function registry() {
  const builder = new ToolRegistryBuilder();
  for (const name of names) {
    const definition: ToolDefinition = {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
      riskLevel: "LOW",
      requiredCapabilities: [],
      runtimeRequirements: {},
    };
    builder.register({ definition, handler, modelGuidance: createBuiltinToolModelGuidance(name) });
  }
  return builder.build();
}

describe("environment-aware Tool exposure", () => {
  it("filters Git tools and their guidance together for a non-Git workspace", () => {
    const filtered = filterToolRegistryForEnvironment(registry(), { git: "UNAVAILABLE" });
    expect(filtered.names()).toEqual(["read_file"]);
    expect(filtered.modelDefinitions().map((tool) => tool.name)).toEqual(["read_file"]);
    expect(filtered.modelGuidance().map((entry) => entry.toolName)).toEqual(["read_file"]);
    expect(filtered.resolve("git_status")).toBeUndefined();
  });

  it("fails closed for unknown capability and preserves Git tools only when available", () => {
    const source = registry();
    expect(filterToolRegistryForEnvironment(source, { git: "UNKNOWN" }).names()).toEqual([
      "read_file",
    ]);
    const available = filterToolRegistryForEnvironment(source, { git: "AVAILABLE" });
    expect(available.names()).toEqual(names);
    expect(Object.isFrozen(available.modelDefinitions())).toBe(true);
    expect(Object.isFrozen(available.modelGuidance())).toBe(true);
  });
});
