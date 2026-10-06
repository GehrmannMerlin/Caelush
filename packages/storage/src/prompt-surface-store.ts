import {
  assertPromptSurfaceEpoch,
  assertPromptSurfaceEpochWithSnapshots,
  assertPromptSurfaceSnapshot,
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceSnapshot,
  PROMPT_SURFACE_LIMITS,
  type PromptSurfaceAppendResult,
  type PromptSurfaceEpoch,
  type PromptSurfaceEpochInput,
  type PromptSurfaceEpochId,
  type PromptSurfaceEpochWithSnapshots,
  type PromptSurfaceSnapshot,
  type PromptSurfaceStorePort,
} from "@caelush/agent";
import type { RunId, TimestampMs } from "@caelush/protocol";

import type { CaelushDatabase } from "./database.js";
import { StorageConflictError, StorageDecodeError, StorageError } from "./errors.js";

interface EpochRow {
  run_id: string;
  epoch_id: string;
  model_provider: string;
  model_id: string;
  stable_head_fingerprint: string;
  tool_schema_fingerprint: string;
  cache_settings_fingerprint: string;
  reset_reason: string;
  created_step_sequence: number;
  created_at_ms: number;
}

interface SnapshotRow {
  run_id: string;
  epoch_id: string;
  ordinal: number;
  anchor_message_sequence: number;
  source_step_sequence: number;
  kind: string;
  content_hash: string;
  byte_length: number;
  created_at_ms: number;
  content: string;
}

interface SnapshotStatsRow {
  count: number;
  max_ordinal: number;
  max_anchor_message_sequence: number;
  max_source_step_sequence: number;
  total_bytes: number;
}

export class SqlitePromptSurfaceStore implements PromptSurfaceStorePort {
  constructor(private readonly database: CaelushDatabase) {}

  async getCurrent(runId: RunId): Promise<PromptSurfaceEpoch | undefined> {
    const row = this.readCurrentRow(runId);
    return row === undefined ? undefined : decodeEpoch(row);
  }

