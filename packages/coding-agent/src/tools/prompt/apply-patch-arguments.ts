import type { JsonObject } from "@caelush/ai";

/**
 * The canonical argument shape of `apply_patch`, as the model is told it.
 *
 * This lives beside the Tool's input schema rather than inside prompt prose: the example a model
 * reads and the schema the Preparer enforces are then the same fact maintained once, and a test
 * compiles this object with the real `applyPatchInputSchema`. A guidance string that drifts from the
 * schema is worse than no guidance, because it teaches the model the wrong shape with confidence.
 *
 * The patch text belongs in `patch`. There is no `input` field, no nested document field and no
 * alternative spelling: the historical failure was a model sending `{"input": "..."}` sixty-four
 * times, so the example is the correction that model needed on the first attempt.
 */
export const APPLY_PATCH_ARGUMENT_EXAMPLE = Object.freeze({
  patch: [
    "*** Begin Patch",
    "*** Update File: src/example.ts",
    "@@",
    "-const value = 1;",
    "+const value = 2;",
    "*** End Patch",
  ].join("\n"),
});

/** One-line argument note rendered into the Tool's bounded prompt snippet. */
export const APPLY_PATCH_ARGUMENT_NOTES = `Exactly ${JSON.stringify(APPLY_PATCH_ARGUMENT_EXAMPLE)} — the whole patch document goes in patch; there is no input field.`;

/**
 * The version of the one compatibility normalization this Tool performs.
 *
 * It exists so an audit can say *which* rule turned a historical `input` argument into a canonical
 * `patch` one. It is deliberately not a second schema version: the Tool has one input schema, and
 * this version describes the preparation step that feeds it.
 */
export const APPLY_PATCH_ARGUMENT_NORMALIZATION_VERSION = 1 as const;

/** The one non-canonical key a real provider repeatedly produced for this Tool. */
const COMPATIBILITY_SOURCE_KEY = "input";
/** The canonical key the Tool's schema declares. */
const CANONICAL_KEY = "patch";

/**
 * Whether a raw argument object is exactly the known `{ input: string }` drift.
 *
 * ```text
 * one own key, named input, holding a string   → the drift
 * any other key present                        → not the drift
 * patch already present                        → not the drift
 * input present and not a string               → not the drift
 * ```
 *
 * The check is intentionally brittle in the safe direction. A shape with *both* keys is ambiguous —
 * which document did the model mean? — and a shape with an unknown extra key is not something this
 * Tool ever declared, so neither is repaired. They fall through to schema validation, which rejects
 * them with the field names the model got wrong.
 */
export function isApplyPatchInputCompatibilityShape(rawArgs: Readonly<JsonObject>): boolean {
  const keys = Object.keys(rawArgs);
  if (keys.length !== 1 || keys[0] !== COMPATIBILITY_SOURCE_KEY) return false;
  return typeof rawArgs[COMPATIBILITY_SOURCE_KEY] === "string";
}

/**
 * The Tool's own preparation hook: turn the one known drift into the canonical shape.
 *
 * ```text
 * raw model arguments
 *   → this hook                      (pure, deterministic, bounded, no I/O)
 *   → canonical byte bound           (the Preparer re-measures what this produced)
 *   → the Tool's real input schema   (`patch`, and nothing else)
 *   → canonical fingerprint          (so the approval identity is the same either way)
 *   → Guard / Security               (which never see the drifted shape)
 *   → handler                        (which only ever reads `patch`)
 * ```
 *
 * Everything the compatibility does *not* do is as important as what it does. It does not merge two
 * documents, guess a field name, coerce a non-string, or accept an extra key. It returns the input
 * unchanged for every other shape, which is what keeps the rejection accurate rather than silent:
 * the model is told which fields were wrong, by the same renderer every other schema mistake uses.
 *
 * The original assistant message is untouched. Only the invocation's arguments are canonical, and a
 * recovered invocation reads those persisted canonical arguments rather than re-running this hook.
 */
export function normalizeApplyPatchArguments(rawArgs: Readonly<JsonObject>): Readonly<JsonObject> {
  if (!isApplyPatchInputCompatibilityShape(rawArgs)) return rawArgs;
  return Object.freeze({ [CANONICAL_KEY]: rawArgs[COMPATIBILITY_SOURCE_KEY] as string });
}
