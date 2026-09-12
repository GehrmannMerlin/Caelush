import type { JsonValue } from "../json/json-value.js";

/**
 * Recursively freeze a JSON value.
 *
 * Used at build boundaries so a caller cannot mutate a configuration object after
 * it has been accepted. Freezing is in place, so callers pass an owned copy.
 */
export function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry);
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) deepFreezeJson(entry);
    return Object.freeze(value) as T;
  }
  return value;
}
