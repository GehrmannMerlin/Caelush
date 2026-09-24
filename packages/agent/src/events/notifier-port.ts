import type { DurableRunEvent, TransientRunEvent } from "@caelush/protocol";

/**
 * The observation-plane notification seam owned by Agent.
 *
 * `notifyCommitted` accepts facts that already committed; it never writes Storage. `emitTransient`
 * is live-only and likewise has no persistence authority. Phase 6A freezes the contract only; the
 * daemon-owned RunEventHub and its queue semantics arrive in Phase 6B.
 */
export interface RunEventNotifierPort {
  notifyCommitted(events: readonly DurableRunEvent[]): void;
  emitTransient(event: TransientRunEvent): void;
}
