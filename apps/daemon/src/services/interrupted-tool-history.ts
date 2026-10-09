import {
  createAgentMessageFactory,
  createScriptedAgentMessageIdFactory,
  deriveInterruptedToolResultMessageId,
  fingerprintProjection,
  createRunEventFactory,
  reconcileInterruptedToolBatches,
  TOOL_NOT_STARTED,
} from "@caelush/agent";
import type {
  AgentAssistantToolCallPart,
  AgentMessage,
  AgentMessageId,
  AgentMessageRecord,
  InterruptedToolCallClassification,
  MissingToolInvocationEvidence,
  RunEventNotifierPort,
  StoredAgentMessage,
  ToolBatchItemOutcome,
  ToolCallRequest,
  ToolObservationPolicySnapshot,
} from "@caelush/agent";
import { createEventId, ToolNameSchema as ProtocolToolNameSchema } from "@caelush/protocol";
import type { AgentRun, StepId } from "@caelush/protocol";
import {
  createToolResultMessageAppend,
  type RunMessageAuthority,
  type RunToolFeedbackProjection,
  type ToolTurnPipeline,
} from "@caelush/core";
import type { CaelushStorage } from "@caelush/storage";

const CLOSURE_VERSION = 1;
const DEFAULT_RECOVERY_OBSERVATION_POLICY: ToolObservationPolicySnapshot = Object.freeze({
  maxSingleObservationTokens: 4_096,
  maxObservationBatchTokens: 16_384,
});
const TOOL_NOT_STARTED_INTERRUPTED_CONTENT =
  "The tool call was not started because the previous run was interrupted. It may be requested again if still needed.";
const TOOL_OUTCOME_UNKNOWN_CONTENT =
  "The operation may have produced side effects. Its final outcome is unknown. Inspect the current state before attempting a retry. Do not blindly repeat this action.";
const TOOL_CANCELLED_UNKNOWN_CONTENT =
  "The tool operation was cancelled. It may have produced partial side effects before cancellation. Inspect the current state before attempting a retry. Do not blindly repeat this action.";

type ReconciledBatch = ReturnType<typeof reconcileInterruptedToolBatches>[number];
type ReconciledCall = ReconciledBatch["calls"][number];
type MissingReconciledCall = ReconciledCall & {
  readonly classification: Exclude<InterruptedToolCallClassification, "RESULT_COMMITTED">;
};

export type SessionContinuationPreflightFailureReason =
  | "HISTORY_INTEGRITY_ERROR"
  | "EXECUTION_FACT_MISMATCH"
  | "WORKSPACE_MISMATCH"
  | "SESSION_MISSING"
  | "RUN_MISSING"
  | "STORAGE_UNAVAILABLE";

/** Safe, content-free reason for refusing to send a malformed or unrepairable history to a model. */
export class SessionContinuationPreflightError extends Error {
  constructor(readonly reason: SessionContinuationPreflightFailureReason) {
    super("Session history could not be safely prepared for continuation.");
    this.name = "SessionContinuationPreflightError";
  }
}

export interface InterruptedToolHistoryLogger {
  error?(
    error: unknown,
    context: { readonly operation: string; readonly runId: AgentRun["id"] },
  ): void;
}

/**
 * Repair only durable conversation protocol gaps. Tool execution, Run lifecycle, and model policy
 * remain owned by their existing authorities.
 */
