import { LLMMessageSchema, type LLMMessage } from "@caelush/llm/messages";
import type { RunId, StepId, TimestampMs } from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
} from "../errors.js";

interface ConversationRow {
  run_id: string;
  sequence: number;
  role: string;
  source_step_id: string | null;
  protocol_version: number;
  created_at_ms: number;
  data_json: string;
}

export interface RunConversationEntry {
  readonly runId: RunId;
  readonly sequence: number;
  readonly sourceStepId?: StepId;
  readonly createdAt: TimestampMs;
  readonly message: LLMMessage;
}

export interface ConversationAppendInput {
  readonly sourceStepId?: StepId;
  readonly createdAt: TimestampMs;
  readonly message: LLMMessage;
}

function assertDurableMessage(message: LLMMessage): void {
  if (message.role === "system") {
    throw new StorageDecodeError("LLMMessage", "system", "agent_messages");
  }
}

function decodeConversationEntry(row: ConversationRow): RunConversationEntry {
  const message = decodeProtocol(LLMMessageSchema, row.data_json, {
    entityType: "LLMMessage",
    entityId: `${row.run_id}:${row.sequence}`,
    table: "agent_messages",
  });
  assertDurableMessage(message);
  if (
    row.protocol_version !== 1 ||
    message.role !== row.role ||
    (row.source_step_id === null ? undefined : row.source_step_id) === ""
  ) {
    throw new StorageDecodeError("RunConversationEntry", `${row.run_id}:${row.sequence}`, "agent_messages");
  }
  return {
    runId: row.run_id as RunId,
    sequence: row.sequence,
    ...(row.source_step_id === null ? {} : { sourceStepId: row.source_step_id as StepId }),
    createdAt: row.created_at_ms as TimestampMs,
    message,
  };
}

function mapWriteError(error: unknown, runId: RunId): never {
  if (error instanceof StorageError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new StorageConflictError(`Unable to append conversation for Run ${runId}`, { cause: error });
  }
  throw new StorageError(`Unable to append conversation for Run ${runId}`, { cause: error });
}

export function appendConversationMessagesInTransaction(
  client: CaelushDatabase["client"],
  runId: RunId,
  entries: readonly ConversationAppendInput[],
): RunConversationEntry[] {
  if (entries.length === 0) return [];
  const lastRow = client
    .prepare("SELECT sequence FROM agent_messages WHERE run_id = ? ORDER BY sequence DESC LIMIT 1")
    .get(runId) as { sequence: number } | undefined;
  const firstSequence = (lastRow?.sequence ?? 0) + 1;
  const insert = client.prepare(
    `INSERT INTO agent_messages
      (run_id, sequence, role, source_step_id, protocol_version, created_at_ms, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  return entries.map((entry, offset) => {
    assertDurableMessage(entry.message);
    const dataJson = encodeProtocol(LLMMessageSchema, entry.message, {
      entityType: "LLMMessage",
      entityId: `${runId}:${firstSequence + offset}`,
      table: "agent_messages",
    });
    insert.run(
      runId,
      firstSequence + offset,
      entry.message.role,
      entry.sourceStepId ?? null,
      1,
      entry.createdAt,
      dataJson,
    );
    return {
      runId,
      sequence: firstSequence + offset,
      ...(entry.sourceStepId === undefined ? {} : { sourceStepId: entry.sourceStepId }),
      createdAt: entry.createdAt,
      message: entry.message,
    };
  });
}

export interface ConversationRepository {
  append(runId: RunId, entries: readonly ConversationAppendInput[]): Promise<RunConversationEntry[]>;
  listByRun(runId: RunId): Promise<RunConversationEntry[]>;
}

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async append(runId: RunId, entries: readonly ConversationAppendInput[]): Promise<RunConversationEntry[]> {
    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const result = appendConversationMessagesInTransaction(client, runId, entries);
      client.exec("COMMIT");
      return result;
    } catch (error) {
      client.exec("ROLLBACK");
      mapWriteError(error, runId);
    }
  }

  async listByRun(runId: RunId): Promise<RunConversationEntry[]> {
    const rows = this.database.client
      .prepare(
        `SELECT run_id, sequence, role, source_step_id, protocol_version, created_at_ms, data_json
         FROM agent_messages WHERE run_id = ? ORDER BY sequence ASC`,
      )
      .all(runId);
    return (rows as unknown as ConversationRow[]).map(decodeConversationEntry);
  }
}
