import { AgentEventSchema, type RunId } from "@caelush/protocol";
import type {
  DurableRunEvent,
  DurableRunEventDraft,
  DurableRunEventReaderPort,
} from "@caelush/agent";
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
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("afterSequence must be a non-negative integer");
  }
  return value;
}

function validateThroughSequence(sequence: number | undefined): number | undefined {
  if (sequence === undefined) return undefined;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("throughSequence must be a non-negative safe integer");
  }
  return sequence;
}

function decodeEvent(row: EventRow): DurableRunEvent {
  const event = decodeProtocol(AgentEventSchema, row.data_json, {
    entityType: "AgentEvent",
    entityId: row.event_id,
    table: "agent_events",
  });

  if (event.durability.kind !== "DURABLE") {
    throw new StorageDecodeError("AgentEvent", row.event_id, "agent_events");
  }
  const durable = event as unknown as DurableRunEvent;
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

export function appendDurableEventsInTransaction(
  client: CaelushDatabase["client"],
  drafts: readonly DurableRunEventDraft[],
): DurableRunEvent[] {
  return drafts.map((draft) => {
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
    const durable = event as unknown as DurableRunEvent;
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
    return durable;
  });
}

export class SqliteDurableEventStore implements DurableRunEventReaderPort {
  constructor(private readonly database: CaelushDatabase) {}

  async replay(
    runId: RunId,
    options: { afterSequence?: number; throughSequence?: number; limit?: number } = {},
  ): Promise<DurableRunEvent[]> {
    const afterSequence = validateAfterSequence(options.afterSequence);
    const throughSequence = validateThroughSequence(options.throughSequence);
    const limit = validateLimit(options.limit);
    if (throughSequence !== undefined && throughSequence < afterSequence) return [];
    const upperBound = throughSequence === undefined ? "" : " AND aggregate_sequence <= ?";
    const parameters =
      throughSequence === undefined
        ? [runId, afterSequence, limit]
        : [runId, afterSequence, throughSequence, limit];
    const rows = this.database.client
      .prepare(
        `SELECT event_id, run_id, session_id, step_id, aggregate_sequence, event_type,
                event_schema_version, visibility, timestamp_ms, data_json
         FROM agent_events
         WHERE run_id = ? AND aggregate_sequence > ?
         ${upperBound}
         ORDER BY aggregate_sequence ASC LIMIT ?`,
      )
      .all(...parameters);
    return (rows as unknown as EventRow[]).map(decodeEvent);
  }

  async latestSequence(runId: RunId): Promise<number> {
    const row = this.database.client
      .prepare("SELECT last_sequence FROM event_sequences WHERE run_id = ?")
      .get(runId) as { last_sequence: number } | undefined;
    return row?.last_sequence ?? 0;
  }
}
