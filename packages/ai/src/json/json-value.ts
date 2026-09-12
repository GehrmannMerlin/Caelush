/**
 * AI-local JSON value types.
 *
 * `@caelush/ai` must not depend on any `@caelush/*` workspace package, so it
 * cannot reuse the Protocol `JsonObject` contract. These types restate the same
 * JSON-safe value model locally, with no business meaning and no dependency.
 *
 * Protocol remains the owner of the *wire and durable* JSON contract. The AI
 * runtime boundary converts between the two at the consumer edge (Phase 2C).
 */

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/**
 * A JSON object.
 *
 * Declared as an interface (rather than a type alias) so the recursive
 * `JsonValue` reference below stays legal and the emitted declaration is
 * self-contained.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any JSON-safe value. */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** True when the value is a JSON-safe value: no functions, symbols or non-finite numbers. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      return isPlainJsonObject(value);
    default:
      return false;
  }
}

/** True when the value is a JSON object: a plain object with JSON-safe members. */
export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return isPlainJsonObject(value);
}

function isPlainJsonObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
}
