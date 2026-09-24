import type { DurableRunEvent, TransientRunEvent } from "@caelush/protocol";

/**
 * The observation-plane notification seam owned by Agent.
 *
 * `notifyCommitted` accepts facts that already committed; it never writes Storage. `emitTransient`
 * is live-only and likewise has no persistence authority. The daemon-owned RunEventHub implements
 * the delivery semantics behind this port.
 */
export interface RunEventNotifierPort {
  notifyCommitted(events: readonly DurableRunEvent[]): void;
  emitTransient(event: TransientRunEvent): void;
}
