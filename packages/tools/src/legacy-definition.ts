import type { JsonObject, ToolDefinition } from "@caelush/protocol";
import { cloneJsonValue, deepFreezeJson } from "@caelush/agent";

/**
 * Defensive copy and freeze for a legacy `ToolDefinition`.
 *
 * The legacy definition carries Coding metadata *inside* the definition object (risk level,
 * capabilities, runtime requirements) rather than beside it, so it needs one more copy step than a
 * canonical model spec. The copy is still made with the canonical JSON helpers, so the value a
 * registry holds is a null-prototype, deeply frozen structure rather than a caller's live object.
 */
export function cloneToolDefinition(definition: ToolDefinition): ToolDefinition {
  const copy: ToolDefinition = {
    name: definition.name,
    description: definition.description,
    inputSchema: cloneJsonValue(definition.inputSchema) as JsonObject,
    outputSchema: cloneJsonValue(definition.outputSchema) as JsonObject,
    riskLevel: definition.riskLevel,
    requiredCapabilities: [...definition.requiredCapabilities],
    runtimeRequirements: cloneJsonValue(definition.runtimeRequirements) as JsonObject,
  };
  deepFreezeJson(copy.inputSchema);
  deepFreezeJson(copy.outputSchema);
  deepFreezeJson(copy.runtimeRequirements);
  Object.freeze(copy.requiredCapabilities);
  return Object.freeze(copy);
}
