import type { JsonObject, JsonValue } from "@caelush/ai";

/**
 * Deterministic JSON helpers shared by the Tool Layer.
 *
 * ```text
 * cloneJsonValue        one defensive copy, null-prototype, no accessor inheritance
 * deepFreezeJson        recursive immutability for a copied schema or payload
 * canonicalizeJsonValue key-sorted structure, so two equal values serialize identically
 * canonicalJsonString   the serialization used for byte budgets, approval keys and fingerprints
 * jsonUtf8ByteLength    the only size unit the Tool Layer budgets in
 * ```
 *
 * These are general utilities rather than Tool-specific policy: the same canonical serialization
 * decides whether a catalog fits its byte budget and whether two argument objects are the same call.
 * They live in the Agent Tool Layer for the first migration wave, where the moved registry and
 * schema runtime need them, and can be promoted to a shared utility later without changing a caller.
 *
 * Nothing here mutates an input. `cloneJsonValue` copies into a null-prototype object and defines
 * each property explicitly, so a hostile or merely careless caller cannot smuggle a getter, a
 * prototype or a non-enumerable field into a durable argument payload.
 */

/** A defensive copy of a JSON value. */
export function cloneJsonValue<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const clone = Object.create(null) as Record<string, JsonValue>;
    for (const [key, nestedValue] of Object.entries(value)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(nestedValue),
        writable: true,
      });
    }
    return clone as unknown as T;
  }
  return value as unknown as T;
}

/** Recursively freeze a JSON value, returning the same reference. */
export function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
  } else if (typeof value === "object" && value !== null) {
    for (const nestedValue of Object.values(value)) deepFreezeJson(nestedValue);
  }
  return Object.freeze(value);
}

/** A copy of a JSON value whose object keys are sorted, so equal values serialize identically. */
export function canonicalizeJsonValue<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const canonical = Object.create(null) as Record<string, JsonValue>;
    for (const [key, nestedValue] of entries) {
      Object.defineProperty(canonical, key, {
        configurable: true,
        enumerable: true,
        value: canonicalizeJsonValue(nestedValue),
        writable: true,
      });
    }
    return canonical as unknown as T;
  }
  return value;
}

/** The canonical serialization of a JSON value. */
export function canonicalJsonString(value: JsonValue): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

/** The UTF-8 byte length of a string. Byte budgets are never measured in UTF-16 units. */
export function jsonUtf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * True when a value is a JSON object: not null, not an array.
 *
 * A **thenable** is explicitly not a JSON object. A `prepareArguments` hook written as `async`
 * returns a promise, which is `typeof "object"` and not an array; treating it as a JSON object would
 * silently hand a promise to schema validation instead of reporting the contract violation, and a
 * promise is precisely the "unexpected asynchronous preparation result" the Preparer must refuse.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { readonly then?: unknown }).then !== "function"
  );
}
