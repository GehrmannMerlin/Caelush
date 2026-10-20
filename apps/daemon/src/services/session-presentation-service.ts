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
  NormalRunFinalResultSchema,
  SessionTurnPresentationQuerySchema,
  SessionTurnPresentationResponseV3Schema,
  VerifiedRunFinalResultSchema,
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
  > &
    Partial<Pick<import("@caelush/agent").SessionReadableAgentMessageRecordStore, "listByRun">>;
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
  /**
   * The display region, resolved once.
   *
   * It is a property of *this* placement rather than of the item kind: the opening USER opens the
   * Turn, while a mid-Run correction is part of the process stream at its own timestamp.
   */
  readonly region: number;
}

/** The resumable half of a verification projection. */
interface VerificationFold {
  readonly watermark: number;
  readonly items: Map<string, PositionedItem>;
  readonly pendingGeneralKeys: readonly string[];
  readonly generalIndex: number;
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
  /**
   * Projected Turns, keyed by the durable facts they were projected from.
   *
   * A session switch used to re-project **every** Turn of the session: for each Run that meant a
   * full durable-event replay plus a Tool and observation read. Historical Turns never change, so
   * the second visit paid the same cost as the first.
   *
   * The key is `runId : highWatermark : recordCount : status`. Any new durable fact for a Run
   * advances at least one of those, so a cache hit can only describe the same durable state — this
   * is a memo over immutable inputs, not a second source of truth. It is bounded and in-memory:
   * the daemon rebuilds it lazily after a restart.
   */
  private static readonly TURN_CACHE_LIMIT = 256;
  private readonly turnCache = new Map<string, SessionTurnPresentationTurnV3>();

