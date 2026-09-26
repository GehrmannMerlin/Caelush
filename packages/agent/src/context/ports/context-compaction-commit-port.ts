import type { DurableRunEvent } from "@caelush/protocol";

import type { DurableRunEventDraft } from "../../events/durable-run-event-draft.js";
import type {
  ContextCheckpointCreateInputV2,
  ContextCheckpointRecordV2,
} from "../compaction/context-compaction-contracts.js";

export interface ContextCompactionCommitPort {
  commit(input: {
    readonly checkpoint: ContextCheckpointCreateInputV2;
    readonly events: readonly DurableRunEventDraft[];
  }): Promise<{
    readonly checkpoint: ContextCheckpointRecordV2;
    readonly events: readonly DurableRunEvent[];
  }>;
}
