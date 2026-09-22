import type { RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";
import type { AgentMessageRecord } from "@caelush/agent";

import type { CaelushDatabase } from "../../database.js";
import { StorageConflictError, StorageDecodeError } from "../../errors.js";
import {
  legacyRowToAgentMessageRecord,
  LegacyMessageMigrationError,
} from "./legacy-llm-message-codec.js";
import type {
  LegacyMessageMigrationFailureReason,
  LegacyParsedMessage,
} from "./legacy-llm-message-codec.js";

/**
 * Parse a legacy row payload.
 *
 * Injected, never imported: parsing the legacy language belongs to whoever composes the migration, and
 * `@caelush/storage` must not take a second dependency on the retiring `@caelush/llm` package.
 */
export type LegacyMessageParser = (rawDataJson: string) => LegacyParsedMessage;

/**
 * Legacy/V2 dual read.
 *
 * ```text
 * agent_messages row   →  a V2 record, whether the row is V2-backed or legacy-only
 * ```
 *
 * ## V2 first, and never both
 *
 * A row is legacy-only (`v2_data_json IS NULL`) or V2-backed (`v2_data_json IS NOT NULL`). When a row is
 * V2-backed, the V2 record **is** the canonical representation of that position and the legacy payload
 * is not consulted: returning both would present one message twice, and preferring the legacy encoding
 * would silently discard the migration.
 *
 * ## Conflict fails closed
 *
 * The reconciliation position is `(runId, sequence)` — the store's own ordering, which both encodings
 * share because they are the same physical row. A V2-backed row whose recorded type disagrees with its
 * legacy role is refused rather than resolved. Picking whichever was read first is how a ledger ends up
 * with two irreconcilable accounts of one message.
 *
 * ## Reads do not write
 *
 * A legacy-only row is converted **in memory** on every read. Nothing here persists: an ordinary
 * transcript or context load must not silently become a migration, and a page fetch must not mutate the
 * database. Persisting is an explicit backfill.
 */

/** One legacy row, as SQLite returns it. */
export interface LegacyAndV2MessageRow {
  run_id: string;
  sequence: number;
  role: string;
  source_step_id: string | null;
  created_at_ms: number;
  data_json: string;
  message_id: string | null;
  session_id: string | null;
  conversation_turn_id: string | null;
  message_type: string | null;
  schema_version: number | null;
  model_projection_version: number | null;
  source_json: string | null;
  audience_json: string | null;
  v2_data_json: string | null;
}

/** The result of reading one row through the compatibility layer. */
export type DualReadOutcome =
  | { readonly kind: "V2"; readonly record: AgentMessageRecord }
  | { readonly kind: "LEGACY"; readonly record: AgentMessageRecord }
  | {
      readonly kind: "UNSUPPORTED";
      readonly sequence: number;
      readonly reason: LegacyMessageMigrationFailureReason;
    };

/**
 * Read one row as a V2 record.
 *
 * A legacy-only row needs two facts the row itself does not carry, and both are supplied by the caller
 * rather than guessed here:
 *
 * ```text
 * sessionId       resolved from the owning Run
 * observationId   the observation the legacy Tool call provably produced, when exactly one is
 * ```
 */
export function readRowAsRecord(
  row: LegacyAndV2MessageRow,
  context: {
    readonly sessionId: SessionId;
    readonly parse: LegacyMessageParser;
    readonly observationId?: string;
  },
): DualReadOutcome {
  if (row.v2_data_json !== null) {
    const record = decodeV2Row(row);
    assertRoleMatchesType(row.role, record.messageType, row.run_id, row.sequence);
    return { kind: "V2", record };
  }

  try {
    const record = legacyRowToAgentMessageRecord({
      runId: row.run_id as RunId,
      sessionId: context.sessionId,
      sequence: row.sequence,
      role: row.role,
      createdAt: row.created_at_ms as TimestampMs,
      ...(row.source_step_id === null ? {} : { sourceStepId: row.source_step_id as StepId }),
      message: context.parse(row.data_json),
      ...(context.observationId === undefined ? {} : { observationId: context.observationId }),
    });
    return { kind: "LEGACY", record };
  } catch (error) {
    if (error instanceof LegacyMessageMigrationError) {
      // A row this build cannot represent is *reported*, never deleted and never rewritten. The caller
      // decides what to do with it; the compatibility layer's job is to be honest about it.
      return { kind: "UNSUPPORTED", sequence: row.sequence, reason: error.reason };
    }
    throw error;
  }
}

function decodeV2Row(row: LegacyAndV2MessageRow): AgentMessageRecord {
  const identity = `${row.run_id}:${String(row.sequence)}`;
  if (
    row.message_id === null ||
    row.session_id === null ||
    row.conversation_turn_id === null ||
    row.message_type === null ||
    row.schema_version === null ||
    row.source_json === null ||
    row.audience_json === null
  ) {
    throw new StorageDecodeError("AgentMessageRecord", identity, "agent_messages");
  }
  return {
    messageId: row.message_id as AgentMessageRecord["messageId"],
    runId: row.run_id as RunId,
    sessionId: row.session_id as SessionId,
    sequence: row.sequence,
    conversationTurnId: row.conversation_turn_id as AgentMessageRecord["conversationTurnId"],
    messageType: row.message_type,
    schemaVersion: row.schema_version,
    ...(row.model_projection_version === null
      ? {}
      : { modelProjectionVersion: row.model_projection_version }),
    ...(row.source_step_id === null ? {} : { sourceStepId: row.source_step_id as StepId }),
    createdAt: row.created_at_ms as TimestampMs,
    source: JSON.parse(row.source_json) as AgentMessageRecord["source"],
    audience: JSON.parse(row.audience_json) as AgentMessageRecord["audience"],
    data: JSON.parse(row.v2_data_json ?? "{}") as AgentMessageRecord["data"],
  };
}

/**
 * Refuse a row whose V2 type and legacy role disagree.
 *
 * ```text
 * legacy role  user | assistant | tool
 * V2 type      USER | ASSISTANT | TOOL_RESULT | a product-layer type
 * ```
 *
 * For the three canonical kinds the mapping is fixed and checked. A product-layer type has no legacy
 * role, and is exempt: the legacy language simply cannot express it, which is why its row is V2-backed
 * in the first place.
 */
function assertRoleMatchesType(
  legacyRole: string,
  messageType: string,
  runId: string,
  sequence: number,
): void {
  const expected =
    messageType === "USER"
      ? "user"
      : messageType === "ASSISTANT"
        ? "assistant"
        : messageType === "TOOL_RESULT"
          ? "tool"
          : undefined;
  if (expected === undefined) return;
  if (legacyRole !== expected) {
    throw new StorageConflictError(
      `Agent message ${runId}:${String(sequence)} disagrees about its type between its legacy role and its V2 record`,
    );
  }
}

/**
 * Read every row of a Run through the dual reader.
 *
 * Returns the canonical record for each position, plus the positions this build could not represent.
 * The two lists are separate on purpose: an unsupported row is not a record, and folding it into the
 * result as a partial message would present a conversation the validator would then have to catch.
 */
export function readRowsForRun(
  database: CaelushDatabase,
  runId: RunId,
  context: {
    readonly sessionId: SessionId;
    readonly parse: LegacyMessageParser;
    readonly observationIdFor?: (toolCallId: string) => string | undefined;
  },
): {
  readonly records: readonly AgentMessageRecord[];
  readonly unsupported: readonly { readonly sequence: number; readonly reason: string }[];
} {
  const rows = database.client
    .prepare(
      `SELECT run_id, sequence, role, source_step_id, created_at_ms, data_json,
              message_id, session_id, conversation_turn_id, message_type, schema_version,
              model_projection_version, source_json, audience_json, v2_data_json
       FROM agent_messages WHERE run_id = ? ORDER BY sequence ASC`,
    )
    .all(runId) as unknown as LegacyAndV2MessageRow[];

  const records: AgentMessageRecord[] = [];
  const unsupported: { sequence: number; reason: string }[] = [];
  for (const row of rows) {
    const observationId =
      context.observationIdFor === undefined
        ? undefined
        : context.observationIdFor(legacyToolCallId(row));
    const outcome = readRowAsRecord(row, {
      sessionId: context.sessionId,
      parse: context.parse,
      ...(observationId === undefined ? {} : { observationId }),
    });
    if (outcome.kind === "UNSUPPORTED") {
      unsupported.push({ sequence: outcome.sequence, reason: outcome.reason });
      continue;
    }
    records.push(outcome.record);
  }
  return { records, unsupported };
}

/** The model `toolCallId` a legacy Tool row names, or `""` for any other role. */
function legacyToolCallId(row: LegacyAndV2MessageRow): string {
  if (row.role !== "tool") return "";
  try {
    const parsed = JSON.parse(row.data_json) as { toolCallId?: unknown };
    return typeof parsed.toolCallId === "string" ? parsed.toolCallId : "";
  } catch {
    return "";
  }
}
