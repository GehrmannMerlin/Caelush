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

/** Legacy markers are read only until the current daemon acknowledges their migration. */
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

  acknowledge(sessionIds: readonly SessionId[]): void {
    const confirmed = new Set(sessionIds);
    try {
      const raw: unknown = JSON.parse(this.storage.getItem(ARCHIVED_SESSIONS_KEY) ?? "[]");
      if (!Array.isArray(raw)) return;
      this.storage.setItem(
        ARCHIVED_SESSIONS_KEY,
        JSON.stringify(
          raw.filter(
            (value: unknown) =>
              !(
                typeof value === "object" &&
                value !== null &&
                "sessionId" in value &&
                confirmed.has(value.sessionId as SessionId)
              ),
          ),
        ),
      );
    } catch {
      /* Unavailable or damaged legacy storage remains eligible for a later retry. */
    }
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
