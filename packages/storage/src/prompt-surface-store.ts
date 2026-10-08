import {
  applyPromptSurfaceSectionUpdates,
  assertPromptSurfaceEpoch,
  assertPromptSurfaceEpochWithSnapshots,
  assertPromptSurfaceSnapshot,
  assertPromptSurfaceRecord,
  assertPromptSurfaceSectionStates,
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceSnapshot,
  createPromptSurfaceRecord,
  PROMPT_SURFACE_LIMITS,
  type PromptSurfaceAppendResult,
  type PromptSurfaceEpoch,
  type PromptSurfaceEpochInput,
  type PromptSurfaceEpochId,
  type PromptSurfaceEpochWithSnapshots,
  type PromptSurfaceSnapshot,
  type PromptSurfaceRecord,
  type PromptSurfaceSectionState,
  type PromptSurfaceStorePort,
} from "@caelush/agent";
import type { RunId, TimestampMs } from "@caelush/protocol";

import type { CaelushDatabase } from "./database.js";
import { StorageConflictError, StorageDecodeError, StorageError } from "./errors.js";

interface EpochRow {
  run_id: string;
  epoch_id: string;
  format_version: number;
  model_provider: string;
  model_id: string;
  stable_head_fingerprint: string;
  tool_schema_fingerprint: string;
  cache_settings_fingerprint: string;
  reset_reason: string;
  created_step_sequence: number;
  created_at_ms: number;
}

interface RecordRow {
  run_id: string;
  epoch_id: string;
  ordinal: number;
  anchor_message_sequence: number;
  anchor_message_id: string;
  anchor_run_id: string;
  anchor_conversation_turn_id: string;
  source_step_sequence: number;
  kind: string;
  updates_json: string;
  decision_fingerprint: string;
  content_hash: string;
  byte_length: number;
  created_at_ms: number;
}

interface SectionStateRow {
  state_key: string;
  content_hash: string;
  content: string;
  updated_ordinal: number;
}

