import type {
  ContextCompactionCommitPort,
  ContextCheckpointRecordV2,
  ContextCheckpointCreateInputV2,
} from "@caelush/agent";
import type { DurableRunEvent, DurableRunEventDraft } from "@caelush/agent";

import type { CaelushDatabase } from "./database.js";
import { StorageConflictError, StorageError } from "./errors.js";
import {
  appendDurableEventsInTransaction,
  findContextCompactionCompletionEventsInTransaction,
} from "./events/sqlite-durable-event-store.js";
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
      const written = writeContextCheckpointV2InTransaction(this.database.client, input.checkpoint);
      if (written.kind === "IDEMPOTENT_EXISTING") {
        const matchingEvents = findContextCompactionCompletionEventsInTransaction(
          this.database.client,
          {
            runId: input.checkpoint.runId,
            checkpointId: String(input.checkpoint.checkpointId),
          },
        );
        if (matchingEvents.length !== 1) {
          throw new StorageConflictError(
            "Existing Context Checkpoint V2 has no unique durable completion proof.",
          );
        }
        assertCompletionEventMatchesCheckpoint(matchingEvents[0]!, input.checkpoint);
        this.database.client.exec("COMMIT");
        committed = true;
        return Object.freeze({ checkpoint: written.checkpoint, events: Object.freeze([]) });
      }
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
    if (event.type === "context.compaction.completed") {
      assertCompletionEventMatchesCheckpoint(event, checkpoint);
    }
  }
}

function assertCompletionEventMatchesCheckpoint(
  event: { readonly type?: unknown; readonly payload?: unknown },
  checkpoint: ContextCheckpointCreateInputV2 | ContextCheckpointRecordV2,
): void {
  if (event.type !== "context.compaction.completed") {
    throw new StorageConflictError("Context completion event type is invalid.");
  }
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new StorageConflictError("Context completion event payload is invalid.");
  }
  const candidate = payload as Record<string, unknown>;
  const expected = {
    checkpointId: String(checkpoint.checkpointId),
    reason: checkpoint.reason,
    sourceSequenceFrom: checkpoint.sourceRange.firstSequence,
    sourceSequenceTo: checkpoint.sourceRange.lastSequence,
    tokensBefore: checkpoint.tokensBefore,
    tokensAfter: checkpoint.tokensAfter,
    degraded: checkpoint.degraded,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (candidate[key] !== value) {
      throw new StorageConflictError(
        `Context completion event field ${key} does not match its checkpoint.`,
      );
    }
  }
}
