import type { RunId, SessionId } from "@caelush/protocol";

import type { ToolExecutionSnapshot } from "../../tools/durable/execution-store-port.js";
import type { AgentAssistantMessage } from "../types/assistant-message.js";
import type { AgentAssistantToolCallPart } from "../types/content.js";
import type { AgentToolResultMessage } from "../types/tool-result-message.js";
import type { StoredAgentMessage } from "../persistence/record.js";

/** The durable facts that determine whether a missing invocation can prove non-execution. */
export type MissingToolInvocationEvidence = "DURABLE_STARTUP_CONTRACT_VERIFIED" | "UNVERIFIED";

/** Classification of one original model Tool Call without creating any execution facts. */
export type InterruptedToolCallClassification =
  | "RESULT_COMMITTED"
  | "OBSERVATION_COMMITTED"
  | "NOT_STARTED"
  | "CANCELLED_CONFIRMED"
  | "OUTCOME_UNKNOWN";

/** One call in the original Assistant message, in its stored order. */
export interface ReconciledInterruptedToolCall {
  readonly call: AgentAssistantToolCallPart;
  readonly classification: InterruptedToolCallClassification;
  readonly result?: StoredAgentMessage<AgentToolResultMessage>;
  readonly execution?: ToolExecutionSnapshot;
}

/** A persisted Assistant Tool batch and its matching durable execution facts. */
export interface ReconciledInterruptedToolBatch {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly conversationTurnId: string;
  readonly assistantMessageId: string;
  readonly sourceStepId: string;
  readonly assistant: StoredAgentMessage<AgentAssistantMessage>;
  readonly calls: readonly ReconciledInterruptedToolCall[];
}

/** Safe, content-free failure raised when durable history cannot be reconciled unambiguously. */
export class InterruptedToolBatchReconciliationError extends Error {
  constructor(readonly reason: "HISTORY_INTEGRITY_ERROR" | "EXECUTION_FACT_MISMATCH") {
    super(
      reason === "HISTORY_INTEGRITY_ERROR"
        ? "Interrupted Tool history cannot be reconciled safely."
        : "Interrupted Tool execution facts do not match the stored call.",
    );
    this.name = "InterruptedToolBatchReconciliationError";
  }
}

/**
 * Identify complete, durable Tool Calls and classify each against the read-only execution ledger.
 *
 * This function has no authority to run a Tool, change a Run, or write a message. A missing
 * invocation is `NOT_STARTED` only when the host has verified that all handlers persist REQUESTED
 * before entering the handler; otherwise absence is ambiguous and becomes `OUTCOME_UNKNOWN`.
 */
