import { SessionIdSchema, type SessionId, type WorkspaceId } from "@caelush/protocol";

export interface SessionSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StorageLike = SessionSelectionStorage | Map<string, string>;

export class SessionSelectionStore {
  private readonly candidates = new Map<string, ReadonlySet<SessionId>>();

  constructor(private readonly storage: StorageLike = browserStorage()) {}

  setCandidates(workspaceId: WorkspaceId, sessionIds: readonly SessionId[]): void {
    this.candidates.set(workspaceId, new Set(sessionIds));
    const selected = this.read(workspaceId);
    if (selected === undefined) this.clear(workspaceId);
  }

  read(workspaceId: WorkspaceId): SessionId | undefined {
    const raw = get(this.storage, key(workspaceId));
    if (raw === null) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.clear(workspaceId);
      return undefined;
    }
    const parsed = SessionIdSchema.safeParse(value);
    if (!parsed.success || !this.candidates.get(workspaceId)?.has(parsed.data)) {
      this.clear(workspaceId);
      return undefined;
    }
    return parsed.data;
  }

  write(workspaceId: WorkspaceId, sessionId: SessionId): void {
    const parsed = SessionIdSchema.safeParse(sessionId);
    if (!parsed.success || !this.candidates.get(workspaceId)?.has(parsed.data)) {
      this.clear(workspaceId);
      return;
    }
    set(this.storage, key(workspaceId), JSON.stringify(parsed.data));
  }

  clear(workspaceId: WorkspaceId): void {
    remove(this.storage, key(workspaceId));
  }
}

function key(workspaceId: WorkspaceId): string {
  return `caelush:selected-session:${workspaceId}`;
}

function browserStorage(): SessionSelectionStorage {
  if (typeof localStorage !== "undefined") return localStorage;
  const values = new Map<string, string>();
  return {
    getItem: (item) => values.get(item) ?? null,
    setItem: (item, value) => void values.set(item, value),
    removeItem: (item) => void values.delete(item),
  };
}

function get(storage: StorageLike, item: string): string | null {
  return storage instanceof Map ? (storage.get(item) ?? null) : storage.getItem(item);
}

function set(storage: StorageLike, item: string, value: string): void {
  if (storage instanceof Map) storage.set(item, value);
  else storage.setItem(item, value);
}

function remove(storage: StorageLike, item: string): void {
  if (storage instanceof Map) storage.delete(item);
  else storage.removeItem(item);
}
