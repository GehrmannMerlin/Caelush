import type { RunId } from "@caelush/protocol";
import type { DurableAgentEvent, DurableEventDraft } from "./event-draft.js";

export interface DurableEventStore {
  append(event: DurableEventDraft): Promise<DurableAgentEvent>;
  replay(
    runId: RunId,
    options?: { afterSequence?: number; limit?: number },
  ): Promise<DurableAgentEvent[]>;
  latestSequence(runId: RunId): Promise<number>;
}