export function reconcileInterruptedToolBatches(input: {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly messages: readonly StoredAgentMessage[];
  readonly executionsByCallId: ReadonlyMap<string, ToolExecutionSnapshot | null>;
  readonly missingInvocationEvidence: MissingToolInvocationEvidence;
}): readonly ReconciledInterruptedToolBatch[] {
  const assistants: StoredAgentMessage<AgentAssistantMessage>[] = [];
  const callOwners = new Map<string, ReconciledInterruptedToolBatch["calls"][number]>();
  const callAssistantById = new Map<string, StoredAgentMessage<AgentAssistantMessage>>();
  const results = new Map<string, StoredAgentMessage<AgentToolResultMessage>>();

  for (const stored of input.messages) {
    const message = stored.message;
    if (message.sessionId !== input.sessionId || message.runId !== input.runId) continue;

    if (message.type === "ASSISTANT" && message.audience.model) {
      const assistant = stored as StoredAgentMessage<AgentAssistantMessage>;
      const calls = assistant.message.content.filter(
        (part): part is AgentAssistantToolCallPart => part.type === "TOOL_CALL",
      );
      if (calls.length === 0) continue;
      if (assistant.message.sourceStepId === undefined) {
        throw new InterruptedToolBatchReconciliationError("HISTORY_INTEGRITY_ERROR");
      }
      assistants.push(assistant);
      for (const call of calls) {
        if (callOwners.has(call.toolCallId)) {
          throw new InterruptedToolBatchReconciliationError("HISTORY_INTEGRITY_ERROR");
        }
        callOwners.set(call.toolCallId, {
          call,
          classification: "OUTCOME_UNKNOWN",
        });
        callAssistantById.set(call.toolCallId, assistant);
      }
      continue;
    }

    if (message.type === "TOOL_RESULT" && message.audience.model) {
      const result = stored as StoredAgentMessage<AgentToolResultMessage>;
      const callId = result.message.toolCallId;
      if (results.has(callId)) {
        throw new InterruptedToolBatchReconciliationError("HISTORY_INTEGRITY_ERROR");
      }
      results.set(callId, result);
    }
  }

  for (const [callId, result] of results) {
    const owner = callOwners.get(callId);
    if (owner === undefined) {
      throw new InterruptedToolBatchReconciliationError("HISTORY_INTEGRITY_ERROR");
    }
    const assistant = callAssistantById.get(callId)!;
    if (
      result.message.toolName !== owner.call.toolName ||
      result.message.sessionId !== assistant.message.sessionId ||
      result.message.runId !== assistant.message.runId ||
      result.message.conversationTurnId !== assistant.message.conversationTurnId ||
      result.message.sourceStepId !== assistant.message.sourceStepId ||
      result.sequence <= assistant.sequence
    ) {
      throw new InterruptedToolBatchReconciliationError("HISTORY_INTEGRITY_ERROR");
    }
    const execution = input.executionsByCallId.get(callId);
    if (result.message.observation.kind === "OBSERVATION" && execution != null) {
      if (
        execution?.observation?.id !== result.message.observation.observationId ||
        execution.observation.kind !== "TOOL" ||
        execution.observation.toolInvocationId !== execution.invocation.id
      ) {
        throw new InterruptedToolBatchReconciliationError("EXECUTION_FACT_MISMATCH");
      }
    }
    callOwners.set(callId, {
      call: owner.call,
      classification: "RESULT_COMMITTED",
      result,
      ...(execution === undefined || execution === null ? {} : { execution }),
    });
  }

  for (const assistant of assistants) {
    const batchCallIds = assistant.message.content
      .filter((part): part is AgentAssistantToolCallPart => part.type === "TOOL_CALL")
      .map((part) => part.toolCallId);
    const committedCallIds = batchCallIds
      .map((callId) => ({ callId, result: results.get(callId) }))
      .filter(
        (
          item,
        ): item is {
          readonly callId: string;
          readonly result: StoredAgentMessage<AgentToolResultMessage>;
        } => item.result !== undefined,
      )
      .sort((left, right) => left.result.sequence - right.result.sequence)
      .map((item) => item.callId);
    if (
      committedCallIds.some((callId, index) => batchCallIds[index] !== callId) ||
      committedCallIds.length > batchCallIds.length
    ) {
      throw new InterruptedToolBatchReconciliationError("HISTORY_INTEGRITY_ERROR");
    }
  }

  const batches = assistants.map((assistant) => {
    const sourceStepId = assistant.message.sourceStepId!;
    const calls = assistant.message.content
      .filter((part): part is AgentAssistantToolCallPart => part.type === "TOOL_CALL")
      .map((call): ReconciledInterruptedToolCall => {
        const existing = callOwners.get(call.toolCallId)!;
        if (existing.classification === "RESULT_COMMITTED") return existing;

        const execution = input.executionsByCallId.get(call.toolCallId);
        if (execution === undefined) {
          return { call, classification: "OUTCOME_UNKNOWN" };
        }
        if (execution === null) {
          return {
            call,
            classification:
              input.missingInvocationEvidence === "DURABLE_STARTUP_CONTRACT_VERIFIED"
                ? "NOT_STARTED"
                : "OUTCOME_UNKNOWN",
          };
        }

        const invocation = execution.invocation;
        if (
          execution.sessionId !== input.sessionId ||
          invocation.runId !== input.runId ||
          invocation.stepId !== sourceStepId ||
          invocation.externalCallId !== call.toolCallId ||
          invocation.toolName !== call.toolName
        ) {
          throw new InterruptedToolBatchReconciliationError("EXECUTION_FACT_MISMATCH");
        }
        if (execution.observation !== undefined) {
          if (
            execution.observation.kind !== "TOOL" ||
            execution.observation.runId !== input.runId ||
            execution.observation.stepId !== sourceStepId ||
            execution.observation.toolInvocationId !== invocation.id
          ) {
            throw new InterruptedToolBatchReconciliationError("EXECUTION_FACT_MISMATCH");
          }
        }

        switch (invocation.status) {
          case "REQUESTED":
          case "WAITING_APPROVAL":
            return { call, classification: "NOT_STARTED", execution };
          case "RUNNING":
            return { call, classification: "OUTCOME_UNKNOWN", execution };
          case "CANCELLED":
            return execution.observation === undefined
              ? { call, classification: "CANCELLED_CONFIRMED", execution }
              : { call, classification: "OBSERVATION_COMMITTED", execution };
          case "COMPLETED":
          case "FAILED":
            if (execution.observation === undefined) {
              throw new InterruptedToolBatchReconciliationError("EXECUTION_FACT_MISMATCH");
            }
            return { call, classification: "OBSERVATION_COMMITTED", execution };
        }
      });

    return Object.freeze({
      sessionId: input.sessionId,
      runId: input.runId,
      conversationTurnId: assistant.message.conversationTurnId,
      assistantMessageId: assistant.message.id,
      sourceStepId,
      assistant,
      calls: Object.freeze(calls),
    });
  });

  return Object.freeze(batches);
}