  /**
   * The verification half of a live Run's Turn, folded up to `watermark`.
   *
   * A live Run re-projects on every durable event. Replaying its whole event log each time is
   * quadratic in the Run's length; this fold lets the next projection read only
   * `(watermark, newWatermark]` and carry the lifecycle queue forward.
   *
   * It is only ever used for a **non-terminal** Run. A terminal Run is projected once and then served
   * from `turnCache`, and its `RUN_SUMMARY` needs the full event list anyway.
   */
  private static readonly VERIFICATION_FOLD_LIMIT = 32;
  private readonly verificationFolds = new Map<string, VerificationFold>();

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
      // A targeted read only needs the Run it names. Loading the whole session's ledger here was
      // the difference between O(1) and O(session) work on every live refresh.
      query.runId !== undefined && this.options.messageRecords.listByRun !== undefined
        ? this.options.messageRecords.listByRun(query.runId)
        : this.options.messageRecords.listBySession(sessionId),
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
    if ((await this.options.sessions.get(sessionId)) === null)
      throw new StorageNotFoundError("AgentSession", sessionId);
    if (
      query.runId !== undefined &&
      !(await this.options.runs.listBySession(sessionId)).some((run) => run.id === query.runId)
    )
      throw new StorageNotFoundError("AgentRun", query.runId);
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
    const highWatermark = await this.options.eventReader.latestSequence(run.id);
    const cacheKey = `${run.id}:${highWatermark}:${records.length}:${run.status}`;
    const cached = this.turnCache.get(cacheKey);
    if (cached !== undefined) {
      // Refresh the entry's position so the eviction order stays least-recently-used.
      this.turnCache.delete(cacheKey);
      this.turnCache.set(cacheKey, cached);
      return cached;
    }
    const history = await this.readRunHistory(run, highWatermark);
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
          region: itemRegion(item, record),
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
        region: presentationRegion(item),
      });
    }

    const verification = this.projectVerificationItems(run, turnId, history.events, highWatermark);
    for (const entry of verification.items.values()) {
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
        text: runSummaryText(run, records, history.events),
      };
      positioned.push({
        item: summary,
        createdAt: Number(summary.createdAt),
        stableId: summary.id,
        region: presentationRegion(summary),
      });
    }

    positioned.sort(comparePositionedItems);
    const turn: SessionTurnPresentationTurnV3 = {
      runId: run.id,
      conversationTurnId: turnId,
      runStatus: run.status,
      openedAt: run.createdAt,
      ...(run.finishedAt === undefined ? {} : { closedAt: run.finishedAt }),
      highWatermark: history.highWatermark,
      items: positioned.map((entry, ordinal) => ({ ...entry.item, ordinal })),
    };
    this.turnCache.set(cacheKey, turn);
    if (this.turnCache.size > SessionPresentationService.TURN_CACHE_LIMIT) {
      const oldest = this.turnCache.keys().next().value;
      if (oldest !== undefined) this.turnCache.delete(oldest);
    }
    return turn;
  }

  /**
   * Only the events this projection still needs.
   *
   * A live Run advances by a handful of events per refresh; a terminal Run is projected once and
   * then served from `turnCache`, so it always takes the full read its `RUN_SUMMARY` needs.
   */
  private async readRunHistory(
    run: AgentRun,
    highWatermark: number,
  ): Promise<{ events: readonly DurableRunEvent[]; highWatermark: number }> {
    const reusable = TERMINAL_RUN_STATUSES.has(run.status)
      ? undefined
      : this.verificationFolds.get(run.id);
    if (reusable !== undefined && reusable.watermark <= highWatermark) {
      const events = await readDurableEventsRange(
        this.options.eventReader,
        run.id,
        reusable.watermark,
        highWatermark,
      );
      return { events, highWatermark };
    }
    return readDurableEvents(this.options.eventReader, run.id, highWatermark);
  }

  private projectVerificationItems(
    run: AgentRun,
    turnId: string,
    events: readonly DurableRunEvent[],
    highWatermark: number,
  ): VerificationFold {
    const terminal = TERMINAL_RUN_STATUSES.has(run.status);
    const reusable = terminal ? undefined : this.verificationFolds.get(run.id);
    const base: VerificationFold =
      reusable !== undefined && reusable.watermark <= highWatermark
        ? reusable
        : { watermark: 0, items: new Map(), pendingGeneralKeys: [], generalIndex: 0 };
    const fold = this.foldVerification(base, events, run, turnId, highWatermark);
    if (terminal) {
      // A settled Run never needs the fold again; its Turn is cached by watermark instead.
      this.verificationFolds.delete(run.id);
      return fold;
    }
    this.verificationFolds.delete(run.id);
    this.verificationFolds.set(run.id, fold);
    if (this.verificationFolds.size > SessionPresentationService.VERIFICATION_FOLD_LIMIT) {
      const oldest = this.verificationFolds.keys().next().value;
      if (oldest !== undefined) this.verificationFolds.delete(oldest);
    }
    return fold;
  }

  /**
   * Apply verification events to a fold.
   *
   * The queue matters: `verification.started` opens a general lifecycle and `verification.completed`
   * closes it, so an incremental fold must carry the queue across, exactly as a full replay would.
   */
  private foldVerification(
    state: VerificationFold,
    events: readonly DurableRunEvent[],
    run: AgentRun,
    turnId: string,
    throughWatermark: number,
  ): VerificationFold {
    const items = new Map(state.items);
    const pendingGeneralKeys = [...state.pendingGeneralKeys];
    let generalIndex = state.generalIndex;
    for (const event of events) {
      if (!VERIFICATION_EVENT_TYPES.has(event.type)) continue;
      const lifecycleKey = verificationLifecycleKey(
        event,
        pendingGeneralKeys,
        () => `general:${generalIndex++}`,
      );
      const item = this.projectVerification(event, run, turnId, lifecycleKey);
      if (item === undefined) continue;
      const existing = items.get(lifecycleKey);
      const createdAt = existing?.createdAt ?? Number(event.timestamp);
      const stableItem: VerificationPresentationItem = {
        ...item,
        createdAt: existing?.item.createdAt ?? item.createdAt,
      };
      items.set(lifecycleKey, {
        item: stableItem,
        createdAt,
        stableId: stableItem.id,
        region: presentationRegion(stableItem),
      });
    }
    return {
      watermark: throughWatermark,
      items,
      pendingGeneralKeys,
      generalIndex,
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
        { key: "调用", value: invocationPresentation.summary.slice(0, 512) },
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
    // Attachments travel in their own presentation field, so the bubble carries only what the user
    // typed. A placeholder here would duplicate the cards and leave a stray line in the bubble.
    text: message.content.flatMap((part) => (part.type === "TEXT" ? [part.text] : [])).join("\n"),
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
  run: AgentRun,
  records: readonly AgentMessageRecord[],
  events: readonly DurableRunEvent[],
): string {
  if (run.status === "COMPLETED") {
    if (NormalRunFinalResultSchema.safeParse(run.finalResult).success) return "Agent 执行已结束";
    if (VerifiedRunFinalResultSchema.safeParse(run.finalResult).success) return "历史校验已完成";
    const hasFinalAnswer = records.some(
      (record) =>
        record.messageType === "ASSISTANT" &&
        isRecord(record.data) &&
        record.data.phase === "FINAL_ANSWER",
    );
    return hasFinalAnswer ? "任务已完成" : "执行已结束，但没有可展示的最终答复";
  }
  if (run.status === "CANCELLED") return "任务已取消";
  if (run.status === "TIMEOUT") return "任务因超时结束";
  if (run.status === "MAX_STEPS_REACHED") return "任务达到最大步骤数后结束";
  if (run.status === "BUDGET_EXCEEDED") return "任务因资源预算耗尽结束";
  if (run.status === "FAILED") return safeFailureReason(events);
  return "任务执行失败";
}

function safeFailureReason(events: readonly DurableRunEvent[]): string {
  const verificationInfrastructureReasons: Readonly<Record<string, string>> = {
    VERIFICATION_COMPLETION_COMMIT_ERROR: "校验结果未能可靠保存，无法得出结论；Run 状态为失败。",
    REVIEWER_INFRASTRUCTURE_ERROR: "校验服务未能完成检查，无法得出结论；Run 状态为失败。",
    VERIFICATION_EVIDENCE_ENCODING_ERROR: "校验证据无法可靠编码，无法得出结论；Run 状态为失败。",
    VERIFICATION_EVIDENCE_SIZE_ERROR: "校验证据超出协议限制，无法得出结论；Run 状态为失败。",
    VERIFICATION_SETTLEMENT_ERROR: "校验结果未能可靠结算，无法得出结论；Run 状态为失败。",
    VERIFICATION_INTERRUPTED: "校验流程在完成前中断，无法得出结论；Run 状态为失败。",
  };
  for (const event of [...events].reverse()) {
    if (event.type !== "error") continue;
    const rawError = eventPayload(event)?.error;
    if (!isRecord(rawError)) continue;
    const code = stringValue(rawError.code) as AgentErrorCode | undefined;
    const phase = stringValue(rawError.phase);
    const details = isRecord(rawError.details) ? rawError.details : undefined;
    const reasonCode = details === undefined ? undefined : stringValue(details.reasonCode);

    if (phase === "VERIFICATION") {
      if (code === "VERIFICATION_FAILED") return "校验未通过，Run 状态为失败。";
      if (code === "INTERNAL_ERROR") {
        return (
          (reasonCode === undefined ? undefined : verificationInfrastructureReasons[reasonCode]) ??
          "校验基础设施异常，无法得出可靠结论；Run 状态为失败。"
        );
      }
      if (code === "COMMAND_FAILED" || code === "PROCESS_FAILED") {
        return "校验命令执行异常，Run 状态为失败。";
      }
      return "校验流程异常，Run 状态为失败。";
    }
    if (phase === "LLM") return "模型执行异常，Run 状态为失败。";
    if (phase === "TOOL") {
      if (code === "PERMISSION_DENIED" || code === "APPROVAL_REJECTED") {
        return "工具执行被安全或审批策略阻止，Run 状态为失败。";
      }
      return "工具执行异常，Run 状态为失败。";
    }
    if (phase === "RUNTIME") return "运行环境异常，Run 状态为失败。";
    if (phase === "INTERNAL") return "Agent 内部执行错误，Run 状态为失败。";

    if (code === "VERIFICATION_FAILED") return "校验未通过，Run 状态为失败。";
    if (code === "COMMAND_FAILED" || code === "PROCESS_FAILED") {
      return "命令或进程执行失败，Run 状态为失败。";
    }
    if (code === "RUNTIME_ERROR") return "运行环境异常，Run 状态为失败。";
    if (code === "INTERNAL_ERROR") return "Agent 内部执行错误，Run 状态为失败。";
    if (code !== undefined) return "Agent 执行异常，Run 状态为失败。";
  }
  return "Agent 执行失败；未记录可安全展示的具体原因。";
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
  const leftRegion = left.region;
  const rightRegion = right.region;
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

/**
 * The region one message occupies in the Run's presentation.
 *
 * A correction the user sent while the Run was working is placed with the work it corrects, not at
 * the top of the task: it is a mid-conversation statement, and the timestamp inside the process
 * region puts it after the Tool results and before the answer that follows it.
 */
function itemRegion(item: TurnPresentationItemV3, record: AgentMessageRecord): number {
  if (
    item.kind === "USER" &&
    record.messageType === "USER" &&
    record.source.kind === "USER" &&
    record.source.origin === "STEERING"
  ) {
    return 1;
  }
  return presentationRegion(item);
}

async function readDurableEvents(
  reader: DurableRunEventReaderPort,
  runId: import("@caelush/protocol").RunId,
  knownHighWatermark?: number,
) {
  const highWatermark = knownHighWatermark ?? (await reader.latestSequence(runId));
  if (highWatermark <= 0) return { events: [] as DurableRunEvent[], highWatermark: 0 };
  const events = await readDurableEventsRange(reader, runId, 0, highWatermark);
  return { events, highWatermark };
}

/** Read `(afterSequence, throughSequence]`, in order, paginated. */
async function readDurableEventsRange(
  reader: DurableRunEventReaderPort,
  runId: import("@caelush/protocol").RunId,
  afterSequence: number,
  throughSequence: number,
): Promise<DurableRunEvent[]> {
  if (throughSequence <= afterSequence) return [];
  const events: DurableRunEvent[] = [];
  let cursor = afterSequence;
  while (cursor < throughSequence) {
    const batch = await reader.replay(runId, {
      afterSequence: cursor,
      throughSequence,
      limit: MAX_EVENT_PAGE,
    });
    if (batch.length === 0) break;
    let progressed = false;
    for (const event of batch) {
      const sequence = durableSequence(event);
      if (sequence === undefined || sequence <= cursor || sequence > throughSequence) continue;
      events.push(event);
      cursor = Math.max(cursor, sequence);
      progressed = true;
    }
    if (!progressed) break;
  }
  events.sort((left, right) => (durableSequence(left) ?? 0) - (durableSequence(right) ?? 0));
  return events;
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
