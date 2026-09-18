import type { ResolvedAgentTool, ToolArgumentNormalization } from "@caelush/agent";
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
 */
export function normalizeSchemaDeclaredNumericStrings(
  args: Readonly<JsonObject>,
  tool: ResolvedAgentTool,
): Readonly<JsonObject> {
  normalizeValue(args as JsonValue, tool.tool.inputSchema as JsonObject);
  return args;
}

/** The registration-level normalization a legacy Tool registration carries. */
export function createLegacyNumericArgumentNormalization(): ToolArgumentNormalization {
  return Object.freeze({ normalizeValue: normalizeSchemaDeclaredNumericStrings });
}

/**
 * The same normalization, exposed for a caller that resolves a Tool itself.
 *
 * Returns a fresh value; it never mutates its input, which is what a caller holding model arguments
 * needs.
 */
export function normalizeToolArgumentsForCompatibility(
  tool: { readonly inputSchema: JsonObject },
  args: JsonObject,
): JsonObject {
  const copy = clone(args) as JsonObject;
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

function clone(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => clone(item));
  if (value !== null && typeof value === "object") {
    const copy = Object.create(null) as Record<string, JsonValue>;
    for (const [key, nested] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: clone(nested),
        writable: true,
      });
    }
    return copy;
  }
  return value;
}