  async createEpoch(epoch: PromptSurfaceEpoch): Promise<void> {
    try {
      assertPromptSurfaceEpoch(epoch);
    } catch (error) {
      throw new StorageError("Prompt Surface epoch input is invalid.", { cause: error });
    }

    try {
      withImmediateTransaction(this.database, () => {
        const existing = this.readEpochRow(epoch.runId, epoch.epochId);
        if (existing !== undefined) {
          if (!sameEpoch(decodeEpoch(existing), epoch)) {
            throw new StorageConflictError(
              "Prompt Surface epoch identity is already bound to different metadata.",
            );
          }
          return;
        }

        const run = this.database.client
          .prepare("SELECT 1 AS found FROM agent_runs WHERE id = ?")
          .get(epoch.runId);
        if (run === undefined) {
          throw new StorageConflictError("Prompt Surface Run does not exist.");
        }

        const current = this.readCurrentRow(epoch.runId);
        if (current !== undefined) {
          const decodedCurrent = decodeEpoch(current);
          if (epoch.createdStepSequence < decodedCurrent.createdStepSequence) {
            throw new StorageConflictError(
              "Prompt Surface epoch sequence must not move behind the current epoch.",
            );
          }
        }

        this.database.client
          .prepare(
            `INSERT INTO prompt_surface_epochs
             (run_id, epoch_id, model_provider, model_id, stable_head_fingerprint,
              tool_schema_fingerprint, cache_settings_fingerprint, reset_reason,
              created_step_sequence, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            epoch.runId,
            epoch.epochId,
            epoch.modelRef.provider,
            epoch.modelRef.model,
            epoch.stableHeadFingerprint,
            epoch.toolSchemaFingerprint,
            epoch.cacheSettingsFingerprint,
            epoch.resetReason,
            epoch.createdStepSequence,
            epoch.createdAt,
          );
      });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to persist Prompt Surface epoch.", { cause: error });
    }
  }

  async appendSnapshot(
    snapshot: PromptSurfaceSnapshot,
    expectedCurrentEpoch: PromptSurfaceEpoch,
  ): Promise<PromptSurfaceAppendResult> {
    try {
      assertPromptSurfaceSnapshot(snapshot);
      assertPromptSurfaceEpoch(expectedCurrentEpoch);
    } catch (error) {
      throw new StorageError("Prompt Surface snapshot input or identity is invalid.", {
        cause: error,
      });
    }
    const byteLength = Buffer.byteLength(snapshot.content, "utf8");

    try {
      return withImmediateTransaction(this.database, () => {
        const current = this.readCurrentRow(snapshot.runId);
        if (
          current === undefined ||
          snapshot.runId !== expectedCurrentEpoch.runId ||
          snapshot.epochId !== expectedCurrentEpoch.epochId ||
          current.epoch_id !== expectedCurrentEpoch.epochId
        ) {
          throw new StorageConflictError(
            "Prompt Surface snapshot does not target the expected current epoch.",
          );
        }
        if (!sameEpoch(decodeEpoch(current), expectedCurrentEpoch)) {
          throw new StorageConflictError(
            "Prompt Surface model or cache identity changed before snapshot append.",
          );
        }
        if (snapshot.sourceStepSequence < expectedCurrentEpoch.createdStepSequence) {
          throw new StorageConflictError(
            "Prompt Surface snapshot predates the current epoch boundary.",
          );
        }
        const completeSurface = this.readEpochSync(snapshot.runId, snapshot.epochId);
        if (completeSurface === undefined) {
          throw new StorageDecodeError(
            "PromptSurfaceEpoch",
            epochKey(snapshot.runId, snapshot.epochId),
            "prompt_surface_epochs",
          );
        }

        const existing = this.readSnapshotBySourceStep(
          snapshot.runId,
          snapshot.epochId,
          snapshot.sourceStepSequence,
        );
        if (existing !== undefined) {
          if (!sameSnapshot(decodeSnapshot(existing), snapshot)) {
            throw new StorageConflictError(
              "Prompt Surface source step is already bound to different snapshot content.",
            );
          }
          return "IDEMPOTENT";
        }

        const stats = this.readSnapshotStats(snapshot.runId, snapshot.epochId);
        if (
          !Number.isSafeInteger(stats.count) ||
          stats.count < 0 ||
          !Number.isSafeInteger(stats.total_bytes) ||
          stats.total_bytes < 0 ||
          stats.total_bytes > PROMPT_SURFACE_LIMITS.maxEpochUtf8Bytes ||
          !Number.isSafeInteger(stats.max_ordinal) ||
          stats.max_ordinal < 0 ||
          !Number.isSafeInteger(stats.max_anchor_message_sequence) ||
          stats.max_anchor_message_sequence < 0 ||
          !Number.isSafeInteger(stats.max_source_step_sequence) ||
          stats.max_source_step_sequence < 0
        ) {
          throw new StorageDecodeError(
            "PromptSurfaceEpoch",
            epochKey(snapshot.runId, snapshot.epochId),
            "prompt_surface_snapshots",
          );
        }
        if (stats.max_ordinal !== stats.count) {
          throw new StorageDecodeError(
            "PromptSurfaceEpoch",
            epochKey(snapshot.runId, snapshot.epochId),
            "prompt_surface_snapshots",
          );
        }
        if (stats.count >= PROMPT_SURFACE_LIMITS.maxEpochSnapshots) {
          throw new StorageError("Prompt Surface epoch exceeds its snapshot count limit.");
        }
        if (snapshot.ordinal !== stats.count + 1) {
          throw new StorageConflictError(
            "Prompt Surface snapshot ordinal is not the next sequence.",
          );
        }
        if (snapshot.sourceStepSequence <= stats.max_source_step_sequence) {
          throw new StorageConflictError("Prompt Surface source step sequence must advance.");
        }
        if (snapshot.anchorMessageSequence < stats.max_anchor_message_sequence) {
          throw new StorageConflictError("Prompt Surface anchor sequence must not move backward.");
        }
        if (stats.total_bytes + byteLength > PROMPT_SURFACE_LIMITS.maxEpochUtf8Bytes) {
          throw new StorageError("Prompt Surface epoch exceeds its UTF-8 byte limit.");
        }

        this.database.client
          .prepare(
            `INSERT INTO prompt_surface_snapshots
             (run_id, epoch_id, ordinal, anchor_message_sequence, source_step_sequence,
              kind, content_hash, byte_length, created_at_ms, content)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snapshot.runId,
            snapshot.epochId,
            snapshot.ordinal,
            snapshot.anchorMessageSequence,
            snapshot.sourceStepSequence,
            snapshot.kind,
            snapshot.contentHash,
            byteLength,
            snapshot.createdAt,
            snapshot.content,
          );
        return "APPENDED";
      });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to persist Prompt Surface snapshot.", { cause: error });
    }
  }

