import type {
  ContextCompactionCommitPort,
  ContextCheckpointRecordV2,
  ContextCheckpointCreateInputV2,
} from "@caelush/agent";
import type { DurableRunEvent, DurableRunEventDraft } from "@caelush/agent";

import type { CaelushDatabase } from "./database.js";
import { StorageError } from "./errors.js";
import { appendDurableEventsInTransaction } from "./events/sqlite-durable-event-store.js";
import {
  SqliteContextCheckpointRepositoryV2,
  writeContextCheckpointV2InTransaction,
} from "./context-checkpoint-repository-v2.js";

/**
 * Atomically persists the immutable compaction checkpoint and its durable
 * event facts. Neither side is visible unless both writes commit.
 */
export class SqliteContextCompactionCommitStore implements ContextCompactionCommitPort {
  private readonly checkpoints: SqliteContextCheckpointRepositoryV2;

  constructor(private readonly database: CaelushDatabase) {
    this.checkpoints = new SqliteContextCheckpointRepositoryV2(database);
  }

  async commit(input: {
    readonly checkpoint: ContextCheckpointCreateInputV2;
    readonly events: readonly DurableRunEventDraft[];
  }): Promise<{
    readonly checkpoint: ContextCheckpointRecordV2;
    readonly events: readonly DurableRunEvent[];
  }> {
    assertEventOwnership(input.checkpoint, input.events);

    let committed = false;
    try {
      this.database.client.exec("BEGIN IMMEDIATE");
      writeContextCheckpointV2InTransaction(this.database.client, input.checkpoint);
      const events = appendDurableEventsInTransaction(this.database.client, input.events);
      this.database.client.exec("COMMIT");
      committed = true;

      const checkpoint = await this.checkpoints.getById(input.checkpoint.checkpointId);
      if (checkpoint === undefined || checkpoint.schemaVersion !== 2) {
        throw new StorageError("Committed Context Checkpoint V2 is unavailable.");
      }
      return Object.freeze({
        checkpoint,
        events: Object.freeze(events),
      });
    } catch (error) {
      if (!committed) {
        try {
          this.database.client.exec("ROLLBACK");
        } catch {
          // Preserve the original transaction error.
        }
      }
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to atomically commit Context compaction.", {
        cause: error,
      });
    }
  }
}

function assertEventOwnership(
  checkpoint: ContextCheckpointCreateInputV2,
  events: readonly DurableRunEventDraft[],
): void {
  for (const event of events) {
    if (event.runId !== checkpoint.runId) {
      throw new StorageError("Context compaction events must belong to the checkpoint Run.");
    }
  }
}
