import type { ToolDefinition } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createBuiltinToolModelGuidance,
  ToolRegistryBuilder,
  type ToolHandler,
} from "../src/index.js";

const definition: ToolDefinition = {
  name: "read_file",
  description: "Read a file.",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: { type: "object", additionalProperties: false },
  riskLevel: "LOW",
  requiredCapabilities: [],
  runtimeRequirements: {},
};

const handler: ToolHandler = {
  execute: async () => ({ content: "ok", details: {}, isError: false }),
};

describe("Tool model guidance", () => {
  it("is separate from runtime metadata and immutable at the registry boundary", () => {
    const supplied = {
      toolName: "read_file" as const,
      purpose: "Read files.",
      whenToUse: "When evidence is needed.",
      whenNotToUse: "Never outside the workspace.",
      argumentNotes: "Use a relative path.",
      sideEffects: "Read-only; does not mutate workspace state.",
      safety: "Reject paths outside the workspace.",
      resultHandling: "Use the observed result.",
    };
    const registry = new ToolRegistryBuilder()
      .register({ definition, handler, modelGuidance: supplied })
      .build();

    supplied.purpose = "mutated";
    const guidance = registry.modelGuidance();
    expect(guidance).toEqual([expect.objectContaining({ purpose: "Read files." })]);
    expect(Object.isFrozen(guidance)).toBe(true);
    expect(Object.isFrozen(guidance[0])).toBe(true);
    expect(registry.modelDefinitions()[0]).not.toHaveProperty("purpose");
    expect(registry.modelDefinitions()[0]?.description).toContain("When: When evidence is needed.");
    expect(registry.modelDefinitions()[0]?.description).toContain(
      "Safety: Reject paths outside the workspace.",
    );
  });

  it("provides explicit side-effect and safety guidance for every builtin Tool", () => {
    const guidance = createBuiltinToolModelGuidance("exec_command");

    expect(guidance.sideEffects).toContain("process");
    expect(guidance.safety).toContain("approval");
  });

  it("derives all nine builtin guidance entries in the active tool order", () => {
    const toolNames = [
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "git_status",
      "git_diff",
    ] as const;
    const registryBuilder = new ToolRegistryBuilder();
    for (const toolName of toolNames) {
      registryBuilder.register({
        definition: { ...definition, name: toolName },
        handler,
        modelGuidance: createBuiltinToolModelGuidance(toolName),
      });
    }
    const registry = registryBuilder.build();
    expect(registry.modelGuidance().map((entry) => entry.toolName)).toEqual(toolNames);
  });
});