  async readEpoch(
    runId: RunId,
    epochId: PromptSurfaceEpochId,
  ): Promise<PromptSurfaceEpochWithSnapshots | undefined> {
    return this.readEpochSync(runId, epochId);
  }

  private readEpochSync(
    runId: RunId,
    epochId: PromptSurfaceEpochId,
  ): PromptSurfaceEpochWithSnapshots | undefined {
    const row = this.readEpochRow(runId, epochId);
    if (row === undefined) return undefined;

    try {
      const epoch = decodeEpoch(row);
      const rows = this.database.client
        .prepare(
          `SELECT run_id, epoch_id, ordinal, anchor_message_sequence,
                  source_step_sequence, kind, content_hash, byte_length, created_at_ms, content
           FROM prompt_surface_snapshots
           WHERE run_id = ? AND epoch_id = ?
           ORDER BY ordinal ASC`,
        )
        .all(runId, epochId) as unknown as SnapshotRow[];
      const snapshots = Object.freeze(rows.map(decodeSnapshot));
      const surface: PromptSurfaceEpochWithSnapshots = Object.freeze({ ...epoch, snapshots });
      assertPromptSurfaceEpochWithSnapshots(surface);
      return surface;
    } catch (error) {
      if (error instanceof StorageDecodeError) throw error;
      throw new StorageDecodeError(
        "PromptSurfaceEpoch",
        epochKey(runId, epochId),
        "prompt_surface_epochs",
        {
          cause: error,
        },
      );
    }
  }

  private readCurrentRow(runId: RunId): EpochRow | undefined {
    return this.database.client
      .prepare(
        `SELECT run_id, epoch_id, model_provider, model_id, stable_head_fingerprint,
                tool_schema_fingerprint, cache_settings_fingerprint, reset_reason,
                created_step_sequence, created_at_ms
         FROM prompt_surface_epochs
         WHERE run_id = ?
         ORDER BY created_step_sequence DESC, rowid DESC
         LIMIT 1`,
      )
      .get(runId) as EpochRow | undefined;
  }

  private readEpochRow(runId: RunId, epochId: PromptSurfaceEpochId): EpochRow | undefined {
    return this.database.client
      .prepare(
        `SELECT run_id, epoch_id, model_provider, model_id, stable_head_fingerprint,
                tool_schema_fingerprint, cache_settings_fingerprint, reset_reason,
                created_step_sequence, created_at_ms
         FROM prompt_surface_epochs WHERE run_id = ? AND epoch_id = ?`,
      )
      .get(runId, epochId) as EpochRow | undefined;
  }

  private readSnapshotBySourceStep(
    runId: RunId,
    epochId: PromptSurfaceEpochId,
    sourceStepSequence: number,
  ): SnapshotRow | undefined {
    return this.database.client
      .prepare(
        `SELECT run_id, epoch_id, ordinal, anchor_message_sequence,
                source_step_sequence, kind, content_hash, byte_length, created_at_ms, content
         FROM prompt_surface_snapshots
         WHERE run_id = ? AND epoch_id = ? AND source_step_sequence = ?`,
      )
      .get(runId, epochId, sourceStepSequence) as SnapshotRow | undefined;
  }

