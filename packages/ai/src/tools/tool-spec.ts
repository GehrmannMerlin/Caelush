import { assertExactKeys, assertNonEmptyString, describeValue } from "../internal/assertions.js";
import { isJsonObject } from "../json/json-value.js";
import type { JsonObject } from "../json/json-value.js";

/**
 * The model-facing tool specification.
 *
 * This is data only. The AI core knows nothing about `ToolDefinition`,
 * `riskLevel`, `runtimeRequirements`, approval, workspace effects, verification
 * or handlers. The projection from a Caelush `ToolDefinition` belongs to the
 * Agent / CodingAgent consumer boundary, because `@caelush/ai` may not depend on
 * `@caelush/protocol`.
 */
export interface AIToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

const TOOL_SPEC_KEYS = ["name", "description", "inputSchema"] as const;

/** Assert a well-formed, data-only tool specification. */
export function assertAIToolSpec(value: unknown): asserts value is AIToolSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI tool spec must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;

  assertExactKeys(candidate, TOOL_SPEC_KEYS, "AI tool spec");
  assertNonEmptyString(candidate.name, "AI tool spec name");
  if (typeof candidate.description !== "string") {
    throw new TypeError(
      `AI tool spec description must be a string, received ${describeValue(candidate.description)}.`,
    );
  }
  if (!isJsonObject(candidate.inputSchema)) {
    throw new TypeError(
      `AI tool spec inputSchema must be a JSON object, received ${describeValue(candidate.inputSchema)}.`,
    );
  }
}
