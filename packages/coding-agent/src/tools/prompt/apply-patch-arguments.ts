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