  private readSnapshotStats(runId: RunId, epochId: PromptSurfaceEpochId): SnapshotStatsRow {
    return this.database.client
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(MAX(ordinal), 0) AS max_ordinal,
                COALESCE(MAX(anchor_message_sequence), 0) AS max_anchor_message_sequence,
                COALESCE(MAX(source_step_sequence), 0) AS max_source_step_sequence,
                COALESCE(SUM(byte_length), 0) AS total_bytes
         FROM prompt_surface_snapshots WHERE run_id = ? AND epoch_id = ?`,
      )
      .get(runId, epochId) as unknown as SnapshotStatsRow;
  }
}

function decodeEpoch(row: EpochRow): PromptSurfaceEpoch {
  try {
    const input: PromptSurfaceEpochInput = {
      runId: row.run_id as RunId,
      epochId: row.epoch_id,
      modelRef: { provider: row.model_provider, model: row.model_id },
      stableHeadFingerprint: row.stable_head_fingerprint,
      toolSchemaFingerprint: row.tool_schema_fingerprint,
      cacheSettingsFingerprint: row.cache_settings_fingerprint,
      resetReason: row.reset_reason as PromptSurfaceEpoch["resetReason"],
      createdStepSequence: row.created_step_sequence,
      createdAt: row.created_at_ms as TimestampMs,
    };
    return createPromptSurfaceEpoch(input);
  } catch (error) {
    throw new StorageDecodeError(
      "PromptSurfaceEpoch",
      epochKey(row.run_id as RunId, row.epoch_id as PromptSurfaceEpochId),
      "prompt_surface_epochs",
      { cause: error },
    );
  }
}

function decodeSnapshot(row: SnapshotRow): PromptSurfaceSnapshot {
  try {
    const snapshot = createPromptSurfaceSnapshot({
      runId: row.run_id as RunId,
      epochId: createPromptSurfaceEpochId(row.epoch_id),
      ordinal: row.ordinal,
      anchorMessageSequence: row.anchor_message_sequence,
      sourceStepSequence: row.source_step_sequence,
      kind: row.kind as PromptSurfaceSnapshot["kind"],
      content: row.content,
      createdAt: row.created_at_ms as TimestampMs,
    });
    if (
      snapshot.contentHash !== row.content_hash ||
      Buffer.byteLength(snapshot.content, "utf8") !== row.byte_length
    ) {
      throw new Error("Prompt Surface snapshot integrity metadata does not match.");
    }
    assertPromptSurfaceSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    throw new StorageDecodeError(
      "PromptSurfaceSnapshot",
      `${row.run_id}:${row.epoch_id}:${String(row.ordinal)}`,
      "prompt_surface_snapshots",
      { cause: error },
    );
  }
}

function sameEpoch(left: PromptSurfaceEpoch, right: PromptSurfaceEpoch): boolean {
  return (
    left.runId === right.runId &&
    left.epochId === right.epochId &&
    left.modelRef.provider === right.modelRef.provider &&
    left.modelRef.model === right.modelRef.model &&
    left.stableHeadFingerprint === right.stableHeadFingerprint &&
    left.toolSchemaFingerprint === right.toolSchemaFingerprint &&
    left.cacheSettingsFingerprint === right.cacheSettingsFingerprint &&
    left.resetReason === right.resetReason &&
    left.createdStepSequence === right.createdStepSequence &&
    left.createdAt === right.createdAt
  );
}

function sameSnapshot(left: PromptSurfaceSnapshot, right: PromptSurfaceSnapshot): boolean {
  return (
    left.runId === right.runId &&
    left.epochId === right.epochId &&
    left.ordinal === right.ordinal &&
    left.anchorMessageSequence === right.anchorMessageSequence &&
    left.sourceStepSequence === right.sourceStepSequence &&
    left.kind === right.kind &&
    left.contentHash === right.contentHash &&
    left.content === right.content
  );
}

function withImmediateTransaction<T>(database: CaelushDatabase, operation: () => T): T {
  database.client.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.client.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.client.exec("ROLLBACK");
    } catch {
      // Keep the operation error as the safe, reportable cause.
    }
    throw error;
  }
}

function epochKey(runId: RunId, epochId: PromptSurfaceEpochId): string {
  return `${runId}:${epochId}`;
}
