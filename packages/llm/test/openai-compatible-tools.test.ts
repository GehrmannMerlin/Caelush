import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@caelush/protocol";
import { toAISDKToolChoice, toAISDKTools } from "../src/providers/openai-compatible/tools.js";

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

describe("OpenAI-compatible tool conversion", () => {
  it("projects a Caelush tool to an object-shaped AI SDK schema", () => {
    const tools = toAISDKTools([readFile]);
    expect(tools).toBeDefined();

    const generated = tools?.read_file;
    expect(generated).toMatchObject({ description: "Read a UTF-8 file." });
    expect(generated).not.toHaveProperty("execute");
    const schema = (generated?.inputSchema as unknown as { jsonSchema: Record<string, unknown> })
      .jsonSchema;
    expect(schema).toMatchObject({
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"],
    });
    expect(generated).not.toHaveProperty("riskLevel");
    expect(generated).not.toHaveProperty("requiredCapabilities");
    expect(generated).not.toHaveProperty("runtimeRequirements");
    expect(generated).not.toHaveProperty("outputSchema");
  });

  it("returns no tools when the request has no tool definitions", () => {
    expect(toAISDKTools(undefined)).toBeUndefined();
    expect(toAISDKTools([])).toBeUndefined();
  });

  it.each([
    [{ type: "AUTO" } as const, "auto"],
    [{ type: "NONE" } as const, "none"],
    [{ type: "REQUIRED" } as const, "required"],
    [{ type: "TOOL", toolName: "read_file" } as const, { type: "tool", toolName: "read_file" }],
  ])("maps %j to the current AI SDK tool choice", (choice, expected) => {
    expect(toAISDKToolChoice(choice)).toEqual(expected);
  });

  it("leaves an omitted Caelush tool choice omitted", () => {
    expect(toAISDKToolChoice(undefined)).toBeUndefined();
  });
});
