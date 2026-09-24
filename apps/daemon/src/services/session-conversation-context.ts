import type { AIMessage } from "@caelush/ai";
import type {
  AgentMessageCodecRegistry,
  AgentMessageProjectorRegistry,
  AgentMessageRecord,
  StoredAgentMessage,
  SessionReadableAgentMessageRecordStore,
} from "@caelush/agent";
import type { AgentRun } from "@caelush/protocol";
import type { RunRepository } from "@caelush/storage";

export const MAX_SESSION_HISTORY_RUNS = 100;

export interface SessionConversationContextProviderOptions {
  readonly runs: Pick<RunRepository, "listBySession">;
  readonly messageRecords: SessionReadableAgentMessageRecordStore;
  readonly codecs: AgentMessageCodecRegistry;
  readonly projectors: AgentMessageProjectorRegistry;
  readonly maxRuns?: number;
}

export class SessionConversationContextProvider {
  private readonly maxRuns: number;

  constructor(private readonly options: SessionConversationContextProviderOptions) {
    this.maxRuns = options.maxRuns ?? MAX_SESSION_HISTORY_RUNS;
  }

  /**
   * Preserve the pre-5F cross-Run prompt shape — one user message and one final assistant message per
   * completed prior Run — while sourcing both messages from the durable AgentMessage lane.
   */
  async getHistoryPrefix(currentRun: AgentRun): Promise<readonly AIMessage[]> {
    const [runs, records] = await Promise.all([
      this.options.runs.listBySession(currentRun.sessionId, { limit: this.maxRuns }),
      this.options.messageRecords.listBySession(currentRun.sessionId),
    ]);
    const recordsByRun = groupRecordsByRun(records);
    const eligible = runs
      .map((run) => eligibleRun(run, currentRun))
      .filter((run): run is AgentRun => run !== undefined)
      .sort(compareRuns)
      .slice(-this.maxRuns);

    return eligible.flatMap((run) => projectCompletedRun(recordsByRun.get(run.id) ?? [], this.options));
  }
}

function groupRecordsByRun(
  records: readonly AgentMessageRecord[],
): ReadonlyMap<string, readonly AgentMessageRecord[]> {
  const grouped = new Map<string, AgentMessageRecord[]>();
  for (const record of records) {
    const existing = grouped.get(record.runId);
    if (existing === undefined) grouped.set(record.runId, [record]);
    else existing.push(record);
  }
  return grouped;
}

function projectCompletedRun(
  records: readonly AgentMessageRecord[],
  options: Pick<SessionConversationContextProviderOptions, "codecs" | "projectors">,
): readonly AIMessage[] {
  const stored = records
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((record) => decodeRecord(record, options.codecs));
  const user = stored.find((entry) => entry.message.type === "USER");
  const assistant = [...stored]
    .reverse()
    .find(
      (entry) =>
        entry.message.type === "ASSISTANT" &&
        project(entry, options.projectors).some(
          (message) =>
            message.role === "assistant" &&
            message.content.some((part) => part.type === "text"),
        ),
    );
  if (user === undefined || assistant === undefined) return [];
  return [...project(user, options.projectors), ...project(assistant, options.projectors)];
}

function decodeRecord(
  record: AgentMessageRecord,
  codecs: AgentMessageCodecRegistry,
): readonly StoredAgentMessage[] {
  try {
    const message = codecs.decode(record);
    return [
      {
        sequence: record.sequence,
        schemaVersion: record.schemaVersion,
        ...(record.modelProjectionVersion === undefined
          ? {}
          : { modelProjectionVersion: record.modelProjectionVersion }),
        message,
      },
    ];
  } catch {
    return [];
  }
}

function project(
  entry: StoredAgentMessage,
  projectors: AgentMessageProjectorRegistry,
): readonly AIMessage[] {
  return projectors.project(entry).messages;
}

function eligibleRun(run: AgentRun, currentRun: AgentRun): AgentRun | undefined {
  if (run.id === currentRun.id) return undefined;
  if (run.sessionId !== currentRun.sessionId) return undefined;
  if (
    run.workspace.id !== currentRun.workspace.id ||
    run.workspace.path !== currentRun.workspace.path
  ) {
    return undefined;
  }
  if (run.status !== "COMPLETED" || run.finishedAt === undefined) return undefined;
  if (run.finishedAt > currentRun.createdAt) return undefined;
  return run;
}

function compareRuns(left: AgentRun, right: AgentRun): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
