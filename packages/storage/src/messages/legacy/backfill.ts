import type { RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";

import type { CaelushDatabase } from "../../database.js";

/**
 * What the backfill needs from a database: one client, and nothing else.
 *
 * Narrowing the parameter to this is deliberate. A migration that asked for the whole `CaelushDatabase`
 * would couple itself to the storage facade, and the facade is exactly what the round is trying not to
 * widen: the V2 substrate is reached through {@link SqliteAgentMessageRecordStore}, and a data migration
 * that runs once reaches only the client it needs.
 */
export interface LegacyBackfillDatabase {
  readonly client: CaelushDatabase["client"];
}
import { StorageDecodeError } from "../../errors.js";
import type { LegacyMessageMigrationFailureReason } from "./legacy-llm-message-codec.js";
import {
  LegacyMessageMigrationError,
  LegacyMessageParseError,
} from "./legacy-llm-message-codec.js";
import { legacyRowToAgentMessageRecord } from "./legacy-llm-message-codec.js";
import type { LegacyMessageParser } from "../migration/legacy-types.js";

/**
 * The deterministic legacy-message backfill.
 *
 * ```text
 * Phase 5B   this module: the initial backfill of existing rows
 * Phase 5F   the final straggler sweep, the proof that no legacy row remains, and Stage C
 * ```
 *
 * ## One row at a time, and every one of them idempotent
 *
 * A row that already carries a V2 representation is skipped, so re-running the whole backfill changes
 * nothing. That is what makes a partial run safe: the migration can stop after any row and resume
 * exactly where it left off, because a row's identity and payload are derived from the row itself
 * rather than from how many rows were processed.
 *
 * ```text
 * messageId            deriveLegacyAgentMessageId(runId, sequence)       pure, clock-free
 * conversationTurnId   the deterministic turn factory over the RunId    pure, clock-free
 * payload              the legacy content, copied verbatim
 * fingerprint          a digest over that exact content
 * ```
 *
 * ## One row is one transaction
 *
 * A row is written inside its own `BEGIN IMMEDIATE`, so a crash mid-migration leaves whole rows rather
 * than half-filled V2 metadata. A row-level failure is recorded and the sweep continues: a single
 * unrepresentable row must not abort a migration, and it must not be silently skipped either.
 *
 * ## It never deletes and never rewrites the legacy source
 *
 * `role`, `protocol_version` and `data_json` are left exactly as they were during this historical
 * sweep. The final Phase 5F physical rebuild consumes the completed V2 columns only after the gate
 * proves that every row is representable.
 */

/** The structured result of one backfill run. */
export interface LegacyBackfillReport {
  readonly scanned: number;
  readonly alreadyMigrated: number;
  readonly migrated: number;
  readonly unsupported: number;
  readonly failed: number;
  /** Bounded, safe per-row reasons. Never a message body, a Tool result or a provider payload. */
  readonly reasons: readonly {
    readonly runId: string;
    readonly sequence: number;
    readonly messageType: string;
    readonly reason: string;
  }[];
}

/** A row the backfill must consider, without its payload. */
interface BackfillRow {
  run_id: string;
  sequence: number;
  role: string;
  source_step_id: string | null;
  created_at_ms: number;
  data_json: string;
  session_id: string | null;
  v2_data_json: string | null;
}

export interface LegacyBackfillOptions {
  /**
   * The legacy payload parser.
   *
   * Required, and injected rather than imported: parsing the pre-V2 language is the dependency this
   * package must not take a second time.
   */
  readonly parse: LegacyMessageParser;
  /** Restrict the sweep to one Run. Absent means every Run. */
  readonly runId?: RunId;
  /** Where a provable Tool observation comes from, when one exists. */
  readonly observationIdFor?: (input: {
    readonly runId: string;
    readonly sourceStepId: string | undefined;
    readonly toolCallId: string;
  }) => string | undefined;
  /** Called after each row is attempted, for incremental progress reporting. */
  readonly onRow?: (outcome: { readonly sequence: number; readonly outcome: string }) => void;
}

/**
 * Backfill every legacy row that has no V2 representation yet.
 *
 * ## Observation linkage
 *
 * For a `role = "tool"` row the migration must decide whether a real execution observation stands
 * behind the feedback. The rule is stated once and never approximated:
 *
 * ```text
 * exactly one provable Observation   OBSERVATION { observationId }
 * provably none                      NO_OBSERVATION
 * more than one possible             FAIL the row — ambiguous evidence is not evidence of absence
 * ```
 *
 * The observation is never inferred, never defaulted and never synthesised. A `NO_OBSERVATION` result
 * is a real historical fact: a rejected call, a skipped trailing call and a synthetic replan result all
 * reach the model as feedback with no execution behind them.
 *
 * ## The historical policy
 *
 * A legacy row never recorded the per-row projection policy — it lives on a Run continuation checkpoint
 * that has since been replaced — so every migrated Tool row carries `LEGACY_UNKNOWN` rather than
 * today's limits. Recording today's limits would assert that history matched present configuration.
 */
export function backfillLegacyAgentMessages(
  database: LegacyBackfillDatabase,
  options: LegacyBackfillOptions,
): LegacyBackfillReport {
  const client = database.client;
  const rows = (options.runId === undefined
    ? client
        .prepare(
          `SELECT run_id, sequence, role, source_step_id, created_at_ms, data_json, session_id, v2_data_json
             FROM agent_messages ORDER BY run_id ASC, sequence ASC`,
        )
        .all()
    : client
        .prepare(
          `SELECT run_id, sequence, role, source_step_id, created_at_ms, data_json, session_id, v2_data_json
             FROM agent_messages WHERE run_id = ? ORDER BY sequence ASC`,
        )
        .all(options.runId)) as unknown as BackfillRow[];

  let alreadyMigrated = 0;
  let migrated = 0;
  let unsupported = 0;
  let failed = 0;
  const reasons: { runId: string; sequence: number; messageType: string; reason: string }[] = [];

  for (const row of rows) {
    if (row.v2_data_json !== null) {
      alreadyMigrated += 1;
      options.onRow?.({ sequence: row.sequence, outcome: "already-migrated" });
      continue;
    }

    const sessionId = resolveSessionId(client, row.run_id);
    if (sessionId === undefined) {
      // The owning Run is gone. The row cannot be given a session, and inventing one would create a
      // message no session read could ever find.
      failed += 1;
      reasons.push({
        runId: row.run_id,
        sequence: row.sequence,
        messageType: row.role,
        reason: "RUN_NOT_FOUND",
      });
      options.onRow?.({ sequence: row.sequence, outcome: "failed" });
      continue;
    }

    let observationId: string | undefined;
    try {
      observationId = resolveObservationId(client, row, options);
    } catch (error) {
      if (error instanceof AmbiguousObservationError) {
        // Ambiguous evidence is refused rather than downgraded to NO_OBSERVATION: the two are
        // different statements and only one of them is true here.
        failed += 1;
        reasons.push({
          runId: row.run_id,
          sequence: row.sequence,
          messageType: row.role,
          reason: "AMBIGUOUS_OBSERVATION_LINKAGE",
        });
        options.onRow?.({ sequence: row.sequence, outcome: "failed" });
        continue;
      }
      throw error;
    }

    let record;
    try {
      record = legacyRowToAgentMessageRecord({
        runId: row.run_id as RunId,
        sessionId,
        sequence: row.sequence,
        role: row.role,
        createdAt: row.created_at_ms as TimestampMs,
        ...(row.source_step_id === null ? {} : { sourceStepId: row.source_step_id as StepId }),
        message: options.parse(row.data_json),
        ...(observationId === undefined ? {} : { observationId }),
      });
    } catch (error) {
      if (
        error instanceof LegacyMessageMigrationError ||
        error instanceof LegacyMessageParseError
      ) {
        unsupported += 1;
        reasons.push({
          runId: row.run_id,
          sequence: row.sequence,
          messageType: row.role,
          reason: (error instanceof LegacyMessageMigrationError
            ? error.reason
            : "UNPARSEABLE_LEGACY_JSON") satisfies LegacyMessageMigrationFailureReason,
        });
        options.onRow?.({ sequence: row.sequence, outcome: "unsupported" });
        continue;
      }
      throw error;
    }

    // One row, one transaction: a crash leaves whole rows rather than half-filled V2 metadata.
    client.exec("BEGIN IMMEDIATE");
    try {
      client
        .prepare(
          `UPDATE agent_messages SET
             message_id = ?, session_id = ?, conversation_turn_id = ?, message_type = ?,
             schema_version = ?, model_projection_version = ?, source_json = ?, audience_json = ?,
             v2_data_json = ?
           WHERE run_id = ? AND sequence = ? AND v2_data_json IS NULL`,
        )
        .run(
          record.messageId,
          record.sessionId,
          record.conversationTurnId,
          record.messageType,
          record.schemaVersion,
          record.modelProjectionVersion ?? null,
          JSON.stringify(record.source),
          JSON.stringify(record.audience),
          JSON.stringify(record.data),
          row.run_id,
          row.sequence,
        );
      client.exec("COMMIT");
      migrated += 1;
      options.onRow?.({ sequence: row.sequence, outcome: "migrated" });
    } catch {
      client.exec("ROLLBACK");
      failed += 1;
      reasons.push({
        runId: row.run_id,
        sequence: row.sequence,
        messageType: row.role,
        reason: "WRITE_FAILED",
      });
      options.onRow?.({ sequence: row.sequence, outcome: "failed" });
    }
  }

  return Object.freeze({
    scanned: rows.length,
    alreadyMigrated,
    migrated,
    unsupported,
    failed,
    reasons: Object.freeze(reasons.map((reason) => Object.freeze(reason))),
  });
}

/** The Session one Run belongs to, or `undefined` when the Run is gone. */
function resolveSessionId(client: CaelushDatabase["client"], runId: string): SessionId | undefined {
  const run = client.prepare("SELECT session_id FROM agent_runs WHERE id = ?").get(runId) as
    { session_id: string } | undefined;
  return run === undefined ? undefined : (run.session_id as SessionId);
}

/** Raised when a Tool row's observation linkage is genuinely ambiguous. */
class AmbiguousObservationError extends Error {
  constructor() {
    super("A legacy Tool row has more than one possible observation.");
    this.name = "AmbiguousObservationError";
  }
}

/**
 * Resolve the observation a legacy Tool row provably produced.
 *
 * ```text
 * agent_messages.source_step_id  +  the legacy toolCallId
 *        ↓
 * tool_invocations WHERE run_id AND step_id AND external_call_id
 *        ↓
 * agent_observations WHERE tool_invocation_id
 * ```
 *
 * The join key is real: the Tool Layer records `external_call_id` as the model's own `toolCallId`, and
 * both tables carry a unique index on the path, so "exactly one" is provable rather than assumed.
 *
 * Returns `undefined` when no observation exists — which is a legitimate historical fact — and throws
 * when more than one is possible, because a caller that cannot tell must not be told "none".
 */
function resolveObservationId(
  client: CaelushDatabase["client"],
  row: BackfillRow,
  options: LegacyBackfillOptions,
): string | undefined {
  if (row.role !== "tool") return undefined;

  let toolCallId: string;
  try {
    const parsed = JSON.parse(row.data_json) as { toolCallId?: unknown };
    toolCallId = typeof parsed.toolCallId === "string" ? parsed.toolCallId : "";
  } catch {
    // An unparseable payload is reported by the converter, not here.
    return undefined;
  }
  if (toolCallId === "") return undefined;

  if (options.observationIdFor !== undefined) {
    return options.observationIdFor({
      runId: row.run_id,
      sourceStepId: row.source_step_id ?? undefined,
      toolCallId,
    });
  }

  // The step pointer is the linkage. Without it the invocation cannot be identified, and a lookup that
  // ignored the step could match a call from a different turn of the same Run.
  if (row.source_step_id === null) return undefined;

  const candidates = client
    .prepare(
      `SELECT o.id AS observation_id
       FROM tool_invocations i
       JOIN agent_observations o ON o.tool_invocation_id = i.id
       WHERE i.run_id = ? AND i.step_id = ? AND i.external_call_id = ?`,
    )
    .all(row.run_id, row.source_step_id, toolCallId) as Array<{ observation_id: string }>;

  if (candidates.length > 1) throw new AmbiguousObservationError();
  return candidates[0]?.observation_id;
}

/** Re-exported so a caller can name the row-level ambiguity without reaching into the internals. */
export { AmbiguousObservationError };

/** Decode a V2 record's stored payload, for a caller that already holds a row. */
export function decodeStoredV2Payload(value: string | null): unknown {
  if (value === null)
    throw new StorageDecodeError("AgentMessageRecord", "unknown", "agent_messages");
  try {
    return JSON.parse(value);
  } catch {
    throw new StorageDecodeError("AgentMessageRecord", "unknown", "agent_messages");
  }
}
