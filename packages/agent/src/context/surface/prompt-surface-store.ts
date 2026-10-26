import type { RunId } from "@caelush/protocol";

import type {
  PromptSurfaceEpoch,
  PromptSurfaceEpochId,
  PromptSurfaceEpochWithSnapshots,
  PromptSurfaceRecord,
  PromptSurfaceSnapshot,
} from "./prompt-surface.js";
import type { PromptSurfaceSectionState } from "./prompt-surface-v3.js";

export type PromptSurfaceAppendResult = "APPENDED" | "IDEMPOTENT";

/** A rollover either created the next epoch or found the identical one already committed. */
export type PromptSurfaceRolloverResult = "COMMITTED" | "IDEMPOTENT";

/**
 * A caller's compare-and-swap expectation did not hold.
 *
 * This is a distinct outcome from an integrity failure: the stored log is intact, but another
 * writer moved the epoch forward (or replaced its identity) between the caller's read and its
 * write. Callers may re-read and re-decide exactly once; they must not treat it as corruption and
 * they must not retry without bound.
 */
export class PromptSurfaceRolloverConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptSurfaceRolloverConflictError";
  }
}

/**
 * One atomic request to replace the active epoch and commit its first baseline decision.
 *
 * The command is a *state transition*, not a sequence of calls: an epoch row without a baseline
 * is not a usable epoch, so both are committed together or neither is.
 */
export interface PromptSurfaceRolloverCommand {
  /** The identity the caller last verified as current. Compared field by field before writing. */
  readonly expectedCurrentEpoch: PromptSurfaceEpoch;
  /** The number of durable decisions the old epoch must still have. */
  readonly expectedRecordOrdinal: number;
  /** The old epoch's last decision fingerprint; `null` only for an epoch with no decisions. */
  readonly expectedDecisionFingerprint: string | null;
  /**
   * A deterministic identity for this transition.
   *
   * Derived from the Run, the source epoch, its last decision and the Step that triggered the
   * rollover — never from the current time — so a lost response can be retried and recognised.
   */
  readonly operationId: string;
  /** The next epoch. `epochId` is derived from `operationId`; `resetReason` is internal. */
  readonly newEpoch: PromptSurfaceEpoch;
  /** The first decision of the next epoch: ordinal 1, kind `BASELINE`, complete Section view. */
  readonly baseline: PromptSurfaceRecord;
  /** The complete Section view `baseline` leaves in effect, in canonical order. */
  readonly expectedSectionStates: readonly PromptSurfaceSectionState[];
}

/** A compaction atomically replaces the active epoch and installs the already prepared baseline. */
export interface PromptSurfaceCompactionActivationCommand {
  readonly expectedCurrent:
    | { readonly kind: "ABSENT" }
    | {
        readonly kind: "CURRENT";
        readonly epoch: PromptSurfaceEpoch;
        readonly recordOrdinal: number;
        readonly decisionFingerprint: string | null;
      };
  readonly operationId: string;
  readonly newEpoch: PromptSurfaceEpoch;
  readonly baseline: PromptSurfaceRecord;
  readonly expectedSectionStates: readonly PromptSurfaceSectionState[];
}

/** Durable host port for the run-scoped model-input projection. */
export interface PromptSurfaceStorePort {
  getCurrent(runId: RunId): Promise<PromptSurfaceEpoch | undefined>;
  createEpoch(epoch: PromptSurfaceEpoch): Promise<void>;
  /**
   * Append only while the caller's freshly computed current identity still matches the frozen
   * persisted epoch. Callers must not copy this identity from storage without comparing it with the
   * current model, tool schema, stable head, and cache settings.
   */
  appendSnapshot(
    snapshot: PromptSurfaceSnapshot,
    expectedCurrentEpoch: PromptSurfaceEpoch,
  ): Promise<PromptSurfaceAppendResult>;
  appendRecord(
    record: PromptSurfaceRecord,
    expectedCurrentEpoch: PromptSurfaceEpoch,
    expectedRecordOrdinal: number,
  ): Promise<PromptSurfaceAppendResult>;
  /**
   * Atomically close the expected epoch and open the next one with its baseline decision.
   *
   * The old epoch, its records and its Section state are preserved for audit and replay. Callers
   * must not emulate this with `createEpoch` followed by `appendRecord`: the intermediate state is
   * not a usable epoch, and a crash between the two calls would leave it that way.
   *
   * Throws `PromptSurfaceRolloverConflictError` when the expectation no longer holds.
   */
  rolloverEpoch(command: PromptSurfaceRolloverCommand): Promise<PromptSurfaceRolloverResult>;
  readEpoch(
    runId: RunId,
    epochId: PromptSurfaceEpochId,
  ): Promise<PromptSurfaceEpochWithSnapshots | undefined>;
}