export function createInterruptedToolHistoryService(options: {
  readonly storage: CaelushStorage;
  readonly messages: RunMessageAuthority;
  readonly toolTurn: ToolTurnPipeline;
  readonly events: RunEventNotifierPort;
  readonly logger?: InterruptedToolHistoryLogger;
}) {
  const runEvents = createRunEventFactory();

  function decodeStoredMessages(records: readonly AgentMessageRecord[]): StoredAgentMessage[] {
    return records.map((record) => ({
      sequence: record.sequence,
      schemaVersion: record.schemaVersion,
      ...(record.modelProjectionVersion === undefined
        ? {}
        : { modelProjectionVersion: record.modelProjectionVersion }),
      message: options.messages.codecs.decode(record) as AgentMessage,
    }));
  }

  return {
    async preflight(run: AgentRun): Promise<void> {
      try {
        const snapshot = await options.messages.conversation.loadSnapshot({
          sessionId: run.sessionId,
          currentRunId: run.id,
        });
        let hasHistoricalGap = false;
        for (const turn of snapshot.turns) {
          const open = hasOpenToolBatch(turn.sessionId, turn.runId, turn.messages);
          if (!open) continue;
          if (turn.runId === run.id) {
            throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
          }
          hasHistoricalGap = true;
        }
        if (!hasHistoricalGap) return;
      } catch (error) {
        if (error instanceof SessionContinuationPreflightError) throw error;
        if (!isRepairableConversationGap(error)) {
          throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
        }
      }

      try {
        await repairSessionHistory(run);
        await options.messages.conversation.loadSnapshot({
          sessionId: run.sessionId,
          currentRunId: run.id,
        });
      } catch (error) {
        if (error instanceof SessionContinuationPreflightError) throw error;
        throw new SessionContinuationPreflightError(reasonFrom(error));
      }
    },

    async closeCancelled(
      run: AgentRun,
      observationPolicy?: ToolObservationPolicySnapshot,
      observationPolicySourceStepId?: StepId,
    ): Promise<void> {
      try {
        await repairCancelledRun(run, observationPolicy, observationPolicySourceStepId);
      } catch (error) {
        options.logger?.error?.(
          new Error(`Interrupted Tool history closure was deferred (${reasonFrom(error)}).`),
          { operation: "INTERRUPTED_HISTORY_CLOSURE", runId: run.id },
        );
      }
    },
  };

  async function repairSessionHistory(currentRun: AgentRun): Promise<void> {
    const session = await options.storage.sessions.get(currentRun.sessionId);
    if (session === null) throw new SessionContinuationPreflightError("SESSION_MISSING");
    assertWorkspaceIdentity(session.workspaceId, currentRun);

    const [runs, records] = await Promise.all([
      options.storage.runs.listBySession(currentRun.sessionId),
      options.storage.messageRecords.listBySession(currentRun.sessionId),
    ]);
    const runsById = new Map(runs.map((run) => [run.id, run] as const));
    if (!runsById.has(currentRun.id)) {
      throw new SessionContinuationPreflightError("RUN_MISSING");
    }

    const recordsByRun = new Map<AgentRun["id"], AgentMessageRecord[]>();
    for (const record of records) {
      if (record.sessionId !== currentRun.sessionId || !runsById.has(record.runId)) {
        throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
      }
      const list = recordsByRun.get(record.runId) ?? [];
      list.push(record);
      recordsByRun.set(record.runId, list);
    }
    for (const runRecords of recordsByRun.values()) {
      runRecords.sort((left, right) => left.sequence - right.sequence);
    }

    const closures: Array<{
      readonly run: AgentRun;
      readonly batch: ReconciledBatch;
      readonly expectedAssistant: AgentMessageRecord;
      readonly calls: readonly ToolCallRequest[];
      readonly outcomes: readonly ToolBatchItemOutcome[];
      readonly missing: readonly MissingReconciledCall[];
      readonly observationPolicy: ToolObservationPolicySnapshot;
    }> = [];

    for (const historicalRun of runs) {
      if (historicalRun.id === currentRun.id) continue;
      const runRecords = recordsByRun.get(historicalRun.id) ?? [];
      if (runRecords.length === 0) continue;
      const stored = decodeStoredMessages(runRecords);
      const initial = reconcileInterruptedToolBatches({
        sessionId: currentRun.sessionId,
        runId: historicalRun.id,
        messages: stored,
        executionsByCallId: new Map(),
        missingInvocationEvidence: "UNVERIFIED",
      });
      const openBatches = initial.filter((batch) =>
        batch.calls.some((call) => call.classification !== "RESULT_COMMITTED"),
      );
      if (openBatches.length === 0) continue;
      if (historicalRun.status !== "CANCELLED") {
        throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
      }
      assertWorkspaceIdentity(session.workspaceId, currentRun);
      if (
        historicalRun.workspace.id !== currentRun.workspace.id ||
        historicalRun.workspace.path !== currentRun.workspace.path
      ) {
        throw new SessionContinuationPreflightError("WORKSPACE_MISMATCH");
      }

      const executions = new Map<
        string,
        Awaited<ReturnType<typeof options.storage.toolExecution.findByExternalCall>>
      >();
      for (const batch of openBatches) {
        for (const entry of batch.calls) {
          if (entry.classification === "RESULT_COMMITTED") continue;
          const execution = await options.storage.toolExecution.findByExternalCall(
            historicalRun.id,
            batch.sourceStepId as StepId,
            entry.call.toolCallId,
          );
          executions.set(entry.call.toolCallId, execution);
        }
      }
      const reconciled = reconcileInterruptedToolBatches({
        sessionId: currentRun.sessionId,
        runId: historicalRun.id,
        messages: stored,
        executionsByCallId: executions,
        missingInvocationEvidence: DURABLE_STARTUP_EVIDENCE,
      });
      const recordByMessageId = new Map<string, AgentMessageRecord>(
        runRecords.map((record) => [record.messageId, record]),
      );
      for (const batch of reconciled) {
        const missing = batch.calls.filter(isMissingCall);
        if (missing.length === 0) continue;
        const expectedAssistant = recordByMessageId.get(batch.assistantMessageId);
        if (expectedAssistant === undefined) {
          throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
        }
        const calls = missing.map((entry) => toToolCallRequest(entry.call));
        const outcomes = missing.map((entry) => toBatchOutcome(entry));
        const observationPolicy = resolveObservationPolicy(batch, missing);
        closures.push({
          run: historicalRun,
          batch,
          expectedAssistant,
          calls,
          outcomes,
          missing,
          observationPolicy,
        });
      }
    }

    for (const closure of closures) {
      await commitBatchClosure(closure);
    }
  }

  async function repairCancelledRun(
    run: AgentRun,
    observationPolicy?: ToolObservationPolicySnapshot,
    observationPolicySourceStepId?: StepId,
  ): Promise<void> {
    if (run.status !== "CANCELLED") return;
    const session = await options.storage.sessions.get(run.sessionId);
    if (session === null) throw new SessionContinuationPreflightError("SESSION_MISSING");
    assertWorkspaceIdentity(session.workspaceId, run);
    const [currentRun, runRecords] = await Promise.all([
      options.storage.runs.get(run.id),
      options.storage.messageRecords.listByRun(run.id),
    ]);
    if (currentRun === null || currentRun.sessionId !== run.sessionId) {
      throw new SessionContinuationPreflightError("RUN_MISSING");
    }
    if (currentRun.status !== "CANCELLED") return;

    const stored = decodeStoredMessages(runRecords);
    const initial = reconcileInterruptedToolBatches({
      sessionId: run.sessionId,
      runId: run.id,
      messages: stored,
      executionsByCallId: new Map(),
      missingInvocationEvidence: "UNVERIFIED",
    });
    const openBatches = initial.filter((batch) =>
      batch.calls.some((call) => call.classification !== "RESULT_COMMITTED"),
    );
    if (openBatches.length === 0) return;

    const executions = new Map<
      string,
      Awaited<ReturnType<typeof options.storage.toolExecution.findByExternalCall>>
    >();
    for (const batch of openBatches) {
      for (const entry of batch.calls) {
        if (entry.classification === "RESULT_COMMITTED") continue;
        executions.set(
          entry.call.toolCallId,
          await options.storage.toolExecution.findByExternalCall(
            run.id,
            batch.sourceStepId as StepId,
            entry.call.toolCallId,
          ),
        );
      }
    }
    const reconciled = reconcileInterruptedToolBatches({
      sessionId: run.sessionId,
      runId: run.id,
      messages: stored,
      executionsByCallId: executions,
      missingInvocationEvidence: DURABLE_STARTUP_EVIDENCE,
    });
    const recordByMessageId = new Map<string, AgentMessageRecord>(
      runRecords.map((record) => [record.messageId, record]),
    );
    for (const batch of reconciled) {
      const missing = batch.calls.filter(isMissingCall);
      if (missing.length === 0) continue;
      const expectedAssistant = recordByMessageId.get(batch.assistantMessageId);
      if (expectedAssistant === undefined) {
        throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
      }
      const batchPolicyHint =
        batch.sourceStepId === observationPolicySourceStepId ? observationPolicy : undefined;
      await commitBatchClosure({
        run: currentRun,
        batch,
        expectedAssistant,
        calls: missing.map((entry) => toToolCallRequest(entry.call)),
        outcomes: missing.map((entry) => toBatchOutcome(entry)),
        missing,
        observationPolicy: resolveObservationPolicy(batch, missing, batchPolicyHint),
      });
    }
  }

  async function commitBatchClosure(input: {
    readonly run: AgentRun;
    readonly batch: ReconciledBatch;
    readonly expectedAssistant: AgentMessageRecord;
    readonly calls: readonly ToolCallRequest[];
    readonly outcomes: readonly ToolBatchItemOutcome[];
    readonly missing: readonly MissingReconciledCall[];
    readonly observationPolicy: ToolObservationPolicySnapshot;
  }): Promise<void> {
    const projected = options.toolTurn.feedback.project({
      calls: input.calls,
      items: input.outcomes,
      policy: input.observationPolicy,
    });
    const contributed =
      options.toolTurn.feedbackContributions === undefined
        ? projected
        : await options.toolTurn.feedbackContributions.apply({
            runId: input.run.id,
            sessionId: input.run.sessionId,
            sourceStepId: input.batch.sourceStepId as StepId,
            mode: "RECOVER",
            signal: AbortSignal.timeout(10_000),
            items: input.outcomes,
            projected,
          });
    const normalized = options.toolTurn.normalizer.normalize({
      requests: input.calls,
      results: contributed.map((item) => item.message),
    });
    const projectedByCallId = new Map(
      projected.map((item) => [item.message.toolCallId, item] as const),
    );
    const feedback = normalized.map((message): RunToolFeedbackProjection => {
      const original = projectedByCallId.get(message.toolCallId);
      if (original === undefined) {
        throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
      }
      const fingerprint = fingerprintProjection([message]);
      return {
        message,
        observation: original.observation,
        receipt:
          original.receipt.fingerprint === fingerprint
            ? original.receipt
            : Object.freeze({ ...original.receipt, fingerprint }),
      };
    });
    if (feedback.length !== input.missing.length) {
      throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
    }

    for (let index = 0; index < input.missing.length; index += 1) {
      const entry = input.missing[index];
      const projection = feedback[index];
      if (entry === undefined || projection === undefined) {
        throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
      }
      const messageId = deriveInterruptedToolResultMessageId({
        sessionId: input.run.sessionId,
        sourceRunId: input.run.id,
        assistantMessageId: input.batch.assistantMessageId as AgentMessageId,
        toolCallId: entry.call.toolCallId,
        closureVersion: CLOSURE_VERSION,
      });
      // Use durable history time so retries and concurrent repair attempts derive the same record.
      const now = input.run.finishedAt ?? input.expectedAssistant.createdAt;
      const closureFactory = createAgentMessageFactory({
        ids: createScriptedAgentMessageIdFactory([messageId]),
        now: () => now,
        turns: options.messages.turns,
      });
      const append = createToolResultMessageAppend(
        { ...options.messages, factory: closureFactory },
        input.run,
        input.batch.sourceStepId as StepId,
        projection,
      );
      const messageEvent = runEvents.messageCommitted(
        input.run,
        {
          messageId: append.draft.messageId,
          conversationTurnId: append.draft.conversationTurnId,
          messageType: "TOOL_RESULT",
        },
        createEventId(),
        now,
      );
      const result = await options.storage.execution.commitInterruptedHistoryClosure({
        sessionId: input.run.sessionId,
        runId: input.run.id,
        expectedAssistant: input.expectedAssistant,
        toolCallId: entry.call.toolCallId,
        toolName: entry.call.toolName,
        batchToolCallIds: input.batch.calls.map((call) => call.call.toolCallId),
        callIndex: input.batch.calls.findIndex(
          (call) => call.call.toolCallId === entry.call.toolCallId,
        ),
        closureVersion: CLOSURE_VERSION,
        classification: entry.classification,
        missingInvocationEvidence: DURABLE_STARTUP_EVIDENCE,
        message: append.draft,
        messageEvent,
      });
      if (result.events.length > 0) options.events.notifyCommitted(result.events);
    }
  }
}