interface SnapshotRow {
  run_id: string;
  epoch_id: string;
  ordinal: number;
  anchor_message_sequence: number;
  anchor_message_id: string | null;
  anchor_run_id: string | null;
  anchor_conversation_turn_id: string | null;
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
             (run_id, epoch_id, format_version, model_provider, model_id, stable_head_fingerprint,
              tool_schema_fingerprint, cache_settings_fingerprint, reset_reason,
              created_step_sequence, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            epoch.runId,
            epoch.epochId,
            epoch.formatVersion,
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
          current.format_version !== 2 ||
          snapshot.runId !== expectedCurrentEpoch.runId ||
          expectedCurrentEpoch.formatVersion !== 2 ||
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
        if (stats.total_bytes + byteLength > PROMPT_SURFACE_LIMITS.maxEpochUtf8Bytes) {
          throw new StorageError("Prompt Surface epoch exceeds its UTF-8 byte limit.");
        }

        this.database.client
          .prepare(
            `INSERT INTO prompt_surface_snapshots
             (run_id, epoch_id, ordinal, anchor_message_sequence, anchor_message_id, anchor_run_id,
              anchor_conversation_turn_id, source_step_sequence, kind, content_hash, byte_length,
              created_at_ms, content)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snapshot.runId,
            snapshot.epochId,
            snapshot.ordinal,
            snapshot.anchor.sequence,
            snapshot.anchor.messageId,
            snapshot.anchor.runId,
            snapshot.anchor.conversationTurnId,
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

  async appendRecord(
    record: PromptSurfaceRecord,
    expectedCurrentEpoch: PromptSurfaceEpoch,
    expectedRecordOrdinal: number,
  ): Promise<PromptSurfaceAppendResult> {
    try {
      assertPromptSurfaceRecord(record);
      assertPromptSurfaceEpoch(expectedCurrentEpoch);
      if (!Number.isSafeInteger(expectedRecordOrdinal) || expectedRecordOrdinal < 0) {
        throw new TypeError("Prompt Surface expected record ordinal is invalid.");
      }
    } catch (error) {
      throw new StorageError("Prompt Surface V3 record input or identity is invalid.", {
        cause: error,
      });
    }

    try {
      return withImmediateTransaction(this.database, () => {
        const current = this.readCurrentRow(record.runId);
        if (
          current === undefined ||
          current.format_version !== 3 ||
          record.runId !== expectedCurrentEpoch.runId ||
          record.epochId !== expectedCurrentEpoch.epochId ||
          current.epoch_id !== expectedCurrentEpoch.epochId ||
          expectedCurrentEpoch.formatVersion !== 3
        ) {
          throw new StorageConflictError(
            "Prompt Surface V3 record does not target the expected current epoch.",
          );
        }
        if (!sameEpoch(decodeEpoch(current), expectedCurrentEpoch)) {
          throw new StorageConflictError(
            "Prompt Surface V3 epoch identity changed before record append.",
          );
        }
        const complete = this.readEpochSync(record.runId, record.epochId);
        if (
          complete === undefined ||
          complete.records === undefined ||
          complete.sectionStates === undefined
        ) {
          throw new StorageDecodeError(
            "PromptSurfaceEpoch",
            epochKey(record.runId, record.epochId),
            "prompt_surface_records",
          );
        }
        const existing = this.readRecordBySourceStep(
          record.runId,
          record.epochId,
          record.sourceStepSequence,
        );
        if (existing !== undefined) {
          const decoded = decodeRecord(existing);
          if (decoded.contentHash !== record.contentHash) {
            throw new StorageConflictError(
              "Prompt Surface V3 source Step is already bound to a different decision.",
            );
          }
          return "IDEMPOTENT";
        }
        if (
          complete.records.length !== expectedRecordOrdinal ||
          record.ordinal !== expectedRecordOrdinal + 1 ||
          (complete.records.at(-1)?.sourceStepSequence ?? complete.createdStepSequence - 1) >=
            record.sourceStepSequence
        ) {
          throw new StorageConflictError(
            "Prompt Surface V3 record compare-and-swap or Step order failed.",
          );
        }
        const sectionStates = applyPromptSurfaceSectionUpdates(
          complete.sectionStates,
          record.kind,
          record.updates,
        );
        const next: PromptSurfaceEpochWithSnapshots = {
          ...complete,
          records: [...complete.records, record],
          sectionStates,
        };
        assertPromptSurfaceEpochWithSnapshots(next);
        const result = this.database.client
          .prepare(
            `INSERT INTO prompt_surface_records
           (run_id, epoch_id, ordinal, anchor_message_sequence, anchor_message_id, anchor_run_id,
            anchor_conversation_turn_id, source_step_sequence, kind, updates_json, decision_fingerprint,
            content_hash, byte_length, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.runId,
            record.epochId,
            record.ordinal,
            record.anchor.sequence,
            record.anchor.messageId,
            record.anchor.runId,
            record.anchor.conversationTurnId,
            record.sourceStepSequence,
            record.kind,
            stableJson(record.updates),
            record.decisionFingerprint,
            record.contentHash,
            record.byteLength,
            record.createdAt,
          );
        if (Number(result.changes) !== 1)
          throw new StorageConflictError("Prompt Surface V3 record insert did not affect one row.");

        const deleteState = this.database.client.prepare(
          "DELETE FROM prompt_surface_section_state WHERE run_id = ? AND epoch_id = ? AND state_key = ?",
        );
        const upsertState = this.database.client.prepare(
          `INSERT INTO prompt_surface_section_state (run_id, epoch_id, state_key, content_hash, content, updated_ordinal)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, epoch_id, state_key) DO UPDATE SET
             content_hash = excluded.content_hash, content = excluded.content, updated_ordinal = excluded.updated_ordinal`,
        );
        for (const update of record.updates) {
          if (update.op === "CLEAR") {
            deleteState.run(record.runId, record.epochId, update.stateKey);
          } else {
            upsertState.run(
              record.runId,
              record.epochId,
              update.stateKey,
              update.contentHash,
              update.content,
              record.ordinal,
            );
          }
        }
        const storedState = this.readSectionStates(record.runId, record.epochId, [
          ...complete.records,
          record,
        ]);
        if (stableJson(storedState) !== stableJson(sectionStates)) {
          throw new StorageDecodeError(
            "PromptSurfaceSectionState",
            epochKey(record.runId, record.epochId),
            "prompt_surface_section_state",
          );
        }
        return "APPENDED";
      });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("Unable to persist Prompt Surface V3 record.", { cause: error });
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
          `SELECT run_id, epoch_id, ordinal, anchor_message_sequence, anchor_message_id,
                  anchor_run_id, anchor_conversation_turn_id,
                  source_step_sequence, kind, content_hash, byte_length, created_at_ms, content
           FROM prompt_surface_snapshots
           WHERE run_id = ? AND epoch_id = ?
           ORDER BY ordinal ASC`,
        )
        .all(runId, epochId) as unknown as SnapshotRow[];
      const snapshots = Object.freeze(rows.map(decodeSnapshot));
      const records =
        epoch.formatVersion === 3
          ? Object.freeze(
              (
                this.database.client
                  .prepare(
                    `SELECT run_id, epoch_id, ordinal, anchor_message_sequence, anchor_message_id, anchor_run_id,
                    anchor_conversation_turn_id, source_step_sequence, kind, updates_json, decision_fingerprint,
                    content_hash, byte_length, created_at_ms
             FROM prompt_surface_records WHERE run_id = ? AND epoch_id = ? ORDER BY ordinal ASC`,
                  )
                  .all(runId, epochId) as unknown as RecordRow[]
              ).map(decodeRecord),
            )
          : undefined;
      const sectionStates =
        epoch.formatVersion === 3
          ? this.readSectionStates(runId, epochId, records ?? [])
          : undefined;
      const surface: PromptSurfaceEpochWithSnapshots = Object.freeze({
        ...epoch,
        snapshots,
        ...(records === undefined ? {} : { records }),
        ...(sectionStates === undefined ? {} : { sectionStates }),
      });
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
                format_version, tool_schema_fingerprint, cache_settings_fingerprint, reset_reason,
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
                format_version, tool_schema_fingerprint, cache_settings_fingerprint, reset_reason,
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
        `SELECT run_id, epoch_id, ordinal, anchor_message_sequence, anchor_message_id,
                anchor_run_id, anchor_conversation_turn_id,
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
                COALESCE(MAX(source_step_sequence), 0) AS max_source_step_sequence,
                COALESCE(SUM(byte_length), 0) AS total_bytes
         FROM prompt_surface_snapshots WHERE run_id = ? AND epoch_id = ?`,
      )
      .get(runId, epochId) as unknown as SnapshotStatsRow;
  }

  private readRecordBySourceStep(
    runId: RunId,
    epochId: PromptSurfaceEpochId,
    sourceStepSequence: number,
  ): RecordRow | undefined {
    return this.database.client
      .prepare(
        `SELECT run_id, epoch_id, ordinal, anchor_message_sequence, anchor_message_id, anchor_run_id,
              anchor_conversation_turn_id, source_step_sequence, kind, updates_json, decision_fingerprint,
              content_hash, byte_length, created_at_ms
       FROM prompt_surface_records WHERE run_id = ? AND epoch_id = ? AND source_step_sequence = ?`,
      )
      .get(runId, epochId, sourceStepSequence) as RecordRow | undefined;
  }

  private readSectionStates(
    runId: RunId,
    epochId: PromptSurfaceEpochId,
    records: readonly PromptSurfaceRecord[],
  ): readonly PromptSurfaceSectionState[] {
    const rows = this.database.client
      .prepare(
        `SELECT state_key, content_hash, content, updated_ordinal
       FROM prompt_surface_section_state WHERE run_id = ? AND epoch_id = ? ORDER BY state_key ASC`,
      )
      .all(runId, epochId) as unknown as SectionStateRow[];
    const lastSetOrdinal = new Map<string, number>();
    for (const record of records) {
      for (const update of record.updates) {
        if (update.op === "CLEAR") lastSetOrdinal.delete(update.stateKey);
        else lastSetOrdinal.set(update.stateKey, record.ordinal);
      }
    }
    const states = Object.freeze(
      rows.map((row) => {
        if (
          !Number.isSafeInteger(row.updated_ordinal) ||
          row.updated_ordinal < 1 ||
          lastSetOrdinal.get(row.state_key) !== row.updated_ordinal
        ) {
          throw new StorageDecodeError(
            "PromptSurfaceSectionState",
            `${runId}:${epochId}:${row.state_key}`,
            "prompt_surface_section_state",
          );
        }
        return Object.freeze({
          stateKey: row.state_key,
          contentHash: row.content_hash,
          content: row.content,
        });
      }),
    );
    if (states.length !== lastSetOrdinal.size) {
      throw new StorageDecodeError(
        "PromptSurfaceSectionState",
        epochKey(runId, epochId),
        "prompt_surface_section_state",
      );
    }
    assertPromptSurfaceSectionStates(states);
    return states;
  }
}

