import {
  WorkspaceRecordSchema,
  type WorkspaceId,
  type WorkspaceRecord,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "../errors.js";

interface WorkspaceRow {
  id: string;
  canonical_path: string;
  display_name: string;
  created_at_ms: number;
  updated_at_ms: number;
  last_opened_at_ms: number;
}

export interface WorkspaceRepository {
  insert(workspace: WorkspaceRecord): Promise<void>;
  getById(id: WorkspaceId): Promise<WorkspaceRecord | null>;
  getByCanonicalPath(canonicalPath: string): Promise<WorkspaceRecord | null>;
  list(limit?: number): Promise<WorkspaceRecord[]>;
  touch(id: WorkspaceId, timestamp: number): Promise<WorkspaceRecord>;
  remove(id: WorkspaceId): Promise<void>;
}

function decodeWorkspace(row: WorkspaceRow): WorkspaceRecord {
  try {
    return WorkspaceRecordSchema.parse({
      id: row.id,
      canonicalPath: row.canonical_path,
      displayName: row.display_name,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
      lastOpenedAt: row.last_opened_at_ms,
    });
  } catch (error) {
    throw new StorageDecodeError("Workspace", row.id, "workspaces", { cause: error });
  }
}

function mapRepositoryError(error: unknown, action: string, id: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) {
    throw new StorageConflictError(`Unable to ${action} Workspace ${id}`, { cause: error });
  }
  if (error instanceof StorageError) throw error;
  throw new StorageError(`Unable to ${action} Workspace ${id}`, { cause: error });
}

export class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async insert(workspace: WorkspaceRecord): Promise<void> {
    const record = WorkspaceRecordSchema.parse(workspace);
    try {
      this.database.client
        .prepare(
          `INSERT INTO workspaces
            (id, canonical_path, display_name, created_at_ms, updated_at_ms, last_opened_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.canonicalPath,
          record.displayName,
          record.createdAt,
          record.updatedAt,
          record.lastOpenedAt,
        );
    } catch (error) {
      mapRepositoryError(error, "insert", record.id);
    }
  }

  async getById(id: WorkspaceId): Promise<WorkspaceRecord | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, canonical_path, display_name, created_at_ms, updated_at_ms, last_opened_at_ms
         FROM workspaces WHERE id = ?`,
      )
      .get(id) as WorkspaceRow | undefined;
    return row === undefined ? null : decodeWorkspace(row);
  }

  async getByCanonicalPath(canonicalPath: string): Promise<WorkspaceRecord | null> {
    const row = this.database.client
      .prepare(
        `SELECT id, canonical_path, display_name, created_at_ms, updated_at_ms, last_opened_at_ms
         FROM workspaces WHERE canonical_path = ?`,
      )
      .get(canonicalPath) as WorkspaceRow | undefined;
    return row === undefined ? null : decodeWorkspace(row);
  }

  async list(limit?: number): Promise<WorkspaceRecord[]> {
    const normalizedLimit = limit === undefined ? undefined : Math.max(0, Math.floor(limit));
    const rows =
      normalizedLimit === undefined
        ? this.database.client
            .prepare(
              `SELECT id, canonical_path, display_name, created_at_ms, updated_at_ms, last_opened_at_ms
               FROM workspaces ORDER BY last_opened_at_ms DESC, updated_at_ms DESC, id ASC`,
            )
            .all()
        : this.database.client
            .prepare(
              `SELECT id, canonical_path, display_name, created_at_ms, updated_at_ms, last_opened_at_ms
               FROM workspaces ORDER BY last_opened_at_ms DESC, updated_at_ms DESC, id ASC LIMIT ?`,
            )
            .all(normalizedLimit);
    return (rows as unknown as WorkspaceRow[]).map(decodeWorkspace);
  }

  async touch(id: WorkspaceId, timestamp: number): Promise<WorkspaceRecord> {
    const result = this.database.client
      .prepare(
        `UPDATE workspaces SET updated_at_ms = ?, last_opened_at_ms = ? WHERE id = ?`,
      )
      .run(timestamp, timestamp, id);
    if (result.changes === 0) throw new StorageNotFoundError("Workspace", id);
    const workspace = await this.getById(id);
    if (workspace === null) throw new StorageNotFoundError("Workspace", id);
    return workspace;
  }

  async remove(id: WorkspaceId): Promise<void> {
    const result = this.database.client.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
    if (result.changes === 0) throw new StorageNotFoundError("Workspace", id);
  }
}