function isRepairableConversationGap(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AgentConversationError" &&
    "reason" in error &&
    (error.reason === "MISSING_TOOL_RESULT" || error.reason === "MODEL_VISIBLE_RESULT_REQUIRED")
  );
}

function hasOpenToolBatch(
  sessionId: import("@caelush/protocol").SessionId,
  runId: AgentRun["id"],
  messages: readonly StoredAgentMessage[],
): boolean {
  const batches = reconcileInterruptedToolBatches({
    sessionId,
    runId,
    messages,
    executionsByCallId: new Map(),
    missingInvocationEvidence: "UNVERIFIED",
  });
  return batches.some((batch) =>
    batch.calls.some((call) => call.classification !== "RESULT_COMMITTED"),
  );
}

function assertWorkspaceIdentity(
  sessionWorkspaceId: AgentRun["workspace"]["id"] | undefined,
  run: AgentRun,
): void {
  if (sessionWorkspaceId !== undefined && sessionWorkspaceId !== run.workspace.id) {
    throw new SessionContinuationPreflightError("WORKSPACE_MISMATCH");
  }
}

function isMissingCall(entry: ReconciledCall): entry is MissingReconciledCall {
  return entry.classification !== "RESULT_COMMITTED";
}

function resolveObservationPolicy(
  batch: ReconciledBatch,
  missing: readonly MissingReconciledCall[],
  hint?: ToolObservationPolicySnapshot,
): ToolObservationPolicySnapshot {
  const persistedPolicies = batch.calls.flatMap((entry) => {
    const policy = entry.result?.message.projection.policy;
    return policy?.kind === "SNAPSHOT" ? [policy.snapshot] : [];
  });
  const persistedPolicy = persistedPolicies[0];
  if (
    persistedPolicy !== undefined &&
    persistedPolicies.some((candidate) => !sameObservationPolicy(candidate, persistedPolicy))
  ) {
    throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
  }
  if (
    hint !== undefined &&
    persistedPolicy !== undefined &&
    !sameObservationPolicy(hint, persistedPolicy)
  ) {
    throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
  }

  const policy = hint ?? persistedPolicy;
  if (
    policy === undefined &&
    missing.some((entry) => entry.classification === "OBSERVATION_COMMITTED")
  ) {
    throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
  }
  return policy ?? DEFAULT_RECOVERY_OBSERVATION_POLICY;
}

