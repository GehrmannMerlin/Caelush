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
  createDeterministicConversationTurnIdFactory,
  projectAgentAssistantTextItems,
} from "@caelush/agent";
import {
  AssistantMessagePhaseSchema,
  SessionTurnPresentationQuerySchema,
  SessionTurnPresentationResponseV3Schema,
  toolPresentationCategory,
  type AgentRun,
  type AgentErrorCode,
  type DurableRunEvent,
  type RunStatus,
  type SessionId,
  type SessionTurnPresentationResponseV3,
  type SessionTurnPresentationTurnV3,
  type RunId,
  type ToolPresentationItemV3,
  type TurnPresentationItemV3,
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
import { projectPublicAssistantText } from "./assistant-text-projection.js";

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
const conversationTurnIds = createDeterministicConversationTurnIdFactory();

export class SessionPresentationCursorError extends Error {
  constructor() {
    super("The session presentation cursor is invalid.");
    this.name = "SessionPresentationCursorError";
  }
}

class SessionPresentationIdentityError extends Error {
  constructor() {
    super("Session presentation source identity is inconsistent.");
    this.name = "SessionPresentationIdentityError";
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
  readonly item: TurnPresentationItemV3;
  readonly createdAt: number;
  readonly stableId: string;
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
  ): Promise<SessionTurnPresentationResponseV3> {
    const query = SessionTurnPresentationQuerySchema.parse(input);
    const session = await this.options.sessions.get(sessionId);
    if (session === null) throw new StorageNotFoundError("AgentSession", sessionId);

    const [allRuns, allRecords] = await Promise.all([
      this.options.runs.listBySession(sessionId),
      this.options.messageRecords.listBySession(sessionId),
    ]);
    const runs = [...allRuns]
      .filter((run) => query.runId === undefined || run.id === query.runId)
      .sort(compareRuns);
    const start = parseRunCursor(query.cursor, runs);
    const pageRuns = runs.slice(start, start + query.limit);
    const recordsByRun = groupRecordsByRun(allRecords);
    const turns = await Promise.all(
      pageRuns.map((run) => this.projectRun(run, recordsByRun.get(run.id) ?? [])),
    );
    const end = start + turns.length;
    return SessionTurnPresentationResponseV3Schema.parse({
      capabilityVersion: 3,
      turns,
      ...(end < runs.length && turns.length > 0
        ? { nextCursor: turns[turns.length - 1]!.runId }
        : {}),
    });
  }

  private async projectRun(
    run: AgentRun,
    records: readonly AgentMessageRecord[],
  ): Promise<SessionTurnPresentationTurnV3> {
    const history = await readDurableEvents(this.options.eventReader, run.id);
    const turnId = conversationTurnIds.forRun(run.id);
    const positioned: PositionedItem[] = [];
    for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
      const items = this.projectMessage(record);
      for (const item of items) {
        if (item.runId !== run.id || item.conversationTurnId !== turnId) {
          throw new SessionPresentationIdentityError();
        }
        positioned.push({
          item,
          createdAt: Number(record.createdAt),
          stableId: `${record.messageId}:${String(item.ordinal).padStart(6, "0")}`,
        });
      }
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
      if (invocation.runId !== run.id) throw new SessionPresentationIdentityError();
      const observation = observationsByInvocation.get(invocation.id);
      const item = this.projectTool(invocation, observation, turnId);
      positioned.push({
        item,
        createdAt: Number(invocation.createdAt),
        stableId: item.id,
      });
    }

    const verificationItems = new Map<string, PositionedItem>();
    const pendingGeneralVerificationKeys: string[] = [];
    let generalVerificationIndex = 0;
    for (const event of history.events) {
      if (!VERIFICATION_EVENT_TYPES.has(event.type)) continue;
      const lifecycleKey = verificationLifecycleKey(
        event,
        pendingGeneralVerificationKeys,
        () => `general:${generalVerificationIndex++}`,
      );
      const item = this.projectVerification(event, run, turnId, lifecycleKey);
      if (item === undefined) continue;
      const existing = verificationItems.get(lifecycleKey);
      const createdAt = existing?.createdAt ?? Number(event.timestamp);
      const stableItem: VerificationPresentationItem = {
        ...item,
        createdAt: existing?.item.createdAt ?? item.createdAt,
      };
      verificationItems.set(lifecycleKey, {
        item: stableItem,
        createdAt,
        stableId: stableItem.id,
      });
    }
    for (const entry of verificationItems.values()) {
      positioned.push(
        TERMINAL_RUN_STATUSES.has(run.status) && entry.item.status === "STREAMING"
          ? settleIncompleteVerification(entry, run.status)
          : entry,
      );
    }

    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      const summary: TurnPresentationItemV3 = {
        id: `${run.id}:presentation:summary`,
        runId: run.id,
        conversationTurnId: turnId,
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
        text: runSummaryText(run.status, records, history.events),
      };
      positioned.push({
        item: summary,
        createdAt: Number(summary.createdAt),
        stableId: summary.id,
      });
    }

    positioned.sort(comparePositionedItems);
    return {
      runId: run.id,
      conversationTurnId: turnId,
      runStatus: run.status,
      openedAt: run.createdAt,
      ...(run.finishedAt === undefined ? {} : { closedAt: run.finishedAt }),
      highWatermark: history.highWatermark,
      items: positioned.map((entry, ordinal) => ({ ...entry.item, ordinal })),
    };
  }

  private projectMessage(record: AgentMessageRecord): readonly TurnPresentationItemV3[] {
    try {
      const message = this.options.codecs.decode(record);
      if (message.type === "USER") return [projectUserMessage(message)];
      if (message.type === "ASSISTANT") return projectAssistantMessage(message);
      return [];
    } catch {
      // Unsupported historical payloads remain in the durable ledger, but the public feed must not
      // guess at their shape or echo opaque bytes. The transcript endpoint owns its own fixed gap.
      return [];
    }
  }

  private projectTool(
    invocation: import("@caelush/protocol").ToolInvocation,
    observation: Extract<import("@caelush/protocol").Observation, { kind: "TOOL" }> | undefined,
    turnId: string,
  ): ToolPresentationItemV3 {
    const invocationPresentation = safePresentInvocation(this.options.toolPresentation, invocation);
    const result =
      observation === undefined ? undefined : observationToExecutionResult(observation);
    const resultPresentation = safePresentResult(this.options.toolPresentation, invocation, result);
    const preview = resultPresentation.output?.chunk;
    const status = toolItemStatus(invocation.status, observation?.isError === true);
    return {
      id: `${invocation.id}:presentation`,
      runId: invocation.runId,
      conversationTurnId: turnId,
      ordinal: 0,
      status,
      createdAt: invocation.createdAt,
      kind: "TOOL",
      toolInvocationId: invocation.id,
      toolName: invocation.toolName,
      category:
        resultPresentation.category ??
        invocationPresentation.category ??
        toolPresentationCategory(invocation.toolName),
      phase: observation?.isError === true ? "FAILED" : invocation.status,
      title: result === undefined ? invocationPresentation.title : resultPresentation.title,
      summary: result === undefined ? invocationPresentation.summary : resultPresentation.summary,
      facts: [
        { key: "状态", value: translateToolStatus(invocation.status) },
        { key: "风险", value: translateRisk(invocation.riskLevel) },
      ],
      effects: observation?.isError === true ? [] : [...(resultPresentation.effects ?? [])],
      ...(preview === undefined || preview.length === 0 ? {} : { preview }),
    };
  }

  private projectVerification(
    event: DurableRunEvent,
    run: AgentRun,
    turnId: string,
    lifecycleKey: string,
  ): VerificationPresentationItem | undefined {
    const payload = eventPayload(event);
    if (payload === undefined) return undefined;
    const verificationId =
      stringValue(payload.checkId) ??
      stringValue(payload.planId) ??
      stringValue(payload.failedPlanId) ??
      `${run.id}:${event.type}`;
    const status = verificationItemStatus(event.type, payload);
    const copy = verificationCopy(event.type, payload);
    return {
      id: `${run.id}:presentation:verification:${lifecycleKey}`,
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

function projectUserMessage(message: AgentUserMessage): TurnPresentationItemV3 {
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

function projectAssistantMessage(
  message: AgentAssistantMessage,
): readonly TurnPresentationItemV3[] {
  return projectAgentAssistantTextItems(message).map((item, ordinal) => ({
    id:
      item.assistantItemId === undefined
        ? `${message.id}:presentation`
        : `${message.id}:presentation:${String(ordinal).padStart(6, "0")}`,
    runId: message.runId,
    conversationTurnId: message.conversationTurnId,
    ordinal,
    status: "COMPLETED",
    createdAt: message.createdAt,
    kind: "ASSISTANT",
    phase: AssistantMessagePhaseSchema.parse(item.phase),
    ...(item.assistantItemId === undefined ? {} : { assistantItemId: item.assistantItemId }),
    text: projectPublicAssistantText(item.text),
    ...(message.sourceStepId === undefined ? {} : { sourceStepId: message.sourceStepId }),
  }));
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

function runSummaryText(
  status: RunStatus,
  records: readonly AgentMessageRecord[],
  events: readonly DurableRunEvent[],
): string {
  if (status === "COMPLETED") {
    return records.some((record) => record.messageType === "ASSISTANT")
      ? "任务已完成"
      : "任务已完成，但未生成可验证的最终答复";
  }
  if (status === "CANCELLED") return "任务已取消";
  if (status === "TIMEOUT") return "任务因超时结束";
  if (status === "MAX_STEPS_REACHED") return "任务达到最大步骤数后结束";
  if (status === "BUDGET_EXCEEDED") return "任务因资源预算耗尽结束";
  if (status === "FAILED") return safeFailureReason(events);
  return "任务执行失败";
}

function safeFailureReason(events: readonly DurableRunEvent[]): string {
  const safeReasonByCode: Partial<Record<AgentErrorCode, string>> = {
    VERIFICATION_FAILED: "校验未能完成，任务已失败。",
    COMMAND_FAILED: "检查命令执行失败，任务已失败。",
    PROCESS_FAILED: "检查进程未能正常运行，任务已失败。",
    RUNTIME_ERROR: "运行环境异常，任务已失败。",
    INTERNAL_ERROR: "内部错误导致任务失败。",
  };
  for (const event of [...events].reverse()) {
    if (event.type !== "error") continue;
    const rawError = eventPayload(event)?.error;
    if (!isRecord(rawError)) continue;
    const code = stringValue(rawError.code) as AgentErrorCode | undefined;
    const reason = code === undefined ? undefined : safeReasonByCode[code];
    if (reason !== undefined) return reason;
  }
  return "任务执行失败";
}

function verificationLifecycleKey(
  event: DurableRunEvent,
  pendingGeneralKeys: string[],
  nextGeneralKey: () => string,
): string {
  const payload = eventPayload(event) ?? {};
  const planId = stringValue(payload.planId) ?? stringValue(payload.failedPlanId) ?? event.eventId;
  if (event.type === "verification.started") {
    const key = nextGeneralKey();
    pendingGeneralKeys.push(key);
    return key;
  }
  if (event.type === "verification.completed") {
    return pendingGeneralKeys.shift() ?? `general-completed:${event.eventId}`;
  }
  if (
    event.type === "verification.check.started" ||
    event.type === "verification.check.completed"
  ) {
    return `check:${stringValue(payload.checkId) ?? event.eventId}`;
  }
  if (event.type === "verification.planned") return `plan:${planId}`;
  if (event.type === "verification.finalized") return `final:${planId}`;
  if (event.type === "verification.repair.started") {
    return `repair:${planId}:${numberValue(payload.repairCycle) ?? event.eventId}`;
  }
  if (event.type === "verification.repair.limit_reached") return `repair-limit:${planId}`;
  return `${event.type}:${event.eventId}`;
}

function settleIncompleteVerification(entry: PositionedItem, runStatus: RunStatus): PositionedItem {
  if (entry.item.kind !== "VERIFICATION") return entry;
  return {
    ...entry,
    item: {
      ...entry.item,
      status: runStatus === "CANCELLED" ? "CANCELLED" : "FAILED",
      summary: `${entry.item.summary}（任务结束前未记录完成状态）`,
    },
  };
}

function verificationItemStatus(
  type: string,
  payload: Record<string, unknown>,
): "STREAMING" | "COMPLETED" | "FAILED" | "CANCELLED" {
  const status = stringValue(payload.status) ?? stringValue(payload.outcome);
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "FAILED" || status === "ERROR") return "FAILED";
  if (type.endsWith(".started") || type === "verification.repair.started") return "STREAMING";
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
      return "未知状态";
  }
}

function compareRuns(left: AgentRun, right: AgentRun): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function comparePositionedItems(left: PositionedItem, right: PositionedItem): number {
  const leftRegion = presentationRegion(left.item);
  const rightRegion = presentationRegion(right.item);
  return (
    leftRegion - rightRegion ||
    left.createdAt - right.createdAt ||
    (left.stableId < right.stableId ? -1 : left.stableId > right.stableId ? 1 : 0)
  );
}

/** USER opens a Turn, FINAL_ANSWER closes its process disclosure, and summary is terminal. */
function presentationRegion(item: TurnPresentationItemV3): number {
  if (item.kind === "USER") return 0;
  if (item.kind === "RUN_SUMMARY") return 3;
  if (item.kind === "ASSISTANT" && item.phase === "FINAL_ANSWER") return 2;
  return 1;
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

function parseRunCursor(cursor: string | undefined, runs: readonly AgentRun[]): number {
  if (cursor === undefined) return 0;
  const index = runs.findIndex((run) => run.id === (cursor as RunId));
  if (index < 0) throw new SessionPresentationCursorError();
  return index + 1;
}
