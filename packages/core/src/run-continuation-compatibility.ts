import type {
  AIModelTurnAssistantItem,
  AIToolResultContent,
  AIToolResultMessage,
} from "@caelush/ai";
import type {
  AgentModelTurn,
  AgentToolCallsDecision,
  RunContinuationCheckpoint as AgentContinuation,
} from "@caelush/agent";
import type { z } from "zod";
import type { RunContinuationCheckpoint as DurableContinuation } from "./agent-continuation.js";
import {
  AgentToolCallsDecisionSchema,
  RunContinuationCheckpointSchema,
} from "./agent-continuation-schema.js";
import { toTextOnlyAIToolResultContent } from "./ai-message-content.js";

/**
 * The Run continuation compatibility codec.
 *
 * ```text
 * RunContinuationCheckpoint   @caelush/agent   the canonical durable continuation domain
 * RunContinuationCheckpoint   @caelush/core    the persisted spelling of the same checkpoints
 * ```
 *
 * The two carry the same discriminants and the same semantic fields; they differ in exactly one
 * place, the message payload is validated as the canonical `AIToolResultMessage` in both domains.
 * This file remains a structural codec for checkpoint evolution:
 *
 * ```text
 * it never invents a checkpoint, a Step, a revision or a timestamp
 * it never re-derives a resume provenance the record does not already state
 * it never drops a discriminant: every variant is projected explicitly
 * ```
 *
 */

/**
 * Project a canonical continuation onto the persisted encoding.
 *
 * The result is a *claim*: {@link parseDurableContinuation} is what decides whether the claim is a
 * legal durable record.
 */
export function toDurableContinuation(checkpoint: AgentContinuation): DurableContinuation {
  switch (checkpoint.type) {
    case "WAITING_TOOL_RESULTS":
      return {
        type: "WAITING_TOOL_RESULTS",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        pendingDecision: canonicalPendingDecision(checkpoint.pendingDecision),
        ...(checkpoint.receivedResults === undefined
          ? {}
          : {
              receivedResults: checkpoint.receivedResults.map(asTool),
            }),
        ...(checkpoint.observationPolicy === undefined
          ? {}
          : { observationPolicy: checkpoint.observationPolicy }),
        ...(checkpoint.waitingApproval === undefined
          ? {}
          : { waitingApproval: checkpoint.waitingApproval }),
      };
    case "AWAITING_VERIFICATION":
      return {
        type: "AWAITING_VERIFICATION",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        verificationPlanId: checkpoint.verificationPlanId,
        finalDecision: {
          ...checkpoint.finalDecision,
          modelTurn: ensureAssistantItems(checkpoint.finalDecision.modelTurn),
        },
      };
    case "WAITING_VERIFICATION_REPAIR":
      return {
        type: "WAITING_VERIFICATION_REPAIR",
        runId: checkpoint.runId,
        failedPlanId: checkpoint.failedPlanId,
        sourceStepId: checkpoint.sourceStepId,
        failedCheckIds: checkpoint.failedCheckIds,
        evidenceIds: checkpoint.evidenceIds,
        repairCycle: checkpoint.repairCycle,
      };
    case "WAITING_RESOURCE":
      if (checkpoint.reason === "NO_PROGRESS") {
        return {
          type: "WAITING_RESOURCE",
          runId: checkpoint.runId,
          sourceStepId: checkpoint.sourceStepId,
          pendingDecision: canonicalPendingDecision(checkpoint.pendingDecision),
          reason: "NO_PROGRESS",
          replanCount: checkpoint.replanCount,
        };
      }
      return {
        type: "WAITING_RESOURCE",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        pendingDecision: canonicalPendingDecision(checkpoint.pendingDecision),
        reason: "EFFECT_UNCONFIRMED",
        ...(checkpoint.observationPolicy === undefined
          ? {}
          : { observationPolicy: checkpoint.observationPolicy }),
        invocationId: checkpoint.invocationId,
        toolName: checkpoint.toolName,
        reasonCode: checkpoint.reasonCode,
      };
    case "WAITING_STEERING":
      return {
        type: "WAITING_STEERING",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        messageIds: [...checkpoint.messageIds],
      };
    case "WAITING_PROVIDER":
    case "WAITING_RETRY": {
      const base = {
        type: checkpoint.type,
        runId: checkpoint.runId,
        failedStepId: checkpoint.failedStepId,
        attempt: checkpoint.attempt,
        maxAttempts: checkpoint.maxAttempts,
        ...(checkpoint.episode === undefined ? {} : { episode: checkpoint.episode }),
        ...(checkpoint.totalAttempts === undefined
          ? {}
          : { totalAttempts: checkpoint.totalAttempts }),
        nextAttemptAt: checkpoint.nextAttemptAt,
        errorCode: checkpoint.errorCode,
        ...(checkpoint.transport === undefined ? {} : { transport: checkpoint.transport }),
      };
      switch (checkpoint.mode) {
        case "START":
          return { ...base, mode: "START" };
        case "STEERING":
          return {
            ...base,
            mode: "STEERING",
            messageIds: [...checkpoint.messageIds],
            sourceStepId: checkpoint.sourceStepId,
          };
        case "TOOL_RESULTS":
          return {
            ...base,
            mode: "TOOL_RESULTS",
            pendingDecision: canonicalPendingDecision(checkpoint.pendingDecision),
            receivedResults: checkpoint.receivedResults.map(asTool),
            ...(checkpoint.sourceStepId === undefined
              ? {}
              : { sourceStepId: checkpoint.sourceStepId }),
            ...(checkpoint.observationPolicy === undefined
              ? {}
              : { observationPolicy: checkpoint.observationPolicy }),
          };
        default:
          return assertNever(checkpoint, "canonical retry mode");
      }
    }
    default:
      return assertNever(checkpoint, "canonical continuation");
  }
}

