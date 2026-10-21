import type { PromptSurfaceEpoch, PromptSurfaceEpochWithSnapshots } from "./prompt-surface.js";

/**
 * The canonical identity of one Epoch, and nothing else.
 *
 * ```text
 * PromptSurfaceEpoch                 runId, epochId, modelRef, stableHeadFingerprint,
 *                                    toolSchemaFingerprint, cacheSettingsFingerprint,
 *                                    resetReason, createdStepSequence, createdAt,
 *                                    formatVersion
 * PromptSurfaceEpochWithSnapshots    the same identity + snapshots/records/sectionStates
 * ```
 *
 * ## Why this exists as one function
 *
 * The two shapes are mutually assignable in TypeScript: a `PromptSurfaceEpochWithSnapshots` *is* a
 * `PromptSurfaceEpoch` structurally, so a call site can hand the wide object to a port typed with the
 * narrow one and still compile. Storage does not accept that at runtime — it validates the exact key
 * set, because an epoch row with replay state attached is not the identity it compares against.
 *
 * The result was a real production failure: the append path projected the identity and the rollover
 * path did not, so the 129th visible record could not open a new epoch. Two components, each correct
 * on its own, composed into a Run-level failure. There is now exactly one projection and both paths
 * call it, so the shapes cannot drift apart again.
 *
 * The field list is written out one by one on purpose. A spread would silently re-admit any field
 * added to the wide type later, which is the bug this function is here to prevent.
 */
export function promptSurfaceEpochIdentity(
  surface: PromptSurfaceEpochWithSnapshots,
): PromptSurfaceEpoch {
  return Object.freeze({
    formatVersion: surface.formatVersion,
    runId: surface.runId,
    epochId: surface.epochId,
    modelRef: surface.modelRef,
    stableHeadFingerprint: surface.stableHeadFingerprint,
    toolSchemaFingerprint: surface.toolSchemaFingerprint,
    cacheSettingsFingerprint: surface.cacheSettingsFingerprint,
    resetReason: surface.resetReason,
    createdStepSequence: surface.createdStepSequence,
    createdAt: surface.createdAt,
  });
}
