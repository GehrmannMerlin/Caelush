import type { TimestampMs } from "@caelush/protocol";

import { PromptSurfaceCapacityError } from "./prompt-surface-capacity.js";
import {
  createPromptSurfaceEpoch,
  createPromptSurfaceRecord,
  type PromptSurfaceAnchor,
  type PromptSurfaceEpoch,
  type PromptSurfaceEpochId,
  type PromptSurfaceEpochWithSnapshots,
  type PromptSurfaceRecord,
} from "./prompt-surface.js";
import { hashPromptSurfaceContent, PromptSurfaceIntegrityError } from "./prompt-surface-integrity.js";
import {
  PromptSurfaceRolloverConflictError,
  type PromptSurfaceStorePort,
} from "./prompt-surface-store.js";
import {
  diffPromptSurfaceSections,
  type PromptSurfaceSectionState,
} from "./prompt-surface-v3.js";

/**
 * How many times one rollover may re-read and re-decide after a concurrent writer moved the
 * epoch. One retry is enough to absorb a lost race; more than that means the caller is fighting
 * another writer and should surface the conflict instead of spinning.
 */
const MAX_ROLLOVER_ATTEMPTS = 2;

export interface PromptSurfaceRolloverRequest {
  readonly store: PromptSurfaceStorePort;
  /** The current epoch, already integrity-checked by the caller. */
  readonly epoch: PromptSurfaceEpochWithSnapshots;
  /** The durable Step whose complete Section view becomes the next epoch's baseline. */
  readonly stepSequence: number;
  readonly anchor: PromptSurfaceAnchor;
  /** The complete Section view in effect after this Step. */
  readonly targetSectionStates: readonly PromptSurfaceSectionState[];
  /**
   * The decision fingerprint the caller computed for this Step's target view.
   *
   * It is passed in, not recomputed here, so the baseline and the caller's own idempotent-retry
   * comparison are guaranteed to agree.
   */
  readonly decisionFingerprint: string;
  readonly createdAt: TimestampMs;
}

export interface PromptSurfaceRolloverOutcome {
  readonly status: "COMMITTED" | "IDEMPOTENT";
  /** The persisted next epoch, read back and verified against the committed baseline. */
  readonly epoch: PromptSurfaceEpochWithSnapshots;
  readonly operationId: string;
}

/**
 * Close a full epoch and open the next one with this Step's complete Section view.
 *
 * The reconstruction is deterministic and local: no model turn, no summarisation, no deletion of
 * the previous epoch or of any conversation message. The only thing that changes is which bounded
 * log the next model request is projected against.
 *
 * `operationId` and `epochId` are derived from the source epoch, its last decision and this Step —
 * never from the current time — so a retry after a lost response recognises the epoch it already
 * created instead of opening a second one.
 */
export async function rolloverPromptSurface(
  input: PromptSurfaceRolloverRequest,
): Promise<PromptSurfaceRolloverOutcome> {
  const expectedStates = input.targetSectionStates;
  let sourceOrdinal = (input.epoch.records ?? []).length;
  let sourceDecisionFingerprint = lastDecisionFingerprint(input.epoch);

  for (let attempt = 0; attempt < MAX_ROLLOVER_ATTEMPTS; attempt += 1) {
    const operationId = promptSurfaceRolloverOperationId({
      epoch: input.epoch,
      recordOrdinal: sourceOrdinal,
      decisionFingerprint: sourceDecisionFingerprint,
      stepSequence: input.stepSequence,
      anchor: input.anchor,
      targetSectionStates: expectedStates,
    });
    const newEpoch = createPromptSurfaceEpoch({
      formatVersion: 3,
      runId: input.epoch.runId,
      epochId: `rollover-${operationId}`,
      modelRef: input.epoch.modelRef,
      stableHeadFingerprint: input.epoch.stableHeadFingerprint,
      toolSchemaFingerprint: input.epoch.toolSchemaFingerprint,
      cacheSettingsFingerprint: input.epoch.cacheSettingsFingerprint,
      resetReason: "CAPACITY_ROLLOVER",
      createdStepSequence: input.stepSequence,
      createdAt: input.createdAt,
    });
    const baseline = createPromptSurfaceRecord({
      runId: input.epoch.runId,
      epochId: newEpoch.epochId,
      ordinal: 1,
      anchor: input.anchor,
      sourceStepSequence: input.stepSequence,
      kind: "BASELINE",
      updates: diffPromptSurfaceSections([], expectedStates, true).updates,
      decisionFingerprint: input.decisionFingerprint,
      createdAt: input.createdAt,
    });

    try {
      const status = await input.store.rolloverEpoch({
        expectedCurrentEpoch: input.epoch,
        expectedRecordOrdinal: sourceOrdinal,
        expectedDecisionFingerprint: sourceDecisionFingerprint,
        operationId,
        newEpoch,
        baseline,
        expectedSectionStates: expectedStates,
      });
      const committed = await readCommittedEpoch(input.store, newEpoch.epochId, baseline);
      return Object.freeze({ status, epoch: committed, operationId });
    } catch (error) {
      if (error instanceof PromptSurfaceRolloverConflictError && attempt + 1 < MAX_ROLLOVER_ATTEMPTS) {
        const refreshed = await input.store.readEpoch(input.epoch.runId, input.epoch.epochId);
        if (refreshed === undefined) {
          throw capacityFailure("EPOCH_ROLLOVER_CONFLICT", "surface_capacity", error);
        }
        const records = refreshed.records ?? [];
        sourceOrdinal = records.length;
        sourceDecisionFingerprint = lastDecisionFingerprint(refreshed);
        continue;
      }
      throw classifyRolloverFailure(error);
    }
  }
  throw capacityFailure("EPOCH_ROLLOVER_CONFLICT", "surface_capacity");
}

