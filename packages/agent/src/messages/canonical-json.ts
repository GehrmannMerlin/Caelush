import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "@caelush/ai";

/**
 * The canonical serialization the Message Domain digests and compares with.
 *
 * ```text
 * object keys sorted   two structurally equal values must serialize identically
 * arrays in order      order is meaning for a content part list
 * ```
 *
 * It exists in the Message Domain rather than being imported from the Tool Layer for a
 * structural reason: `packages/agent/src/tools/**` is the Tool System's namespace, and a
 * message projection that depended on it would tie the Message Domain's fingerprint
 * stability to a Tool refactor. The two are deliberately the same algorithm — key-sorted
 * structure — so a digest computed here and one computed there agree, and neither
 * declares the other's types.
 *
 * ## Why a fingerprint is a digest and not a length or a counter
 *
 * Phase 5B compares a re-projected message against the one the model was actually shown.
 * A digest over the canonical text is what makes that comparison meaningful: it changes
 * if and only if the projection changed. A digest is an integrity check, not a security
 * boundary — it is not a signature and it is not secret.
 */
export function canonicalJsonText(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

/** A copy of a JSON value with object keys sorted, so equal values serialize identically. */
export function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const canonical: Record<string, JsonValue> = {};
    for (const [key, nested] of entries) {
      canonical[key] = canonicalize(nested);
    }
    return canonical;
  }
  return value;
}

/** The canonical digest of a JSON value, as lowercase hexadecimal. */
export function digestJsonValue(value: JsonValue): string {
  return createHash("sha256").update(canonicalJsonText(value), "utf8").digest("hex");
}

/** The canonical digest of a JSON object. */
export function digestJsonObject(value: JsonObject): string {
  return digestJsonValue(value);
}
