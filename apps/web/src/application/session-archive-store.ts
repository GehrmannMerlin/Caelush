import { SessionIdSchema, type SessionId } from "@caelush/protocol";

const ARCHIVED_SESSIONS_KEY = "caelush:archived-sessions";

export interface ArchivedSessionRecord {
  readonly sessionId: SessionId;
  readonly archivedAt: number;
}

interface ArchiveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Stores sidebar archive markers only; session and run data remain daemon-owned and untouched. */
export class SessionArchiveStore {
  constructor(private readonly storage: ArchiveStorage = browserStorage()) {}

  list(): readonly ArchivedSessionRecord[] {
    let raw: string | null;
    try {
      raw = this.storage.getItem(ARCHIVED_SESSIONS_KEY);
    } catch {
      return [];
    }
    if (raw === null) return [];

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(value)) return [];

    const records = value.flatMap((candidate: unknown): ArchivedSessionRecord[] => {
      if (typeof candidate !== "object" || candidate === null) return [];
      const record = candidate as Record<string, unknown>;
      const sessionId = SessionIdSchema.safeParse(record.sessionId);
      if (
        !sessionId.success ||
        typeof record.archivedAt !== "number" ||
        !Number.isSafeInteger(record.archivedAt) ||
        record.archivedAt < 0
      ) {
        return [];
      }
      return [{ sessionId: sessionId.data, archivedAt: record.archivedAt }];
    });

    return [...new Map(records.map((record) => [record.sessionId, record])).values()].sort(
      (left, right) => right.archivedAt - left.archivedAt,
    );
  }

  archive(sessionId: SessionId, archivedAt = Date.now()): readonly ArchivedSessionRecord[] {
    const parsedSessionId = SessionIdSchema.parse(sessionId);
    const records = new Map(this.list().map((record) => [record.sessionId, record]));
    records.set(parsedSessionId, { sessionId: parsedSessionId, archivedAt });
    const next = [...records.values()].sort((left, right) => right.archivedAt - left.archivedAt);
    this.storage.setItem(ARCHIVED_SESSIONS_KEY, JSON.stringify(next));
    return next;
  }

  restore(sessionId: SessionId): readonly ArchivedSessionRecord[] {
    const next = this.list().filter((record) => record.sessionId !== sessionId);
    this.storage.setItem(ARCHIVED_SESSIONS_KEY, JSON.stringify(next));
    return next;
  }
}

export const sessionArchiveStore = new SessionArchiveStore();

function browserStorage(): ArchiveStorage {
  try {
    if (typeof window !== "undefined") return window.localStorage;
  } catch {
    // Fall through to an in-memory store when browser storage is unavailable.
  }
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
