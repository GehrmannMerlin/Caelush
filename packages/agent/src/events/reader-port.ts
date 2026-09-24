import type { DurableRunEvent, RunId } from "@caelush/protocol";

/** Read-only durable event access for the future daemon-side replay/live hub. */
export interface DurableRunEventReaderPort {
  replay(
    runId: RunId,
    options: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly limit: number;
    },
  ): Promise<readonly DurableRunEvent[]>;

  latestSequence(runId: RunId): Promise<number>;
}
