import type {
  AgentAssistantMessage,
  AgentMessageCodecRegistry,
  AgentMessageRecord,
  AgentUserMessage,
  DurableRunEventReaderPort,
  ToolPresentationPort,
} from "@caelush/agent";
import type { AgentToolExecutionResult } from "@caelush/agent";
import {
  AssistantMessagePhaseSchema,
  RunStatusSchema,
  SessionTurnPresentationQuerySchema,
  SessionTurnPresentationResponseSchema,
  type AgentRun,
  type DurableRunEvent,
  type RunStatus,
  type SessionId,
  type SessionTurnPresentationResponse,
  type ToolPresentationItem,
  type TurnPresentationItem,
  type VerificationPresentationItem,
} from "@caelush/protocol";
import type { JsonObject } from "@caelush/ai";
import type {
  ObservationRepository,
  RunRepository,
  SessionRepository,
  ToolInvocationRepository,
} from "@caelush/storage";
import { StorageNotFoundError } from "@caelush/storage";

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
]);

const VERIFICATION_EVENT_TYPES = new Set([
  "verification.planned",
  "verification.started",
  "verification.completed",
  "verification.check.started",
  "verification.check.completed",
  "verification.repair.started",
  "verification.repair.limit_reached",
  "verification.finalized",
]);

const MAX_EVENT_PAGE = 1_000;

export class SessionPresentationCursorError extends Error {
  constructor() {
    super("The session presentation cursor is invalid.");
    this.name = "SessionPresentationCursorError";
  }
}

export interface SessionPresentationServiceOptions {
  readonly sessions: Pick<SessionRepository, "get">;
  readonly runs: Pick<RunRepository, "listBySession">;
  readonly messageRecords: Pick<
    import("@caelush/agent").SessionReadableAgentMessageRecordStore,
    "listBySession"
  >;
  readonly codecs: AgentMessageCodecRegistry;
  readonly toolInvocations: Pick<ToolInvocationRepository, "listByRun">;
  readonly observations: Pick<ObservationRepository, "listByRun">;
  readonly eventReader: DurableRunEventReaderPort;
  readonly toolPresentation: ToolPresentationPort;
}

interface PositionedItem {
  readonly item: TurnPresentationItem;
  readonly sequenceHint?: number;
  readonly createdAt: number;
  readonly stableId: string;
}

interface RunProjection {
  readonly items: readonly PositionedItem[];
  readonly highWatermark: number;
}

/**
 * Historical, safe projection for the Web turn feed.
 *
 * This is intentionally a separate read model from the transcript endpoint. Transcript is a
 * conversation projection; this feed is an ordered execution projection that joins durable message,
 * Tool, verification and Run facts. It never reads provider state, raw Tool arguments or transient
 * deltas, so a refresh and a live page use the same bounded contract.
 */
export class SessionPresentationService {
  constructor(private readonly options: SessionPresentationServiceOptions) {}

  async getPresentation(
    sessionId: SessionId,
    input: unknown,
  ): Promise<SessionTurnPresentationResponse> {
    const query = SessionTurnPresentationQuerySchema.parse(input);
    const session = await this.options.sessions.get(sessionId);
    if (session === null) throw new StorageNotFoundError("AgentSession", sessionId);

    const [allRuns, allRecords] = await Promise.all([
      this.options.runs.listBySession(sessionId),
      this.options.messageRecords.listBySession(sessionId),
    ]);
    const runs = [...allRuns]
      .filter((run) => query.runId === undefined || run.id === query.runId)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const recordsByRun = groupRecordsByRun(allRecords);
    const projections = await Promise.all(
      runs.map((run) => this.projectRun(run, recordsByRun.get(run.id) ?? [])),
    );
    const positioned = projections.flatMap((projection) => projection.items);
    positioned.sort(comparePositionedItems);
    const items = positioned.map((entry, index) => ({ ...entry.item, ordinal: index }));
    const start = parseCursor(query.cursor, items.length);
    const page = items.slice(start, start + query.limit);
    const end = start + page.length;
    const highWatermark = projections.reduce(
      (maximum, projection) => Math.max(maximum, projection.highWatermark),
      0,
    );
    return SessionTurnPresentationResponseSchema.parse({
      capabilityVersion: 1,
      items: page,
      highWatermark,
      ...(end < items.length ? { nextCursor: String(end) } : {}),
    });
  }