/**
 * The canonical decision of one persisted Tool turn.
 *
 * A checkpoint written before rejected requests could be recorded carries no such list, and that
 * absence is history: it had none. It is projected as an empty list here rather than being treated as
 * "unknown", because inventing a rejection for a historical decision would add a result the model was
 * never owed.
 */
function canonicalPendingDecision(
  decision: AgentToolCallsDecision | z.output<typeof AgentToolCallsDecisionSchema>,
): AgentToolCallsDecision {
  const { rejectedToolRequests: rejected, ...rest } = decision;
  return Object.freeze({
    ...rest,
    modelTurn: ensureAssistantItems(rest.modelTurn),
    // Absence is preserved: a decision with no rejection must round-trip without gaining an empty
    // list, because "no rejected request" and "no record of rejections" are different claims.
    ...(rejected === undefined || rejected.length === 0 ? {} : { rejectedToolRequests: rejected }),
  });
}

function ensureAssistantItems(
  modelTurn: AgentModelTurn,
): AgentModelTurn & { readonly assistantItems: readonly AIModelTurnAssistantItem[] } {
  if (modelTurn.assistantItems !== undefined) {
    return modelTurn as AgentModelTurn & {
      readonly assistantItems: readonly AIModelTurnAssistantItem[];
    };
  }
  return {
    ...modelTurn,
    assistantItems: [
      Object.freeze({
        assistantItemId: `${modelTurn.callId}:item:000`,
        phase: "UNKNOWN",
        content: Object.freeze([...modelTurn.assistantMessage.content]),
      }),
    ],
  };
}

/**
 * Admit a projected continuation into the durable schema.
 *
 * The schema's *inferred input* is stricter than the durable domain in a purely representational
 * way, and in two places: zod infers mutable arrays where the canonical contracts are `readonly`,
 * and it brands the model call ID where the kernel types it as a plain `string`. Neither changes a
 * byte that is persisted, so the reconciliation lives here, beside the one type it reconciles,
 * instead of as an assertion at every call site. Validation itself is not weakened: the same
 * schema still decides, and it still rejects a record it cannot express.
 */
export function parseDurableContinuation(value: DurableContinuation) {
  return RunContinuationCheckpointSchema.parse(
    value as z.input<typeof RunContinuationCheckpointSchema>,
  );
}

