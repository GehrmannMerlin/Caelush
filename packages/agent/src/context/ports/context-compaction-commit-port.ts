import type { DurableRunEvent } from "@caelush/protocol";

import type { DurableRunEventDraft } from "../../events/durable-run-event-draft.js";
import type { ContextArtifactCreateInput } from "../artifacts/context-artifact.js";
import type { ContextUsageSnapshot } from "../receipts/context-usage.js";
import type { PromptSurfaceCompactionActivationCommand } from "../surface/prompt-surface-store.js";
import type {
  ContextCheckpointCreateInputV2,
  ContextCheckpointRecordV2,
} from "../compaction/context-compaction-contracts.js";
import type {
  ContextCheckpointCreateInputV3,
  ContextCheckpointRecordV3,
  CompactionTargetStatus,
} from "../compaction/context-checkpoint-v3.js";

export interface ContextCompactionCommitPort {
  commit(input: {
    readonly checkpoint: ContextCheckpointCreateInputV2;
    readonly events: readonly DurableRunEventDraft[];
    readonly activation?: {
      readonly promptSurface: PromptSurfaceCompactionActivationCommand;
      readonly usage: ContextUsageSnapshot;
    };
  }): Promise<{
    readonly checkpoint: ContextCheckpointRecordV2;
    readonly events: readonly DurableRunEvent[];
  }>;

  /** The Session-scoped V3 activation transaction. Implemented by the daemon's Storage adapter. */
  commitV3?(input: {
    readonly checkpoint: ContextCheckpointCreateInputV3;
    readonly events: readonly DurableRunEventDraft[];
    /** Successful attempt settlement is committed with checkpoint activation, never afterward. */
    readonly terminalArtifact?: ContextArtifactCreateInput;
    readonly activation: {
      readonly promptSurface: PromptSurfaceCompactionActivationCommand;
      readonly usage: ContextUsageSnapshot;
      readonly targetStatus: CompactionTargetStatus;
    };
  }): Promise<{
    readonly checkpoint: ContextCheckpointRecordV3;
    readonly events: readonly DurableRunEvent[];
    readonly status: "COMMITTED" | "IDEMPOTENT";
  }>;
}