/**
 * The deterministic identity of one rollover transition.
 *
 * Everything that can change what the next epoch would contain is in the key, and nothing that
 * varies per attempt is: a retry of the same Step against the same source state maps to the same
 * operation and therefore to the same epoch.
 */
export function promptSurfaceRolloverOperationId(input: {
  readonly epoch: Pick<PromptSurfaceEpoch, "runId" | "epochId">;
  readonly recordOrdinal: number;
  readonly decisionFingerprint: string | null;
  readonly stepSequence: number;
  readonly anchor: PromptSurfaceAnchor;
  readonly targetSectionStates: readonly PromptSurfaceSectionState[];
}): string {
  return hashPromptSurfaceContent(
    JSON.stringify({
      version: 1,
      runId: input.epoch.runId,
      fromEpochId: input.epoch.epochId,
      fromRecordOrdinal: input.recordOrdinal,
      fromDecisionFingerprint: input.decisionFingerprint,
      stepSequence: input.stepSequence,
      anchor: {
        messageId: input.anchor.messageId,
        runId: input.anchor.runId,
        conversationTurnId: input.anchor.conversationTurnId,
        sequence: input.anchor.sequence,
      },
      sectionStates: input.targetSectionStates.map((state) => [state.stateKey, state.contentHash]),
    }),
  );
}

/** The CAS token for the source epoch's last decision; `null` only when it has no decisions. */
function lastDecisionFingerprint(epoch: PromptSurfaceEpochWithSnapshots): string | null {
  return epoch.records?.at(-1)?.decisionFingerprint ?? null;
}

async function readCommittedEpoch(
  store: PromptSurfaceStorePort,
  epochId: PromptSurfaceEpochId,
  baseline: PromptSurfaceRecord,
): Promise<PromptSurfaceEpochWithSnapshots> {
  const committed = await store.readEpoch(baseline.runId, epochId);
  if (committed === undefined) {
    throw new PromptSurfaceIntegrityError("Committed Prompt Surface rollover could not be read.");
  }
  const stored = committed.records?.at(0);
  if (stored === undefined || stored.contentHash !== baseline.contentHash) {
    throw new PromptSurfaceIntegrityError(
      "Committed Prompt Surface rollover baseline differs from its request.",
    );
  }
  return committed;
}

function classifyRolloverFailure(error: unknown): Error {
  if (error instanceof PromptSurfaceCapacityError) return error;
  if (error instanceof PromptSurfaceIntegrityError) {
    return capacityFailure("EPOCH_ROLLOVER_FAILED", "surface_capacity", error);
  }
  if (error instanceof PromptSurfaceRolloverConflictError) {
    return capacityFailure("EPOCH_ROLLOVER_CONFLICT", "surface_capacity", error);
  }
  return capacityFailure("SURFACE_PERSISTENCE_FAILED", "surface_persistence", error);
}

function capacityFailure(
  reason: "EPOCH_ROLLOVER_CONFLICT" | "EPOCH_ROLLOVER_FAILED" | "SURFACE_PERSISTENCE_FAILED",
  stage: "surface_capacity" | "surface_persistence",
  cause?: unknown,
): PromptSurfaceCapacityError {
  return new PromptSurfaceCapacityError(
    { reason, stage, ...(cause === undefined ? {} : { cause }) },
    "The local model context projection could not be advanced.",
  );
}
