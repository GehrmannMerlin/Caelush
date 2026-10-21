import {
  cloneJsonValue,
  type ResolvedAgentTool,
  type ToolArgumentNormalization,
} from "@caelush/agent";
import type { JsonObject, JsonValue } from "@caelush/ai";

/**
 * The one numeric-string compatibility normalization.
 *
 * ## What it does
 *
 * A model occasionally serializes a number as a string — `"yield_time_ms": "3000"` — for a field its
 * JSON Schema explicitly declares as `integer` or `number`. This normalization converts exactly those
 * values, and nothing else:
 *
 * ```text
 * string -> number   only when the field's own schema declares number / integer
 * integer            only when the parsed value is a safe integer
 * arrays             recursed through the declared items schema
 * objects            recursed through the declared properties
 * ```
 *
 * ## What it deliberately does not do
 *
 * ```text
 * no fuzzy parsing        "3s", "1e3 items", "0x10" and "" stay strings
 * no field guessing       a property the schema does not declare is never touched
 * no defaults             a missing field is never filled in
 * no property removal     an unknown field is never dropped
 * no path/command repair  a missing path or command stays missing
 * ```
 *
 * ## Why it is an explicit hook and not a validator setting
 *
 * The canonical schema runtime keeps `coerceTypes: false`. AJV is therefore still forbidden from
 * repairing anything: a Tool opts into this normalization by being registered with it, and a generic
 * `AgentTool` that did not ask for it gets strict validation with no implicit conversion. That is the
 * difference between a Tool author's declared compatibility affordance and a framework-wide
 * loosening of every Tool's contract.
 *
 * The value it returns is validated afterwards, like any other prepared payload.
 *
 * ## Why it converts a copy
 *
 * The Preparer hands this hook whatever the *previous* stage produced, and a previous stage may
 * legitimately return a frozen object — `apply_patch` does, because canonicalizing `{input}` into
 * `{patch}` should not leave a mutable buffer behind. Writing into that object turns a legitimate
 * argument into an uncaught `TypeError` inside preparation, which the Preparer correctly classifies
 * as an infrastructure failure and the RunController correctly fails the Run over. A compatibility
 * hook must therefore never assume ownership of its input: it copies, converts the copy, and returns
 * that. `normalizeToolArgumentsForCompatibility` is the one implementation of that copy-and-convert
 * path, so the Tool registration hook and any direct caller cannot drift apart.
 */
export function normalizeSchemaDeclaredNumericStrings(
  args: Readonly<JsonObject>,
  tool: ResolvedAgentTool,
): Readonly<JsonObject> {
  return normalizeToolArgumentsForCompatibility(tool.tool, args);
}

/** The registration-level normalization a legacy Tool registration carries. */
export function createLegacyNumericArgumentNormalization(): ToolArgumentNormalization {
  return Object.freeze({ normalizeValue: normalizeSchemaDeclaredNumericStrings });
}

/**
 * The same normalization, exposed for a caller that resolves a Tool itself.
 *
 * Returns a fresh value; it never mutates its input, which is what a caller holding model arguments
 * needs — and what a caller holding another hook's frozen result needs just as much.
 */
export function normalizeToolArgumentsForCompatibility(
  tool: { readonly inputSchema: JsonObject },
  args: Readonly<JsonObject>,
): JsonObject {
  const copy = cloneJsonValue(args as JsonValue) as JsonObject;
  normalizeValue(copy as JsonValue, tool.inputSchema);
  return copy;
}

function normalizeValue(value: JsonValue, schema: JsonObject): JsonValue {
  if (typeof value === "string" && (schema.type === "integer" || schema.type === "number")) {
    const converted = parseNumericString(value);
    if (converted !== undefined && (schema.type !== "integer" || Number.isSafeInteger(converted))) {
      return converted;
    }
  }

  if (Array.isArray(value)) {
    const itemSchema = asJsonObject(schema.items);
    if (itemSchema !== undefined) {
      return value.map((item) => normalizeValue(item, itemSchema));
    }
    return value;
  }

  if (isJsonObject(value)) {
    const properties = asJsonObject(schema.properties);
    if (properties === undefined) return value;
    const mutable = value as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(mutable)) {
      const childSchema = asJsonObject(properties[key]);
      if (childSchema !== undefined) mutable[key] = normalizeValue(child, childSchema);
    }
  }
  return value;
}

/**
 * A numeric string in JSON number grammar only.
 *
 * `"soon"`, `"3 seconds"` and `"0x10"` are not numbers and are left alone so validation reports
 * them; `"9007199254740992"` parses but is not a safe integer, so an `integer` field keeps it as a
 * string and rejects it rather than silently losing precision.
 */
function parseNumericString(value: string): number | undefined {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
