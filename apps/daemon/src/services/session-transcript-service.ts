import {
  PRIVATE_REPLAY_REFERENCE_KIND,
  AgentMessageCodecError,
  type AgentMessageCodecRegistry,
  type AgentMessageRecord,
  type AgentMessageTranscriptProjectorRegistry,
  type SessionReadableAgentMessageRecordStore,
} from "@caelush/agent";
import { requiresReasoningReplayWithTools, type ModelCatalog } from "@caelush/ai";
import {
  SessionContinuityPreflightQuerySchema,
  SessionTranscriptQuerySchema,
  type AgentRun,
  type RunStatus,
  type SessionId,
  type SessionTranscriptQuery,
  type SessionTranscriptResponse,
  type SessionContinuityPreflightQuery,
  type SessionContinuityPreflightResponse,
  type TranscriptEntry,
} from "@caelush/protocol";
import type { RunRepository, SessionRepository } from "@caelush/storage";
import { StorageNotFoundError } from "@caelush/storage";
import { unsupportedHistoricalTranscriptEntry } from "@caelush/agent";
import { projectPublicAssistantText } from "./assistant-text-projection.js";

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
  readonly models?: Pick<ModelCatalog, "resolve">;
}

/** Read-only server-side projection of durable AgentMessage records for a Session. */
export class SessionTranscriptService {
  constructor(private readonly options: SessionTranscriptServiceOptions) {}

  async getContinuityPreflight(
    sessionId: SessionId,
    input: SessionContinuityPreflightQuery,
  ): Promise<SessionContinuityPreflightResponse> {
    const query = SessionContinuityPreflightQuerySchema.parse(input);
    const session = await this.options.sessions.get(sessionId);
    if (session === null) throw new StorageNotFoundError("AgentSession", sessionId);
    if (this.options.models === undefined) return { status: "UNKNOWN" };

    let model;
    try {
      model = this.options.models.resolve({ provider: query.provider, model: query.model });
      if (!requiresReasoningReplayWithTools(model)) {
        return { status: "NO_NATIVE_REPLAY_REQUIRED" };
      }
    } catch {
      return { status: "UNKNOWN" };
    }

    const records = await this.options.messageRecords.listBySession(sessionId);
    for (const record of records) {
      if (record.messageType !== "ASSISTANT" || !record.audience.model) continue;
      try {
        const message = this.options.codecs.decode(record);
        if (
          message.type !== "ASSISTANT" ||
          !hasCompatiblePrivateReplayReference(message, record, model.ref, model.api)
        ) {
          return { status: "POSSIBLE_INCOMPATIBILITY" };
        }
      } catch {
        return { status: "POSSIBLE_INCOMPATIBILITY" };
      }
    }
    return { status: "NO_OBVIOUS_GAP" };
  }

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
      const entries = this.options.transcriptProjectors.project({
        sequence: record.sequence,
        schemaVersion: record.schemaVersion,
        ...(record.modelProjectionVersion === undefined
          ? {}
          : { modelProjectionVersion: record.modelProjectionVersion }),
        message,
      });
      return entries.map(projectTranscriptEntry);
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

function hasCompatiblePrivateReplayReference(
  message: Extract<import("@caelush/agent").AgentMessage, { type: "ASSISTANT" }>,
  record: AgentMessageRecord,
  model: { readonly provider: string; readonly model: string },
  api: string,
): boolean {
  const state = message.providerState;
  if (
    state === undefined ||
    state.providerId !== model.provider ||
    state.api !== api ||
    message.model.kind !== "MODEL_TURN" ||
    message.model.model.provider !== model.provider ||
    message.model.model.model !== model.model
  ) {
    return false;
  }
  const payload = object(state.payload);
  return (
    payload.kind === PRIVATE_REPLAY_REFERENCE_KIND &&
    payload.replayId === record.messageId &&
    payload.sessionId === record.sessionId &&
    payload.runId === record.runId &&
    payload.callId === message.model.callId &&
    payload.model === model.model &&
    payload.replayVersion === 1
  );
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function projectTranscriptEntry(entry: TranscriptEntry): TranscriptEntry {
  return entry.kind === "ASSISTANT"
    ? { ...entry, text: projectPublicAssistantText(entry.text) }
    : entry;
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
        ? "任务已完成，但没有可验证的最终答复。"
        : run.status === "CANCELLED"
          ? "任务已取消。"
          : run.status === "TIMEOUT"
            ? "任务因超时结束。"
            : run.status === "MAX_STEPS_REACHED"
              ? "任务达到最大步骤数后结束。"
              : run.status === "BUDGET_EXCEEDED"
                ? "任务因资源预算耗尽结束。"
                : "任务执行失败。",
  };
}
