import { createHash } from "node:crypto";

import type {
  ContextCompactionCommitPort,
  ContextCheckpointRecordV2,
  ContextCheckpointCreateInputV2,
  ContextCheckpointRecordV3,
  ContextCheckpointCreateInputV3,
} from "@caelush/agent";
import type { ContextArtifactCreateInput } from "@caelush/agent";
import { canonicalJsonText } from "@caelush/agent";
import type {
  PromptSurfaceEpoch,
  PromptSurfaceRecord,
  PromptSurfaceSectionState,
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
import { SqlitePromptSurfaceStore } from "./prompt-surface-store.js";
import { SqliteContextUsageStore } from "./context-usage-store.js";
import { writeContextArtifactInTransaction } from "./context-artifact-store.js";
import {
  SqliteContextCheckpointRepositoryV3,
  writeContextCheckpointV3InTransaction,
} from "./context-checkpoint-repository-v3.js";

/**
 * Atomically persists the immutable compaction checkpoint and its durable
 * event facts. Neither side is visible unless both writes commit.
 */
export class SqliteContextCompactionCommitStore implements ContextCompactionCommitPort {
  private readonly checkpoints: SqliteContextCheckpointRepositoryV2;
  private readonly checkpointsV3: SqliteContextCheckpointRepositoryV3;
  private readonly promptSurface: SqlitePromptSurfaceStore;
  private readonly usage: SqliteContextUsageStore;

  constructor(private readonly database: CaelushDatabase) {
    this.checkpoints = new SqliteContextCheckpointRepositoryV2(database);
    this.checkpointsV3 = new SqliteContextCheckpointRepositoryV3(database);
    this.promptSurface = new SqlitePromptSurfaceStore(database);
    this.usage = new SqliteContextUsageStore(database);
  }

  async commit(input: {
    readonly checkpoint: ContextCheckpointCreateInputV2;
    readonly events: readonly DurableRunEventDraft[];
    readonly activation?: Parameters<ContextCompactionCommitPort["commit"]>[0]["activation"];
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
        if (input.activation !== undefined) {
          this.promptSurface.activateCompactionInTransaction(input.activation.promptSurface);
          this.usage.upsertInTransaction(input.activation.usage);
        }
        this.database.client.exec("COMMIT");
        committed = true;
        return Object.freeze({ checkpoint: written.checkpoint, events: Object.freeze([]) });
      }
      if (input.activation !== undefined) {
        this.promptSurface.activateCompactionInTransaction(input.activation.promptSurface);
        this.usage.upsertInTransaction(input.activation.usage);
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

  async commitV3(input: {
    readonly checkpoint: ContextCheckpointCreateInputV3;
    readonly events: readonly DurableRunEventDraft[];
    readonly terminalArtifact?: ContextArtifactCreateInput;
    readonly activation: Parameters<
      NonNullable<ContextCompactionCommitPort["commitV3"]>
    >[0]["activation"];
  }): Promise<{
    readonly checkpoint: ContextCheckpointRecordV3;
    readonly events: readonly DurableRunEvent[];
    readonly status: "COMMITTED" | "IDEMPOTENT";
  }> {
    assertV3EventOwnership(input.checkpoint, input.activation.promptSurface, input.events);
    if (input.terminalArtifact !== undefined) {
      assertTerminalAttemptArtifact(input.checkpoint, input.terminalArtifact);
    }
    let committed = false;
    try {
      this.database.client.exec("BEGIN IMMEDIATE");
      if (input.terminalArtifact !== undefined) {
        assertAttemptStartExistsInTransaction(
          this.database,
          input.checkpoint,
          input.terminalArtifact,
        );
      }
      const written = writeContextCheckpointV3InTransaction(this.database, input.checkpoint);
      if (written.kind === "IDEMPOTENT_EXISTING") {
        const matchingEvents = findContextCompactionCompletionEventsInTransaction(
          this.database.client,
          {
            runId: input.checkpoint.ownerRunId,
            checkpointId: String(input.checkpoint.checkpointId),
          },
        );
        const event = matchingEvents.find((candidate) => candidate.schemaVersion === 2);
        if (matchingEvents.length !== 1 || event === undefined) {
          throw new StorageConflictError(
            "Existing Context Checkpoint V3 has no unique durable V2 completion proof.",
          );
        }
        assertV3CompletionEventMatches(event, input.checkpoint, input.activation.promptSurface);
        assertActivationProofMatches(
          this.database,
          input.checkpoint,
          input.activation.promptSurface,
        );
        if (input.terminalArtifact !== undefined) {
          writeContextArtifactInTransaction(this.database, input.terminalArtifact);
        }
        this.database.client.exec("COMMIT");
        committed = true;
        return Object.freeze({
          checkpoint: written.checkpoint,
          events: Object.freeze([]),
          status: "IDEMPOTENT",
        });
      }

      this.promptSurface.activateCompactionInTransaction(input.activation.promptSurface);
      this.usage.upsertInTransaction(input.activation.usage);
      insertActivationProof(this.database, input.checkpoint, input.activation.promptSurface);
      if (input.terminalArtifact !== undefined) {
        writeContextArtifactInTransaction(this.database, input.terminalArtifact);
      }
      const events = appendDurableEventsInTransaction(this.database.client, input.events);
      this.database.client.exec("COMMIT");
      committed = true;

      const checkpoint = await this.checkpointsV3.getById(input.checkpoint.checkpointId);
      if (checkpoint === undefined || checkpoint.schemaVersion !== 3) {
        throw new StorageError("Committed Context Checkpoint V3 is unavailable.");
      }
      return Object.freeze({ checkpoint, events: Object.freeze(events), status: "COMMITTED" });
    } catch (error) {
      if (!committed) {
        try {
          this.database.client.exec("ROLLBACK");
        } catch {
          // Preserve the original transaction error.
        }
      }
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to atomically activate Context Checkpoint V3.", {
        cause: error,
      });
    }
  }
}

function assertV3EventOwnership(
  checkpoint: ContextCheckpointCreateInputV3,
  activation: Parameters<
    NonNullable<ContextCompactionCommitPort["commitV3"]>
  >[0]["activation"]["promptSurface"],
  events: readonly DurableRunEventDraft[],
): void {
  if (activation.operationId !== checkpoint.activationOperationId) {
    throw new StorageConflictError("V3 checkpoint and Prompt Surface operation IDs differ.");
  }
  if (String(activation.newEpoch.runId) !== String(checkpoint.ownerRunId)) {
    throw new StorageConflictError("V3 Prompt Surface activation belongs to another Run.");
  }
  const completions = events.filter((event) => event.type === "context.compaction.completed");
  if (events.length !== 1 || completions.length !== 1) {
    throw new StorageConflictError("V3 compaction must commit exactly one completion event.");
  }
  const event = completions[0]!;
  if (
    event.runId !== checkpoint.ownerRunId ||
    event.sessionId !== checkpoint.sessionId ||
    event.schemaVersion !== 2
  ) {
    throw new StorageConflictError("V3 completion event ownership or schema version is invalid.");
  }
  assertV3CompletionEventMatches(event, checkpoint, activation);
}

function assertV3CompletionEventMatches(
  event: { readonly type?: unknown; readonly schemaVersion?: unknown; readonly payload?: unknown },
  checkpoint: ContextCheckpointCreateInputV3 | ContextCheckpointRecordV3,
  activation: Parameters<
    NonNullable<ContextCompactionCommitPort["commitV3"]>
  >[0]["activation"]["promptSurface"],
): void {
  if (event.type !== "context.compaction.completed" || event.schemaVersion !== 2) {
    throw new StorageConflictError("V3 completion event type or version is invalid.");
  }
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new StorageConflictError("V3 completion event payload is invalid.");
  }
  const value = payload as Record<string, unknown>;
  const expected = {
    checkpointId: String(checkpoint.checkpointId),
    operationId: checkpoint.activationOperationId,
    epochId: activation.newEpoch.epochId,
    reason: checkpoint.reason,
    sourceRangeCount: checkpoint.coverage.segments.length,
    sourceMessageCount: checkpoint.coverage.messageCount,
    tokensBefore: checkpoint.tokensBefore,
    tokensAfter: checkpoint.tokensAfter,
    freedTokens: Math.max(0, checkpoint.tokensBefore - checkpoint.tokensAfter),
    degraded: checkpoint.degraded,
    targetStatus: checkpoint.targetStatus,
  };
  if (canonicalJsonText(value as never) !== canonicalJsonText(expected as never)) {
    throw new StorageConflictError("V3 completion event does not match its checkpoint.");
  }
}

