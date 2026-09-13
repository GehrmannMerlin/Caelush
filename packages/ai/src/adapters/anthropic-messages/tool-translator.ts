import { createAIError } from "../../errors/ai-error.js";
import type { AIToolChoice } from "../../request/tool-choice.js";
import type { AIToolSpec } from "../../tools/tool-spec.js";
import type { JsonObject } from "../../json/json-value.js";
import type { ModelRef } from "../../models/model-ref.js";

/**
 * A native `tool` definition.
 *
 * Only `name`, `description` and `input_schema` exist. Caelush tool metadata —
 * `riskLevel`, `outputSchema`, `requiredCapabilities`, `runtimeRequirements`,
 * approval, verification and handlers — is not part of `AIToolSpec` at all, so it
 * has no way to reach the provider request.
 */
export interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonObject;
  readonly cache_control?: AnthropicCacheControl;
}

/** A native prompt-cache marker. */
export interface AnthropicCacheControl {
  readonly type: "ephemeral";
  readonly ttl?: "5m" | "1h";
}

/** The native tool-choice variants this dialect can express. */
export type AnthropicToolChoice =
  | { readonly type: "auto" }
  | { readonly type: "none" }
  | { readonly type: "any" }
  | { readonly type: "tool"; readonly name: string };

/**
 * Translate the frozen tool catalog into native tool definitions.
 *
 * Declaration order is preserved exactly and never sorted, so a stable tool prefix
 * stays byte-identical across turns and prompt caching over that prefix keeps
 * working. A tool name outside the Caelush shape is rejected here: the provider
 * would happily echo it back, and the core could not route the resulting call.
 */
export function translateAnthropicTools(
  specs: readonly AIToolSpec[] | undefined,
  model: ModelRef,
): readonly AnthropicTool[] | undefined {
  if (specs === undefined || specs.length === 0) return undefined;

  return specs.map((spec) => {
    assertToolName(spec.name, model);
    return {
      name: spec.name,
      description: spec.description,
      input_schema: spec.inputSchema,
    };
  });
}

/** Map the frozen tool choice onto the native tool choice. */
export function translateAnthropicToolChoice(
  choice: AIToolChoice | undefined,
): AnthropicToolChoice | undefined {
  if (choice === undefined) return undefined;

  switch (choice.type) {
    case "AUTO":
      return { type: "auto" };
    case "NONE":
      return { type: "none" };
    case "REQUIRED":
      return { type: "any" };
    case "TOOL":
      return { type: "tool", name: choice.toolName };
  }
}

/**
 * The CAELUSH tool-name shape, reproduced here as an adapter-private guard.
 *
 * `@caelush/ai` cannot depend on `@caelush/protocol`, so the contract is restated
 * at the dialect boundary instead of imported from its owner.
 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function assertToolName(name: string, model: ModelRef): void {
  if (TOOL_NAME_PATTERN.test(name)) return;
  throw createAIError(
    "AI_INVALID_REQUEST",
    `AI tool name "${name}" is not a valid Caelush tool name.`,
    { providerId: model.provider, model },
  );
}

/** Attach the native cache marker to a native tool definition. */
export function withAnthropicCacheControl<T extends AnthropicTool>(
  tool: T,
  cacheControl: AnthropicCacheControl,
): T {
  return { ...tool, cache_control: cacheControl };
}
