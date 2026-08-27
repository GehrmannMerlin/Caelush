import { AgentEventSchema, type RunId } from "@caelush/protocol";
import type { DurableAgentEvent, DurableEventDraft, DurableEventStore } from "@caelush/events";
import { DuplicateEventError } from "@caelush/events";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import { StorageDecodeError, StorageError } from "../errors.js";

interface EventRow {
  event_id: string;
  run_id: string;
  session_id: string;
  step_id: string | null;
  aggregate_sequence: number;
  event_type: string;
  event_schema_version: number;
  visibility: string;
  timestamp_ms: number;
  data_json: string;
}

const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 1000;

function validateLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_REPLAY_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_REPLAY_LIMIT) {
    throw new RangeError(`replay limit must be an integer between 1 and ${MAX_REPLAY_LIMIT}`);
  }
  return value;
}

function validateAfterSequence(sequence: number | undefined): number {
  const value = sequence ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("afterSequence must be a non-negative integer");
  }
  return value;
}

function decodeEvent(row: EventRow): DurableAgentEvent {
  const event = decodeProtocol(AgentEventSchema, row.data_json, {
    entityType: "AgentEvent",
    entityId: row.event_id,
    table: "agent_events",
  });

  if (event.durability.kind !== "DURABLE") {
    throw new StorageDecodeError("AgentEvent", row.event_id, "agent_events");
  }
  const durable = event as unknown as DurableAgentEvent;
  if (
    durable.eventId !== row.event_id ||
    durable.runId !== row.run_id ||
    durable.sessionId !== row.session_id ||
    (durable.stepId ?? null) !== row.step_id ||
    durable.durability.sequence !== row.aggregate_sequence ||
    durable.type !== row.event_type ||
    durable.schemaVersion !== row.event_schema_version ||
    durable.visibility !== row.visibility ||
    durable.timestamp !== row.timestamp_ms
  ) {
    throw new StorageDecodeError("AgentEvent", row.event_id, "agent_events");
  }

  return durable;
}

function mapAppendError(error: unknown, eventId: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new DuplicateEventError(eventId, { cause: error });
  }
  if (error instanceof StorageError || error instanceof DuplicateEventError) throw error;
  throw new StorageError(`Unable to append AgentEvent ${eventId}`, { cause: error });
}

export class SqliteDurableEventStore implements DurableEventStore {
  constructor(private readonly database: CaelushDatabase) {}

  async append(draft: DurableEventDraft): Promise<DurableAgentEvent> {
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      client
        .prepare(
          `INSERT INTO event_sequences (run_id, last_sequence) VALUES (?, 0)
           ON CONFLICT(run_id) DO NOTHING`,
        )
        .run(draft.runId);
      client
        .prepare("UPDATE event_sequences SET last_sequence = last_sequence + 1 WHERE run_id = ?")
        .run(draft.runId);
      const sequenceRow = client
        .prepare("SELECT last_sequence FROM event_sequences WHERE run_id = ?")
        .get(draft.runId) as { last_sequence: number };
      const event = AgentEventSchema.parse({
        ...draft,
        durability: { ...draft.durability, sequence: sequenceRow.last_sequence },
      });
      if (event.durability.kind !== "DURABLE") {
        throw new StorageDecodeError("AgentEvent", draft.eventId, "agent_events");
      }
      const durable = event as unknown as DurableAgentEvent;
      const dataJson = encodeProtocol(AgentEventSchema, durable, {
        entityType: "AgentEvent",
        entityId: durable.eventId,
        table: "agent_events",
      });

      client
        .prepare(
          `INSERT INTO agent_events
            (event_id, run_id, session_id, step_id, aggregate_sequence, event_type,
             event_schema_version, visibility, timestamp_ms, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          durable.eventId,
          durable.runId,
          durable.sessionId,
          durable.stepId ?? null,
          durable.durability.sequence,
          durable.type,
          durable.schemaVersion,
          durable.visibility,
          durable.timestamp,
          dataJson,
        );
      client.exec("COMMIT");
      return durable;
    } catch (error) {
      client.exec("ROLLBACK");
      mapAppendError(error, draft.eventId);
    }
  }

  async replay(
    runId: RunId,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<DurableAgentEvent[]> {
    const afterSequence = validateAfterSequence(options.afterSequence);
    const limit = validateLimit(options.limit);
    const rows = this.database.client
      .prepare(
        `SELECT event_id, run_id, session_id, step_id, aggregate_sequence, event_type,
                event_schema_version, visibility, timestamp_ms, data_json
         FROM agent_events
         WHERE run_id = ? AND aggregate_sequence > ?
         ORDER BY aggregate_sequence ASC LIMIT ?`,
      )
      .all(runId, afterSequence, limit);
    return (rows as unknown as EventRow[]).map(decodeEvent);
  }

  async latestSequence(runId: RunId): Promise<number> {
    const row = this.database.client
      .prepare("SELECT last_sequence FROM event_sequences WHERE run_id = ?")
      .get(runId) as { last_sequence: number } | undefined;
    return row?.last_sequence ?? 0;
  }
}