function insertActivationProof(
  database: CaelushDatabase,
  checkpoint: ContextCheckpointCreateInputV3,
  activation: Parameters<
    NonNullable<ContextCompactionCommitPort["commitV3"]>
  >[0]["activation"]["promptSurface"],
): void {
  const fingerprint = baselineFingerprint(activation);
  try {
    database.client
      .prepare(
        `INSERT INTO context_compaction_activations
         (operation_id, checkpoint_id, session_id, owner_run_id, owner_step_sequence, epoch_id, baseline_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.activationOperationId,
        checkpoint.checkpointId,
        checkpoint.sessionId,
        checkpoint.ownerRunId,
        checkpoint.ownerStepSequence,
        activation.newEpoch.epochId,
        fingerprint,
      );
  } catch (error) {
    throw new StorageConflictError("Context Checkpoint V3 activation proof could not be written.", {
      cause: error,
    });
  }
}

function assertActivationProofMatches(
  database: CaelushDatabase,
  checkpoint: ContextCheckpointCreateInputV3 | ContextCheckpointRecordV3,
  activation: Parameters<
    NonNullable<ContextCompactionCommitPort["commitV3"]>
  >[0]["activation"]["promptSurface"],
): void {
  const row = database.client
    .prepare(
      `SELECT checkpoint_id, session_id, owner_run_id, owner_step_sequence, epoch_id, baseline_fingerprint
       FROM context_compaction_activations WHERE operation_id = ?`,
    )
    .get(checkpoint.activationOperationId) as
    | {
        readonly checkpoint_id: string;
        readonly session_id: string;
        readonly owner_run_id: string;
        readonly owner_step_sequence: number;
        readonly epoch_id: string;
        readonly baseline_fingerprint: string;
      }
    | undefined;
  if (
    row === undefined ||
    row.checkpoint_id !== String(checkpoint.checkpointId) ||
    row.session_id !== String(checkpoint.sessionId) ||
    row.owner_run_id !== String(checkpoint.ownerRunId) ||
    row.owner_step_sequence !== checkpoint.ownerStepSequence ||
    row.epoch_id !== activation.newEpoch.epochId ||
    row.baseline_fingerprint !== baselineFingerprint(activation)
  ) {
    throw new StorageConflictError("Existing V3 checkpoint activation proof conflicts.");
  }
}

export function baselineFingerprint(
  activation: Parameters<
    NonNullable<ContextCompactionCommitPort["commitV3"]>
  >[0]["activation"]["promptSurface"],
): string {
  return createPromptSurfaceActivationFingerprint({
    newEpoch: activation.newEpoch,
    baseline: activation.baseline,
    expectedSectionStates: activation.expectedSectionStates,
  });
}

function assertTerminalAttemptArtifact(
  checkpoint: ContextCheckpointCreateInputV3,
  artifact: ContextArtifactCreateInput,
): void {
  let value: unknown;
  try {
    value = JSON.parse(artifact.content) as unknown;
  } catch (error) {
    throw new StorageConflictError("Successful Context compaction attempt receipt is malformed.", {
      cause: error,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageConflictError("Successful Context compaction attempt receipt is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    artifact.kind !== "context-compaction-attempt" ||
    artifact.sourceRef !== record.attemptId ||
    artifact.sensitivity !== "INTERNAL" ||
    record.version !== 1 ||
    record.recordType !== "ATTEMPT" ||
    record.state !== "RESULT" ||
    record.outcome !== "COMPACTED" ||
    record.checkpointId !== String(checkpoint.checkpointId) ||
    record.activationOperationId !== checkpoint.activationOperationId ||
    typeof record.sourceCoverageDigest !== "string" ||
    !Number.isSafeInteger(record.sourceTokens)
  ) {
    throw new StorageConflictError(
      "Successful Context compaction attempt receipt does not match its checkpoint.",
    );
  }
}

function assertAttemptStartExistsInTransaction(
  database: CaelushDatabase,
  checkpoint: ContextCheckpointCreateInputV3,
  terminalArtifact: ContextArtifactCreateInput,
): void {
  if (terminalArtifact.runId !== checkpoint.ownerRunId) {
    throw new StorageConflictError("Compaction attempt owner does not match its checkpoint Run.");
  }
  const rows = database.client
    .prepare(
      `SELECT run_id, content FROM context_artifacts
       WHERE kind = 'context-compaction-attempt' AND source_ref = ?`,
    )
    .all(terminalArtifact.sourceRef) as Array<{
    readonly run_id: string;
    readonly content: string;
  }>;
  const terminal = JSON.parse(terminalArtifact.content) as Record<string, unknown>;
  const found = rows.some((row) => {
    if (row.run_id !== checkpoint.ownerRunId) return false;
    try {
      const record = JSON.parse(row.content) as Record<string, unknown>;
      return (
        record.version === 1 &&
        record.recordType === "ATTEMPT" &&
        record.attemptId === terminal.attemptId &&
        record.state === "START" &&
        record.sourceCoverageDigest === terminal.sourceCoverageDigest &&
        record.sourceTokens === terminal.sourceTokens
      );
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new StorageConflictError("Compaction attempt has no matching durable START claim.");
  }
}

export function createPromptSurfaceActivationFingerprint(input: {
  readonly newEpoch: PromptSurfaceEpoch;
  readonly baseline: PromptSurfaceRecord;
  readonly expectedSectionStates: readonly PromptSurfaceSectionState[];
}): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJsonText({
        epoch: input.newEpoch,
        baseline: input.baseline,
        sectionStates: input.expectedSectionStates,
      } as never),
    )
    .digest("hex")}`;
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
