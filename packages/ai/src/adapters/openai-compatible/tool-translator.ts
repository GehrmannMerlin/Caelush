import { jsonSchema } from "ai";
import type { ToolChoice, ToolSet } from "ai";
import type { AIToolChoice } from "../../request/tool-choice.js";
import type { AIToolSpec } from "../../tools/tool-spec.js";

/**
 * Translate the AI-local tool catalog into the provider tool set.
 *
 * Only `name`, `description` and `inputSchema` cross this boundary. Tool
 * metadata such as `riskLevel`, `requiredCapabilities`, `runtimeRequirements`,
 * `outputSchema`, approval policy or a handler is not part of `AIToolSpec` at all,
 * so it cannot reach a provider request.
 *
 * Declaration order is preserved exactly: the tools are inserted in the caller's
 * order and never sorted, so a stable tool prefix stays byte-identical across
 * turns and prompt caching over that prefix keeps working.
 */
export function translateOpenAICompatibleTools(
  specs: readonly AIToolSpec[] | undefined,
): ToolSet | undefined {
  if (specs === undefined || specs.length === 0) return undefined;

  const tools: ToolSet = {};
  for (const spec of specs) {
    tools[spec.name] = {
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema),
    };
  }
  return tools;
}

/** Map the frozen tool choice onto the provider tool choice. */
export function translateOpenAICompatibleToolChoice(
  choice: AIToolChoice | undefined,
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
