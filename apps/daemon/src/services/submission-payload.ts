import { createHash } from "node:crypto";

export function hashSubmissionPayload(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(normalizeSkillSelectionIdentity(payload))))
    .digest("hex");
}

/** Duplicate copies of the same explicit choice do not create a different submission identity. */
export function normalizeSkillSelectionIdentity(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const selections = record["skillSelections"];
  if (!Array.isArray(selections)) return payload;
  const seen = new Set<string>();
  const normalized = selections.filter((selection) => {
    if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
      return true;
    }
    const item = selection as Record<string, unknown>;
    if (typeof item["skillId"] !== "string" || typeof item["selectionToken"] !== "string") {
      return true;
    }
    const key = JSON.stringify([item["skillId"], item["selectionToken"]]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...record, skillSelections: normalized };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