  private async projectRun(
    run: AgentRun,
    records: readonly AgentMessageRecord[],
  ): Promise<RunProjection> {
    const history = await readDurableEvents(this.options.eventReader, run.id);
    const messageSequences = new Map<string, number>();
    const toolSequences = new Map<string, number>();
    for (const event of history.events) {
      const sequence = durableSequence(event);
      if (sequence === undefined) continue;
      const payload = eventPayload(event);
      if (event.type === "conversation.message.committed") {
        const messageId = stringValue(payload?.messageId);
        if (messageId !== undefined) messageSequences.set(messageId, sequence);
      }
      if (event.type.startsWith("tool.")) {
        const invocationId = stringValue(payload?.invocationId);
        if (invocationId !== undefined && !toolSequences.has(invocationId)) {
          toolSequences.set(invocationId, sequence);
        }
      }
    }

    const positioned: PositionedItem[] = [];
    for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
      const item = this.projectMessage(record);
      if (item === undefined) continue;
      positioned.push({
        item,
        sequenceHint: messageSequences.get(record.messageId) ?? record.sequence,
        createdAt: Number(record.createdAt),
        stableId: item.id,
      });
    }

    const [invocations, observations] = await Promise.all([
      this.options.toolInvocations.listByRun(run.id),
      this.options.observations.listByRun(run.id),
    ]);
    const observationsByInvocation = new Map<
      string,
      Extract<(typeof observations)[number], { kind: "TOOL" }>
    >();
    for (const observation of observations) {
      if (observation.kind === "TOOL")
        observationsByInvocation.set(observation.toolInvocationId, observation);
    }
    for (const invocation of invocations) {
      const observation = observationsByInvocation.get(invocation.id);
      const item = this.projectTool(invocation, observation);
      const sequenceHint = toolSequences.get(invocation.id);
      positioned.push({
        item,
        ...(sequenceHint === undefined ? {} : { sequenceHint }),
        createdAt: Number(invocation.createdAt),
        stableId: item.id,
      });
    }

    const turnId = firstConversationTurnId(records) ?? `${run.id}:turn`;
    for (const event of history.events) {
      if (!VERIFICATION_EVENT_TYPES.has(event.type)) continue;
      const sequence = durableSequence(event);
      const item = this.projectVerification(event, run, turnId);
      if (item === undefined) continue;
      positioned.push({
        item,
        ...(sequence === undefined ? {} : { sequenceHint: sequence }),
        createdAt: Number(event.timestamp),
        stableId: item.id,
      });
    }

    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      const summary: TurnPresentationItem = {
        id: `${run.id}:presentation:summary`,
        runId: run.id,
        conversationTurnId: `${run.id}:summary`,
        ordinal: 0,
        status:
          run.status === "CANCELLED"
            ? "CANCELLED"
            : run.status === "COMPLETED"
              ? "COMPLETED"
              : "FAILED",
        createdAt: run.finishedAt ?? run.createdAt,
        kind: "RUN_SUMMARY",
        runStatus: run.status,
        text: runSummaryText(run.status, records),
      };
      positioned.push({
        item: summary,
        ...(history.highWatermark > 0 ? { sequenceHint: history.highWatermark } : {}),
        createdAt: Number(summary.createdAt),
        stableId: summary.id,
      });
    }

    return { items: positioned, highWatermark: history.highWatermark };
  }

  private projectMessage(record: AgentMessageRecord): TurnPresentationItem | undefined {
    try {
      const message = this.options.codecs.decode(record);
      if (message.type === "USER") return projectUserMessage(message);
      if (message.type === "ASSISTANT") return projectAssistantMessage(message);
      return undefined;
    } catch {
      // Unsupported historical payloads remain in the durable ledger, but the public feed must not
      // guess at their shape or echo opaque bytes. The transcript endpoint owns its own fixed gap.
      return undefined;
    }
  }

  private projectTool(
    invocation: import("@caelush/protocol").ToolInvocation,
    observation: Extract<import("@caelush/protocol").Observation, { kind: "TOOL" }> | undefined,
  ): ToolPresentationItem {
    const invocationPresentation = safePresentInvocation(this.options.toolPresentation, invocation);
    const result =
      observation === undefined ? undefined : observationToExecutionResult(observation);
    const resultPresentation = safePresentResult(this.options.toolPresentation, invocation, result);
    const preview = resultPresentation.output?.chunk;
    const status = toolItemStatus(invocation.status, observation?.isError === true);
    return {
      id: `${invocation.id}:presentation`,
      runId: invocation.runId,
      conversationTurnId: `${invocation.stepId}:turn`,
      ordinal: 0,
      status,
      createdAt: invocation.createdAt,
      kind: "TOOL",
      toolInvocationId: invocation.id,
      toolName: invocation.toolName,
      title: result === undefined ? invocationPresentation.title : resultPresentation.title,
      summary: result === undefined ? invocationPresentation.summary : resultPresentation.summary,
      facts: [
        { key: "状态", value: translateToolStatus(invocation.status) },
        { key: "风险", value: translateRisk(invocation.riskLevel) },
      ],
      ...(preview === undefined || preview.length === 0 ? {} : { preview }),
    };
  }

  private projectVerification(
    event: DurableRunEvent,
    run: AgentRun,
    turnId: string,
  ): VerificationPresentationItem | undefined {
    const payload = eventPayload(event);
    if (payload === undefined) return undefined;
    const verificationId =
      stringValue(payload.checkId) ?? stringValue(payload.planId) ?? `${run.id}:${event.type}`;
    const status = verificationItemStatus(event.type, payload);
    const copy = verificationCopy(event.type, payload);
    return {
      id: `${event.eventId}:presentation`,
      runId: run.id,
      conversationTurnId: turnId,
      ordinal: 0,
      status,
      createdAt: event.timestamp,
      kind: "VERIFICATION",
      verificationId,
      title: copy.title,
      summary: copy.summary,
      ...(copy.evidence === undefined ? {} : { evidence: copy.evidence }),
    };
  }
}

