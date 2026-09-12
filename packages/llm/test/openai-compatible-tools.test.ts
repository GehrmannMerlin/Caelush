import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@caelush/protocol";
import { toAIToolChoice, toAIToolSpec } from "../src/compatibility/request-projection.js";

/**
 * The SDK-facing tool translation moved to
 * `@caelush/ai/adapters/openai-compatible`, where it is covered by
 * `packages/ai/test/adapters/openai-compatible/tool-translator.test.ts` and by the
 * request golden tests.
 *
 * What this file locks is the legacy projection and, above all, that Caelush runtime
 * metadata cannot cross it: the AI tool spec has exactly three fields, so
 * `outputSchema`, `riskLevel`, `requiredCapabilities`, `runtimeRequirements` and any
 * handler are dropped at the legacy boundary and can never reach a provider request.
 */
const readFile: ToolDefinition = {
  name: "read_file",
  description: "Read a UTF-8 file.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "File path" } },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: { type: "object" },
  riskLevel: "LOW",
  requiredCapabilities: ["FS_READ"],
  runtimeRequirements: { kind: "local" },
};

const searchText: ToolDefinition = {
  ...readFile,
  name: "search_text",
  description: "Search text.",
};

describe("OpenAI-compatible legacy tool projection", () => {
  it("projects exactly name, description and inputSchema", () => {
    const spec = toAIToolSpec(readFile);

    expect(Object.keys(spec).sort()).toEqual(["description", "inputSchema", "name"]);
    expect(spec).toEqual({
      name: "read_file",
      description: "Read a UTF-8 file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "File path" } },
        required: ["path"],
        additionalProperties: false,
      },
    });
  });

  it("drops every piece of Caelush runtime metadata", () => {
    const serialized = JSON.stringify(toAIToolSpec(readFile));

    for (const forbidden of [
      "riskLevel",
      "LOW",
      "requiredCapabilities",
      "FS_READ",
      "runtimeRequirements",
      "outputSchema",
      "approvalPolicy",
      "handler",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("preserves declaration order when projecting a catalog", () => {
    const projected = [searchText, readFile].map(toAIToolSpec);

    expect(projected.map((spec) => spec.name)).toEqual(["search_text", "read_file"]);
  });

  it.each([
    [{ type: "AUTO" } as const, { type: "AUTO" }],
    [{ type: "NONE" } as const, { type: "NONE" }],
    [{ type: "REQUIRED" } as const, { type: "REQUIRED" }],
    [{ type: "TOOL", toolName: "read_file" } as const, { type: "TOOL", toolName: "read_file" }],
  ])("projects tool choice %j onto the frozen AI tool choice", (choice, expected) => {
    expect(toAIToolChoice(choice)).toEqual(expected);
  });
});
