import { AgentSessionSchema, type AgentSession, type SessionId } from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { decodeProtocol, encodeProtocol } from "../codec.js";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "../errors.js";

interface SessionRow {
  id: string;
  protocol_version: number;
  created_at_ms: number;
  updated_at_ms: number;
  data_json: string;
}

export interface SessionListOptions {
  readonly limit?: number;
}

export interface SessionRepository {
  insert(session: AgentSession): Promise<void>;
  get(id: SessionId): Promise<AgentSession | null>;
  update(session: AgentSession): Promise<void>;
  list(options?: SessionListOptions): Promise<AgentSession[]>;
}

function decodeSession(row: SessionRow): AgentSession {
  const session = decodeProtocol(AgentSessionSchema, row.data_json, {
    entityType: "AgentSession",
    entityId: row.id,
    table: "agent_sessions",
  });

  if (
    session.id !== row.id ||
    session.createdAt !== row.created_at_ms ||
    session.updatedAt !== row.updated_at_ms ||
    row.protocol_version !== 1
  ) {
    throw new StorageDecodeError("AgentSession", row.id, "agent_sessions");
  }

  return session;
}

function mapRepositoryError(error: unknown, action: string, id: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new StorageConflictError(`Unable to ${action} AgentSession ${id}`, { cause: error });
  }
  if (error instanceof StorageError) throw error;
  throw new StorageError(`Unable to ${action} AgentSession ${id}`, { cause: error });
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async insert(session: AgentSession): Promise<void> {
    const dataJson = encodeProtocol(AgentSessionSchema, session, {
      entityType: "AgentSession",
      entityId: session.id,
      table: "agent_sessions",
    });

    try {
      this.database.client
        .prepare(
          `INSERT INTO agent_sessions
            (id, protocol_version, created_at_ms, updated_at_ms, data_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(session.id, 1, session.createdAt, session.updatedAt, dataJson);
    } catch (error) {
      mapRepositoryError(error, "insert", session.id);
    }
  }

  async get(id: SessionId): Promise<AgentSession | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, protocol_version, created_at_ms, updated_at_ms, data_json
         FROM agent_sessions WHERE id = ?`,
      )
      .get(id) as SessionRow | undefined;

    return row ? decodeSession(row) : null;
  }

  async update(session: AgentSession): Promise<void> {
    const dataJson = encodeProtocol(AgentSessionSchema, session, {
      entityType: "AgentSession",
      entityId: session.id,
      table: "agent_sessions",
    });
    const result = this.database.client
      .prepare(
        `UPDATE agent_sessions
         SET protocol_version = ?, created_at_ms = ?, updated_at_ms = ?, data_json = ?
         WHERE id = ?`,
      )
      .run(1, session.createdAt, session.updatedAt, dataJson, session.id);

    if (result.changes === 0) {
      throw new StorageNotFoundError("AgentSession", session.id);
    }
  }

  async list(options: SessionListOptions = {}): Promise<AgentSession[]> {
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.floor(options.limit));
    const rows =
      limit === undefined
        ? this.database.client
            .prepare(
              `SELECT id, protocol_version, created_at_ms, updated_at_ms, data_json
           FROM agent_sessions ORDER BY updated_at_ms DESC, id ASC`,
            )
            .all()
        : this.database.client
            .prepare(
              `SELECT id, protocol_version, created_at_ms, updated_at_ms, data_json
           FROM agent_sessions ORDER BY updated_at_ms DESC, id ASC LIMIT ?`,
            )
            .all(limit);

    return (rows as unknown as SessionRow[]).map(decodeSession);
  }
}