function decodeEpoch(row: EpochRow): PromptSurfaceEpoch {
  try {
    const input: PromptSurfaceEpochInput = {
      runId: row.run_id as RunId,
      formatVersion: row.format_version as 2 | 3,
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
    if (
      row.anchor_message_id === null ||
      row.anchor_run_id === null ||
      row.anchor_conversation_turn_id === null
    ) {
      throw new Error("Legacy Prompt Surface anchor has no provable scoped identity.");
    }
    const snapshot = createPromptSurfaceSnapshot({
      runId: row.run_id as RunId,
      epochId: createPromptSurfaceEpochId(row.epoch_id),
      ordinal: row.ordinal,
      anchor: {
        messageId: row.anchor_message_id as PromptSurfaceSnapshot["anchor"]["messageId"],
        runId: row.anchor_run_id as RunId,
        conversationTurnId:
          row.anchor_conversation_turn_id as PromptSurfaceSnapshot["anchor"]["conversationTurnId"],
        sequence: row.anchor_message_sequence,
      },
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

function decodeRecord(row: RecordRow): PromptSurfaceRecord {
  try {
    const updates: unknown = JSON.parse(row.updates_json);
    const record = createPromptSurfaceRecord({
      runId: row.run_id as RunId,
      epochId: createPromptSurfaceEpochId(row.epoch_id),
      ordinal: row.ordinal,
      anchor: {
        messageId: row.anchor_message_id as PromptSurfaceRecord["anchor"]["messageId"],
        runId: row.anchor_run_id as RunId,
        conversationTurnId:
          row.anchor_conversation_turn_id as PromptSurfaceRecord["anchor"]["conversationTurnId"],
        sequence: row.anchor_message_sequence,
      },
      sourceStepSequence: row.source_step_sequence,
      kind: row.kind as PromptSurfaceRecord["kind"],
      updates: updates as PromptSurfaceRecord["updates"],
      decisionFingerprint: row.decision_fingerprint,
      createdAt: row.created_at_ms as TimestampMs,
    });
    if (record.contentHash !== row.content_hash || record.byteLength !== row.byte_length) {
      throw new Error("Prompt Surface V3 record integrity metadata does not match.");
    }
    assertPromptSurfaceRecord(record);
    return record;
  } catch (error) {
    throw new StorageDecodeError(
      "PromptSurfaceRecord",
      `${row.run_id}:${row.epoch_id}:${String(row.ordinal)}`,
      "prompt_surface_records",
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
    left.createdAt === right.createdAt &&
    left.formatVersion === right.formatVersion
  );
}

function sameSnapshot(left: PromptSurfaceSnapshot, right: PromptSurfaceSnapshot): boolean {
  return (
    left.runId === right.runId &&
    left.epochId === right.epochId &&
    left.ordinal === right.ordinal &&
    left.anchor.messageId === right.anchor.messageId &&
    left.anchor.runId === right.anchor.runId &&
    left.anchor.conversationTurnId === right.anchor.conversationTurnId &&
    left.anchor.sequence === right.anchor.sequence &&
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
