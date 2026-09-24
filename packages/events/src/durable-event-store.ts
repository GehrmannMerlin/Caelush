import type { RunId, DurableRunEvent } from "@caelush/protocol";

/** @deprecated Use the Agent-owned read-only DurableRunEventReaderPort. */
export interface DurableEventStore {
  replay(
    runId: RunId,
    options?: { afterSequence?: number; throughSequence?: number; limit?: number },
  ): Promise<readonly DurableRunEvent[]>;
  latestSequence(runId: RunId): Promise<number>;
}
