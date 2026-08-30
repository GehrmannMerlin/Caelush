import { describe, expect, it } from "vitest";
import { ToolRegistryBuilder, type ToolSecurityFacts } from "../src/index.js";

describe("Tool Security Facts contracts", () => {
  it("keeps a security facts projector host-only and out of model definitions", () => {
    const facts: ToolSecurityFacts = {
      resourceAccesses: [{ operation: "READ", path: ".env" }],
      secretScanInputs: [{ kind: "GENERIC", text: "API_KEY=fixture" }],
      structuralPreview: { kind: "FILE_READ", path: ".env" },
    };
    const registry = new ToolRegistryBuilder()
      .register({
        definition: {
          name: "fact_tool",
          description: "A fact test tool.",
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: { type: "object", additionalProperties: false },
          riskLevel: "LOW",
          requiredCapabilities: ["FS_READ"],
          runtimeRequirements: {},
        },
        handler: { execute: async () => ({ content: "ok", details: {}, isError: false }) },
        securityFactsProjector: () => facts,
      })
      .build();

    expect(registry.modelDefinitions()).toEqual([
      expect.objectContaining({
        name: "fact_tool",
        description: "A fact test tool.",
        inputSchema: { type: "object", additionalProperties: false },
      }),
    ]);
    expect("securityFactsProjector" in registry.modelDefinitions()[0]!).toBe(false);
    expect(registry.resolve("fact_tool")?.securityFactsProjector?.({})).toBe(facts);
  });
});