function sameObservationPolicy(
  left: ToolObservationPolicySnapshot,
  right: ToolObservationPolicySnapshot,
): boolean {
  return (
    left.maxSingleObservationTokens === right.maxSingleObservationTokens &&
    left.maxObservationBatchTokens === right.maxObservationBatchTokens
  );
}

function toToolCallRequest(call: AgentAssistantToolCallPart): ToolCallRequest {
  const parsedName = ProtocolToolNameSchema.safeParse(call.toolName);
  if (!parsedName.success) {
    throw new SessionContinuationPreflightError("HISTORY_INTEGRITY_ERROR");
  }
  return {
    externalCallId: call.toolCallId,
    toolName: parsedName.data,
    args: call.input as ToolCallRequest["args"],
  };
}

function toBatchOutcome(
  entry: ReturnType<typeof reconcileInterruptedToolBatches>[number]["calls"][number],
): ToolBatchItemOutcome {
  const call = toToolCallRequest(entry.call);
  if (entry.classification === "OBSERVATION_COMMITTED") {
    const execution = entry.execution;
    if (
      execution === undefined ||
      execution.observation === undefined ||
      (execution.invocation.status !== "COMPLETED" &&
        execution.invocation.status !== "FAILED" &&
        execution.invocation.status !== "CANCELLED")
    ) {
      throw new SessionContinuationPreflightError("EXECUTION_FACT_MISMATCH");
    }
    return {
      kind: "OBSERVATION",
      call,
      invocationId: execution.invocation.id,
      finalStatus: execution.invocation.status,
      observation: execution.observation,
    };
  }

  if (entry.classification === "NOT_STARTED") {
    return {
      kind: "SKIPPED",
      call,
      feedback: {
        code: TOOL_NOT_STARTED,
        content: TOOL_NOT_STARTED_INTERRUPTED_CONTENT,
        details: {},
        disposition: "SAFE_FAILURE",
      },
    };
  }

  return {
    kind: "SKIPPED",
    call,
    feedback: {
      code: "TOOL_OUTCOME_UNKNOWN",
      content:
        entry.classification === "CANCELLED_CONFIRMED"
          ? TOOL_CANCELLED_UNKNOWN_CONTENT
          : TOOL_OUTCOME_UNKNOWN_CONTENT,
      details: {},
      disposition: "UNCERTAIN_SIDE_EFFECT",
      blockToolFailures: true,
    },
  };
}

function reasonFrom(error: unknown): SessionContinuationPreflightFailureReason {
  if (error instanceof SessionContinuationPreflightError) return error.reason;
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = error.reason;
    if (reason === "HISTORY_INTEGRITY_ERROR" || reason === "EXECUTION_FACT_MISMATCH") return reason;
  }
  return "STORAGE_UNAVAILABLE";
}

/**
 * DurableToolExecutionCoordinator commits REQUESTED before admission and RUNNING before invoking a
 * handler. Under that contract, an absent invocation proves the handler was never entered.
 */
const DURABLE_STARTUP_EVIDENCE: MissingToolInvocationEvidence = "DURABLE_STARTUP_CONTRACT_VERIFIED";
