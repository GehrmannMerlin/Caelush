import {
  AgentMessageCodecError,
  type AgentMessageCodecRegistry,
  type AgentMessageRecord,
  type AgentMessageTranscriptProjectorRegistry,
  type SessionReadableAgentMessageRecordStore,
} from "@caelush/agent";
import {
  SessionTranscriptQuerySchema,
  type AgentRun,
  type RunStatus,
  type SessionId,
  type SessionTranscriptQuery,
  type SessionTranscriptResponse,
} from "@caelush/protocol";
import type { RunRepository, SessionRepository } from "@caelush/storage";
import { StorageNotFoundError } from "@caelush/storage";
import { unsupportedHistoricalTranscriptEntry } from "@caelush/agent";

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
]);

export interface SessionTranscriptServiceOptions {
  readonly sessions: Pick<SessionRepository, "get">;
  readonly runs: Pick<RunRepository, "listBySession">;
  readonly messageRecords: SessionReadableAgentMessageRecordStore;
  readonly codecs: AgentMessageCodecRegistry;
  readonly transcriptProjectors: AgentMessageTranscriptProjectorRegistry;
}

/** Read-only server-side projection of durable AgentMessage records for a Session. */
export class SessionTranscriptService {
  constructor(private readonly options: SessionTranscriptServiceOptions) {}

  async getTranscript(
    sessionId: SessionId,
    input: SessionTranscriptQuery,
  ): Promise<SessionTranscriptResponse> {
    const query = SessionTranscriptQuerySchema.parse(input);
    const session = await this.options.sessions.get(sessionId);
    if (session === null) throw new StorageNotFoundError("AgentSession", sessionId);

    const [runs, records] = await Promise.all([
      this.options.runs.listBySession(sessionId),
      this.options.messageRecords.listBySession(sessionId),
    ]);
    const items = this.projectSession(runs, records);
    const start = parseCursor(query.cursor, items.length);
    const page = items.slice(start, start + query.limit);
    const end = start + page.length;
    return {
      items: page,
      ...(end < items.length ? { nextCursor: String(end) } : {}),
    };
  }

  private projectSession(runs: readonly AgentRun[], records: readonly AgentMessageRecord[]) {
    const orderedRuns = [...runs].sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
    const recordsByRun = new Map<string, typeof records>();
    for (const record of records) {
      const existing = recordsByRun.get(record.runId);
      if (existing === undefined) recordsByRun.set(record.runId, [record]);
      else recordsByRun.set(record.runId, [...existing, record]);
    }

    const items = [] as SessionTranscriptResponse["items"][number][];
    for (const run of orderedRuns) {
      const runRecords = [...(recordsByRun.get(run.id) ?? [])].sort(
        (left, right) =>
          left.sequence - right.sequence || left.messageId.localeCompare(right.messageId),
      );
      const runItems = runRecords.flatMap((record) => this.projectRecord(record));
      items.push(...runItems);
      if (
        TERMINAL_RUN_STATUSES.has(run.status) &&
        (run.status !== "COMPLETED" || !runItems.some((item) => item.kind === "ASSISTANT"))
      ) {
        items.push(terminalEntry(run));
      }
    }
    return items;
  }

  private projectRecord(record: AgentMessageRecord) {
    if (!record.audience.transcript) return [];
    try {
      const message = this.options.codecs.decode(record);
      return this.options.transcriptProjectors.project({
        sequence: record.sequence,
        schemaVersion: record.schemaVersion,
        ...(record.modelProjectionVersion === undefined
          ? {}
          : { modelProjectionVersion: record.modelProjectionVersion }),
        message,
      });
    } catch (error) {
      // Unknown historical schema/type is a user-visible gap, never a reason to expose data or
      // fail the whole Session. Keep the typed codec refusal local and return only a fixed label.
      if (error instanceof AgentMessageCodecError || error instanceof Error) {
        return [
          unsupportedHistoricalTranscriptEntry({
            id: record.messageId,
            runId: record.runId,
            conversationTurnId: record.conversationTurnId,
            createdAt: record.createdAt,
          }),
        ];
      }
      return [];
    }
  }
}

function parseCursor(cursor: string | undefined, itemCount: number): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new TypeError("Transcript cursor is invalid.");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0 || value > itemCount) {
    throw new TypeError("Transcript cursor is invalid.");
  }
  return value;
}

function terminalEntry(run: AgentRun) {
  return {
    id: `${run.id}:transcript:terminal`,
    runId: run.id,
    conversationTurnId: `${run.id}:terminal`,
    createdAt: run.finishedAt ?? run.createdAt,
    kind: "RUN_TERMINAL" as const,
    status: run.status,
    text:
      run.status === "COMPLETED"
        ? "Run completed without a verified final result."
        : `Run ended with status ${run.status}.`,
  };
}
