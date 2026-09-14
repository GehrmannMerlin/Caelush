import type { RunContinuationCheckpoint as AgentContinuation } from "@caelush/agent";
import type { z } from "zod";
import type { RunContinuationCheckpoint as DurableContinuation } from "./agent-continuation.js";
import { RunContinuationCheckpointSchema } from "./agent-continuation-schema.js";
import { toAgentAIMessage, toLegacyDurableMessage } from "./run-message-compatibility.js";

/**
 * The Run continuation compatibility codec.
 *
 * ```text
 * RunContinuationCheckpoint   @caelush/agent   the canonical durable continuation domain
 * RunContinuationCheckpoint   @caelush/core    the persisted spelling of the same checkpoints
 * ```
 *
 * The two carry the same discriminants and the same semantic fields; they differ in exactly one
 * place, the message payload — canonical `AIMessage` against the persisted legacy encoding. This
 * file is the only translator, and it is a projection in both directions:
 *
 * ```text
 * it never invents a checkpoint, a Step, a revision or a timestamp
 * it never re-derives a resume provenance the record does not already state
 * it never drops a discriminant: every variant is projected explicitly
 * ```
 *
 * The one persisted field with no canonical counterpart is `rawArtifactRef` on a Tool result; see
 * {@link toAgentAIMessage}. It is dropped by the canonical projection by design, not by omission.
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
        pendingDecision: checkpoint.pendingDecision,
        ...(checkpoint.receivedResults === undefined
          ? {}
          : {
              receivedResults: checkpoint.receivedResults.map(toLegacyDurableMessage).map(asTool),
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
        finalDecision: checkpoint.finalDecision,
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
      return {
        type: "WAITING_RESOURCE",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        pendingDecision: checkpoint.pendingDecision,
        reason: checkpoint.reason,
        replanCount: checkpoint.replanCount,
      };
    case "WAITING_RETRY":
      return checkpoint.mode === "START"
        ? {
            type: "WAITING_RETRY",
            mode: "START",
            runId: checkpoint.runId,
            failedStepId: checkpoint.failedStepId,
            attempt: checkpoint.attempt,
            maxAttempts: checkpoint.maxAttempts,
            nextAttemptAt: checkpoint.nextAttemptAt,
            errorCode: checkpoint.errorCode,
          }
        : {
            type: "WAITING_RETRY",
            mode: "TOOL_RESULTS",
            runId: checkpoint.runId,
            failedStepId: checkpoint.failedStepId,
            attempt: checkpoint.attempt,
            maxAttempts: checkpoint.maxAttempts,
            nextAttemptAt: checkpoint.nextAttemptAt,
            errorCode: checkpoint.errorCode,
            pendingDecision: checkpoint.pendingDecision,
            receivedResults: checkpoint.receivedResults.map(toLegacyDurableMessage).map(asTool),
            ...(checkpoint.sourceStepId === undefined
              ? {}
              : { sourceStepId: checkpoint.sourceStepId }),
            ...(checkpoint.observationPolicy === undefined
              ? {}
              : { observationPolicy: checkpoint.observationPolicy }),
          };
    default:
      return assertNever(checkpoint, "canonical continuation");
  }
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
export function toAgentContinuation(checkpoint: DurableContinuation): AgentContinuation {
  switch (checkpoint.type) {
    case "WAITING_TOOL_RESULTS":
      return {
        type: "WAITING_TOOL_RESULTS",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        pendingDecision: checkpoint.pendingDecision,
        ...(checkpoint.receivedResults === undefined
          ? {}
          : { receivedResults: checkpoint.receivedResults.map(toAgentAIMessage).map(asTool) }),
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
        finalDecision: checkpoint.finalDecision,
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
      return {
        type: "WAITING_RESOURCE",
        runId: checkpoint.runId,
        sourceStepId: checkpoint.sourceStepId,
        pendingDecision: checkpoint.pendingDecision,
        reason: checkpoint.reason,
        replanCount: checkpoint.replanCount,
      };
    case "WAITING_RETRY":
      return checkpoint.mode === "START"
        ? {
            type: "WAITING_RETRY",
            mode: "START",
            runId: checkpoint.runId,
            failedStepId: checkpoint.failedStepId,
            attempt: checkpoint.attempt,
            maxAttempts: checkpoint.maxAttempts,
            nextAttemptAt: checkpoint.nextAttemptAt,
            errorCode: checkpoint.errorCode,
          }
        : {
            type: "WAITING_RETRY",
            mode: "TOOL_RESULTS",
            runId: checkpoint.runId,
            failedStepId: checkpoint.failedStepId,
            attempt: checkpoint.attempt,
            maxAttempts: checkpoint.maxAttempts,
            nextAttemptAt: checkpoint.nextAttemptAt,
            errorCode: checkpoint.errorCode,
            pendingDecision: checkpoint.pendingDecision,
            receivedResults: checkpoint.receivedResults.map(toAgentAIMessage).map(asTool),
            ...(checkpoint.sourceStepId === undefined
              ? {}
              : { sourceStepId: checkpoint.sourceStepId }),
            ...(checkpoint.observationPolicy === undefined
              ? {}
              : { observationPolicy: checkpoint.observationPolicy }),
          };
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
function asTool<T extends { readonly role: string }>(message: T): Extract<T, { role: "tool" }> {
  if (message.role !== "tool") {
    throw new TypeError(`A continuation can only hold Tool results, received "${message.role}"`);
  }
  return message as Extract<T, { role: "tool" }>;
}

/** Exhaustiveness guard: a new discriminant must break the build rather than lose a checkpoint. */
function assertNever(value: never, what: string): never {
  throw new TypeError(`Unsupported ${what}: ${JSON.stringify(value)}`);
}