function groupRecordsByRun(
  records: readonly AgentMessageRecord[],
): Map<string, AgentMessageRecord[]> {
  const grouped = new Map<string, AgentMessageRecord[]>();
  for (const record of records) {
    const current = grouped.get(record.runId);
    if (current === undefined) grouped.set(record.runId, [record]);
    else current.push(record);
  }
  return grouped;
}

function projectUserMessage(message: AgentUserMessage): TurnPresentationItem {
  return {
    id: `${message.id}:presentation`,
    runId: message.runId,
    conversationTurnId: message.conversationTurnId,
    ordinal: 0,
    status: "COMPLETED",
    createdAt: message.createdAt,
    kind: "USER",
    text: message.content
      .map((part) => (part.type === "TEXT" ? part.text : "[已附加文件]"))
      .join("\n"),
  };
}

function projectAssistantMessage(message: AgentAssistantMessage): TurnPresentationItem | undefined {
  const text = message.content
    .map((part) => (part.type === "TEXT" ? part.text : ""))
    .filter((part) => part.length > 0)
    .join("\n");
  if (text.length === 0) return undefined;
  return {
    id: `${message.id}:presentation`,
    runId: message.runId,
    conversationTurnId: message.conversationTurnId,
    ordinal: 0,
    status: "COMPLETED",
    createdAt: message.createdAt,
    kind: "ASSISTANT",
    phase: AssistantMessagePhaseSchema.parse(message.phase),
    text,
  };
}

function observationToExecutionResult(
  observation: Extract<import("@caelush/protocol").Observation, { kind: "TOOL" }>,
): AgentToolExecutionResult {
  return {
    content: observation.content,
    details: (observation.details ?? {}) as JsonObject,
    isError: observation.isError,
  };
}

function safePresentInvocation(
  presentation: ToolPresentationPort,
  invocation: import("@caelush/protocol").ToolInvocation,
) {
  try {
    return presentation.presentInvocation({ invocation });
  } catch {
    return { title: "使用工具", summary: "请求使用工具" };
  }
}

function safePresentResult(
  presentation: ToolPresentationPort,
  invocation: import("@caelush/protocol").ToolInvocation,
  result: AgentToolExecutionResult | undefined,
) {
  try {
    return presentation.presentResult({ invocation, ...(result === undefined ? {} : { result }) });
  } catch {
    return { title: "使用工具", summary: "工具结果可用" };
  }
}

function toolItemStatus(
  status: import("@caelush/protocol").ToolInvocation["status"],
  isError: boolean,
) {
  if (status === "CANCELLED") return "CANCELLED" as const;
  if (status === "FAILED" || isError) return "FAILED" as const;
  if (status === "COMPLETED") return "COMPLETED" as const;
  return "STREAMING" as const;
}

function translateToolStatus(status: string): string {
  switch (status) {
    case "REQUESTED":
      return "已请求";
    case "WAITING_APPROVAL":
      return "等待批准";
    case "WAITING_RESOURCE":
      return "等待资源";
    case "RUNNING":
      return "运行中";
    case "COMPLETED":
      return "已完成";
    case "FAILED":
      return "失败";
    case "CANCELLED":
      return "已取消";
    default:
      return "状态未知";
  }
}

function translateRisk(risk: string): string {
  switch (risk) {
    case "LOW":
      return "低风险";
    case "MEDIUM":
      return "中风险";
    case "HIGH":
      return "高风险";
    case "CRITICAL":
      return "严重风险";
    default:
      return "风险未知";
  }
}

function runSummaryText(status: RunStatus, records: readonly AgentMessageRecord[]): string {
  if (status === "COMPLETED") {
    return records.some((record) => record.messageType === "ASSISTANT")
      ? "任务已完成"
      : "任务已完成，但未生成可验证的最终答复";
  }
  if (status === "CANCELLED") return "任务已取消";
  if (status === "TIMEOUT") return "任务因超时结束";
  if (status === "MAX_STEPS_REACHED") return "任务达到最大步骤数后结束";
  if (status === "BUDGET_EXCEEDED") return "任务因资源预算耗尽结束";
  return "任务执行失败";
}

