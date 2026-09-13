import type {
  RunContinuationCheckpoint as AgentContinuationCheckpoint,
  RunConversationEntry,
  RunExecutionSnapshot as AgentExecutionSnapshot,
} from "@caelush/agent";
import type { AgentRun, RunStatus } from "@caelush/protocol";
import type { LLMToolResultMessage } from "@caelush/llm/messages";
import type { RunContinuationCheckpoint } from "./agent-continuation.js";
import type { RunExecutionSnapshot } from "./run-execution-store.js";
import { toAIMessage } from "./ai-invocation-projection.js";

/**
 * The Run Layer's projection onto the canonical durable snapshot.
 *
 * The coordinator is frozen at `next(snapshot, now)`, so this is the only place the Run Layer's
 * own record meets the agent-owned contract. Two projections happen here and nowhere else:
 *
 * ```text
 * legacy durable LLMMessage   →  AIMessage
 * the Run Layer continuation  →  the canonical Run continuation
 * ```
 *
 * Both are compatibility projections, not a Message System migration: the stored bytes do not
 * change, and the field semantics — role, text, tool-call identity, tool name, arguments, tool
 * result identity and error flag, in order — are carried across unchanged.
 */

/** Project a durable Run status onto the frozen execution status. */
export function toExecutionStatus(status: RunStatus): import("@caelush/agent").RunExecutionStatus {
  // The two vocabularies are the same closed set, and the cast is asserted below rather than
  // assumed: a status the coordinator cannot route must fail loudly here instead of becoming
  // `undefined` and being read as "this Run has no boundary".
  const statuses: readonly import("@caelush/agent").RunExecutionStatus[] = [
    "PENDING",
    "RUNNING",
    "WAITING_APPROVAL",
    "WAITING_RESOURCE",
    "VERIFYING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ];
  const match = statuses.find((candidate) => candidate === status);
  if (match === undefined) {
    throw new Error(`Run status "${status}" is not a frozen execution status.`);
  }
  return match;
}

/**
 * Project one durable continuation onto the canonical domain.
 *
 * The discriminants are already the durable spellings, so this is a field-for-field projection
 * plus the message projection. A continuation type with no canonical counterpart would be a
 * routing gap, so it fails loudly rather than being dropped.
 */
export function toAgentContinuation(
  continuation: RunContinuationCheckpoint,
): AgentContinuationCheckpoint {
  switch (continuation.type) {
    case "WAITING_TOOL_RESULTS":
      return {
        type: "WAITING_TOOL_RESULTS",
        runId: continuation.runId,
        sourceStepId: continuation.sourceStepId,
        pendingDecision: continuation.pendingDecision,
        ...(continuation.receivedResults === undefined
          ? {}
          : { receivedResults: toAgentToolResults(continuation.receivedResults) }),
        ...(continuation.waitingApproval === undefined
          ? {}
          : { waitingApproval: continuation.waitingApproval }),
      };
    case "AWAITING_VERIFICATION":
      return {
        type: "AWAITING_VERIFICATION",
        runId: continuation.runId,
        sourceStepId: continuation.sourceStepId,
        verificationPlanId: continuation.verificationPlanId,
        finalDecision: continuation.finalDecision,
      };
    case "WAITING_VERIFICATION_REPAIR":
      return {
        type: "WAITING_VERIFICATION_REPAIR",
        runId: continuation.runId,
        failedPlanId: continuation.failedPlanId,
        sourceStepId: continuation.sourceStepId,
        failedCheckIds: continuation.failedCheckIds,
        evidenceIds: continuation.evidenceIds,
        repairCycle: continuation.repairCycle,
      };
    case "WAITING_RESOURCE":
      return {
        type: "WAITING_RESOURCE",
        runId: continuation.runId,
        sourceStepId: continuation.sourceStepId,
        pendingDecision: continuation.pendingDecision,
        reason: continuation.reason,
        replanCount: continuation.replanCount,
      };
    case "WAITING_RETRY":
      return continuation.mode === "START"
        ? {
            type: "WAITING_RETRY",
            runId: continuation.runId,
            failedStepId: continuation.failedStepId,
            attempt: continuation.attempt,
            maxAttempts: continuation.maxAttempts,
            nextAttemptAt: continuation.nextAttemptAt,
            errorCode: continuation.errorCode,
            mode: "START",
          }
        : {
            type: "WAITING_RETRY",
            runId: continuation.runId,
            failedStepId: continuation.failedStepId,
            attempt: continuation.attempt,
            maxAttempts: continuation.maxAttempts,
            nextAttemptAt: continuation.nextAttemptAt,
            errorCode: continuation.errorCode,
            mode: "TOOL_RESULTS",
            pendingDecision: continuation.pendingDecision,
            receivedResults: toAgentToolResults(continuation.receivedResults),
            ...(continuation.sourceStepId === undefined
              ? {}
              : { sourceStepId: continuation.sourceStepId }),
          };
    default:
      throw new Error("Run continuation has no canonical projection.");
  }
}

/**
 * Project durable Tool results onto the frozen AI tool-result contract.
 *
 * The legacy record may carry a raw-artifact reference for full-output recovery. That reference is
 * a Tool Layer detail and is deliberately not part of the model-facing contract; everything the
 * model sees — identity, tool name, content and the error flag — crosses unchanged and in order.
 */
function toAgentToolResults(
  results: readonly LLMToolResultMessage[],
): readonly import("@caelush/ai").AIToolResultMessage[] {
  return results.map((result) => {
    const projected = toAIMessage(result);
    if (projected.role !== "tool") {
      throw new Error("A durable tool result must project onto an AI tool result message.");
    }
    return projected;
  });
}

/** Project a durable conversation entry onto the frozen AI message contract. */
function toAgentConversation(
  conversation: RunExecutionSnapshot["conversation"],
): readonly RunConversationEntry[] {
  return conversation.map((entry) => ({
    runId: entry.runId,
    sequence: entry.sequence,
    ...(entry.sourceStepId === undefined ? {} : { sourceStepId: entry.sourceStepId }),
    createdAt: entry.createdAt,
    message: toAIMessage(entry.message),
  }));
}

/**
 * Project the Run Layer's durable record onto the canonical execution snapshot.
 *
 * The Run Layer keeps its own richer record — the verification plan is a coding-verification
 * concern, and a legacy message encoding is what the storage adapter persists — so this projection
 * takes exactly what the general Run domain is entitled to see.
 */
export function toAgentExecutionSnapshot(snapshot: RunExecutionSnapshot): AgentExecutionSnapshot {
  return {
    run: snapshot.run,
    ...(snapshot.state === undefined ? {} : { state: snapshot.state }),
    ...(snapshot.stateRevision === undefined ? {} : { stateRevision: snapshot.stateRevision }),
    ...(snapshot.activeStep === undefined ? {} : { activeStep: snapshot.activeStep }),
    conversation: toAgentConversation(snapshot.conversation),
    ...(snapshot.continuation === undefined
      ? {}
      : { continuation: toAgentContinuation(snapshot.continuation) }),
    ...(snapshot.continuationRevision === undefined
      ? {}
      : { continuationRevision: snapshot.continuationRevision }),
    ...(snapshot.cancellationIntent === undefined
      ? {}
      : { cancellationIntent: snapshot.cancellationIntent }),
  };
}

/** Re-exported so the Run Layer names the same statuses the coordinator routes on. */
export type { AgentRun };
