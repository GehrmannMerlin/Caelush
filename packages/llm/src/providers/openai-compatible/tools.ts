import { jsonSchema, type ToolChoice, type ToolSet } from "ai";
import type { ToolDefinition } from "@caelush/protocol";
import type { LLMToolChoice } from "../../request.js";

export function toAISDKTools(
  definitions: readonly ToolDefinition[] | undefined,
): ToolSet | undefined {
  if (definitions === undefined || definitions.length === 0) return undefined;

  const tools: ToolSet = {};
  for (const definition of definitions) {
    tools[definition.name] = {
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema),
    };
  }
  return tools;
}

export function toAISDKToolChoice(
  choice: LLMToolChoice | undefined,
): ToolChoice<ToolSet> | undefined {
  if (choice === undefined) return undefined;
  switch (choice.type) {
    case "AUTO":
      return "auto";
    case "NONE":
      return "none";
    case "REQUIRED":
      return "required";
    case "TOOL":
      return { type: "tool", toolName: choice.toolName };
  }
}