/** Project a persisted continuation onto the canonical domain. */
export function toAgentContinuation(
  checkpoint: DurableContinuation | z.output<typeof RunContinuationCheckpointSchema>,
): AgentContinuation {
  switch (checkpoint.type) {
    case "WAITING_TOOL_RESULTS":
      return {
        type: "WAITING_TOOL_RESULTS",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        pendingDecision: canonicalPendingDecision(checkpoint.pendingDecision),
        ...(checkpoint.receivedResults === undefined
          ? {}
          : { receivedResults: checkpoint.receivedResults.map(asTool) }),
        ...(checkpoint.observationPolicy === undefined
          ? {}
          : { observationPolicy: checkpoint.observationPolicy }),
        ...(checkpoint.waitingApproval === undefined
          ? {}
          : { waitingApproval: checkpoint.waitingApproval }),
      };
    case "AWAITING_VERIFICATION":
      return {
        type: "AWAITING_VERIFICATION",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        verificationPlanId: checkpoint.verificationPlanId,
        finalDecision: {
          ...checkpoint.finalDecision,
          modelTurn: ensureAssistantItems(checkpoint.finalDecision.modelTurn),
        },
      };
    case "WAITING_VERIFICATION_REPAIR":
      return {
        type: "WAITING_VERIFICATION_REPAIR",
        runId: checkpoint.runId,
        failedPlanId: checkpoint.failedPlanId,
        sourceStepId: checkpoint.sourceStepId,
        failedCheckIds: checkpoint.failedCheckIds,
        evidenceIds: checkpoint.evidenceIds,
        repairCycle: checkpoint.repairCycle,
      };
    case "WAITING_RESOURCE":
      if (checkpoint.reason === "NO_PROGRESS") {
        return {
          type: "WAITING_RESOURCE",
          runId: checkpoint.runId,
          sourceStepId: checkpoint.sourceStepId,
          pendingDecision: canonicalPendingDecision(checkpoint.pendingDecision),
          reason: "NO_PROGRESS",
          replanCount: checkpoint.replanCount,
        };
      }
      return {
        type: "WAITING_RESOURCE",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        pendingDecision: canonicalPendingDecision(checkpoint.pendingDecision),
        reason: "EFFECT_UNCONFIRMED",
        ...(checkpoint.observationPolicy === undefined
          ? {}
          : { observationPolicy: checkpoint.observationPolicy }),
        invocationId: checkpoint.invocationId,
        toolName: checkpoint.toolName,
        reasonCode: checkpoint.reasonCode,
      };
    case "WAITING_STEERING":
      return {
        type: "WAITING_STEERING",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        messageIds: [...checkpoint.messageIds],
      };
    case "WAITING_PROVIDER":
    case "WAITING_RETRY": {
      const base = {
        type: checkpoint.type,
        runId: checkpoint.runId,
        failedStepId: checkpoint.failedStepId,
        attempt: checkpoint.attempt,
        maxAttempts: checkpoint.maxAttempts,
        ...(checkpoint.episode === undefined ? {} : { episode: checkpoint.episode }),
        ...(checkpoint.totalAttempts === undefined
          ? {}
          : { totalAttempts: checkpoint.totalAttempts }),
        nextAttemptAt: checkpoint.nextAttemptAt,
        errorCode: checkpoint.errorCode,
        ...(checkpoint.transport === undefined ? {} : { transport: checkpoint.transport }),
      };
      switch (checkpoint.mode) {
        case "START":
          return { ...base, mode: "START" };
        case "STEERING":
          return {
            ...base,
            mode: "STEERING",
            messageIds: [...checkpoint.messageIds],
            sourceStepId: checkpoint.sourceStepId,
          };
        case "TOOL_RESULTS":
          return {
            ...base,
            mode: "TOOL_RESULTS",
            pendingDecision: canonicalPendingDecision(checkpoint.pendingDecision),
            receivedResults: checkpoint.receivedResults.map(asTool),
            ...(checkpoint.sourceStepId === undefined
              ? {}
              : { sourceStepId: checkpoint.sourceStepId }),
            ...(checkpoint.observationPolicy === undefined
              ? {}
              : { observationPolicy: checkpoint.observationPolicy }),
          };
        default:
          return assertNever(checkpoint, "persisted retry mode");
      }
    }
    default:
      return assertNever(checkpoint, "persisted continuation");
  }
}

/**
 * A continuation only ever holds Tool results.
 *
 * The role is re-stated rather than asserted away so the projection cannot silently accept a
 * system, user or assistant message in a batch the canonical contract types as Tool results.
 */
function asTool(message: {
  readonly role: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: AIToolResultContent;
  readonly isError: boolean;
}): AIToolResultMessage {
  if (message.role !== "tool") {
    throw new TypeError(`A continuation can only hold Tool results, received "${message.role}"`);
  }
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: toTextOnlyAIToolResultContent(message.content),
    isError: message.isError,
  };
}

/** Exhaustiveness guard: a new discriminant must break the build rather than lose a checkpoint. */
function assertNever(value: never, what: string): never {
  throw new TypeError(`Unsupported ${what}: ${JSON.stringify(value)}`);
}
