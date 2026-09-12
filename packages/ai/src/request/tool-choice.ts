import { assertExactKeys, assertNonEmptyString, describeValue } from "../internal/assertions.js";

/**
 * How the model may use tools for one request.
 *
 * `AUTO` lets the model decide, `NONE` forbids tools for this turn, `REQUIRED`
 * demands at least one tool call, and `TOOL` pins one specific tool by name.
 */
export type AIToolChoice =
  | { readonly type: "AUTO" }
  | { readonly type: "NONE" }
  | { readonly type: "REQUIRED" }
  | { readonly type: "TOOL"; readonly toolName: string };

/** Every frozen tool choice discriminator. */
export const AI_TOOL_CHOICE_TYPES = ["AUTO", "NONE", "REQUIRED", "TOOL"] as const;

const CHOICE_KEYS: Record<(typeof AI_TOOL_CHOICE_TYPES)[number], readonly string[]> = {
  AUTO: ["type"],
  NONE: ["type"],
  REQUIRED: ["type"],
  TOOL: ["type", "toolName"],
};

/** Assert a well-formed tool choice, rejecting unknown fields and variants. */
export function assertAIToolChoice(value: unknown): asserts value is AIToolChoice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`AI tool choice must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;
  const type = candidate.type;

  if (typeof type !== "string" || !(AI_TOOL_CHOICE_TYPES as readonly string[]).includes(type)) {
    throw new TypeError(`AI tool choice has an unknown type ${describeValue(type)}.`);
  }

  const variant = type as (typeof AI_TOOL_CHOICE_TYPES)[number];
  assertExactKeys(candidate, CHOICE_KEYS[variant], `AI tool choice ${variant}`);

  if (variant === "TOOL") {
    assertNonEmptyString(candidate.toolName, "AI tool choice TOOL toolName");
  }
}