function verificationItemStatus(
  type: string,
  payload: Record<string, unknown>,
): "STREAMING" | "COMPLETED" | "FAILED" | "CANCELLED" {
  const status = stringValue(payload.status) ?? stringValue(payload.outcome);
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "FAILED" || status === "ERROR") return "FAILED";
  if (
    type.endsWith(".started") ||
    type === "verification.planned" ||
    type === "verification.repair.started"
  )
    return "STREAMING";
  return "COMPLETED";
}

function verificationCopy(
  type: string,
  payload: Record<string, unknown>,
): { title: string; summary: string; evidence?: string } {
  if (type === "verification.planned") {
    const count = numberValue(payload.checkCount);
    return {
      title: "验证计划",
      summary: count === undefined ? "已生成验证计划" : `已规划 ${count} 项验证`,
    };
  }
  if (type === "verification.started") return { title: "开始验证", summary: "验证任务已开始" };
  if (type === "verification.completed") {
    const status = translateVerificationStatus(
      stringValue((payload.result as Record<string, unknown> | undefined)?.status),
    );
    return { title: "验证完成", summary: `验证${status}` };
  }
  if (type === "verification.check.started") return { title: "验证检查", summary: "检查项已开始" };
  if (type === "verification.check.completed") {
    const status = translateVerificationStatus(stringValue(payload.status));
    const count = Array.isArray(payload.evidenceIds) ? payload.evidenceIds.length : 0;
    return {
      title: "验证检查",
      summary: `检查${status}`,
      ...(count > 0 ? { evidence: `已生成 ${count} 项证据` } : {}),
    };
  }
  if (type === "verification.repair.started")
    return { title: "验证修复", summary: "已开始自动修复" };
  if (type === "verification.repair.limit_reached")
    return { title: "验证修复", summary: "已达到自动修复上限" };
  const outcome = translateVerificationStatus(stringValue(payload.outcome));
  return { title: "验证定稿", summary: `验证结果：${outcome}` };
}

function translateVerificationStatus(status: string | undefined): string {
  switch (status) {
    case "PASSED":
      return "通过";
    case "FAILED":
      return "失败";
    case "SKIPPED":
      return "已跳过";
    case "ERROR":
      return "错误";
    case "CANCELLED":
      return "已取消";
    default:
      return "完成";
  }
}

function firstConversationTurnId(records: readonly AgentMessageRecord[]): string | undefined {
  return [...records].sort((left, right) => left.sequence - right.sequence)[0]?.conversationTurnId;
}

function comparePositionedItems(left: PositionedItem, right: PositionedItem): number {
  const leftHint = left.sequenceHint ?? Number.MAX_SAFE_INTEGER;
  const rightHint = right.sequenceHint ?? Number.MAX_SAFE_INTEGER;
  return (
    leftHint - rightHint ||
    left.createdAt - right.createdAt ||
    left.stableId.localeCompare(right.stableId)
  );
}

async function readDurableEvents(
  reader: DurableRunEventReaderPort,
  runId: import("@caelush/protocol").RunId,
) {
  const highWatermark = await reader.latestSequence(runId);
  if (highWatermark <= 0) return { events: [] as DurableRunEvent[], highWatermark: 0 };
  const events: DurableRunEvent[] = [];
  let afterSequence = 0;
  while (afterSequence < highWatermark) {
    const batch = await reader.replay(runId, {
      afterSequence,
      throughSequence: highWatermark,
      limit: MAX_EVENT_PAGE,
    });
    if (batch.length === 0) break;
    let progressed = false;
    for (const event of batch) {
      const sequence = durableSequence(event);
      if (sequence === undefined || sequence <= afterSequence || sequence > highWatermark) continue;
      events.push(event);
      afterSequence = Math.max(afterSequence, sequence);
      progressed = true;
    }
    if (!progressed) break;
  }
  events.sort((left, right) => (durableSequence(left) ?? 0) - (durableSequence(right) ?? 0));
  return { events, highWatermark };
}

function durableSequence(event: DurableRunEvent): number | undefined {
  return event.durability.kind === "DURABLE" ? event.durability.sequence : undefined;
}

function eventPayload(event: DurableRunEvent): Record<string, unknown> | undefined {
  return isRecord(event.payload) ? event.payload : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function parseCursor(cursor: string | undefined, itemCount: number): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new SessionPresentationCursorError();
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0 || value > itemCount) {
    throw new SessionPresentationCursorError();
  }
  return value;
}
