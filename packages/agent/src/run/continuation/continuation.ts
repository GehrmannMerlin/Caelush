import type { AIToolResultMessage } from "@caelush/ai";
import type {
  ApprovalRequestId,
  RunId,
  StepId,
  TimestampMs,
  ToolInvocationId,
  ToolName,
  VerificationCheckId,
  VerificationEvidenceId,
  VerificationPlanId,
} from "@caelush/protocol";

import type {
  AgentFinalCandidateDecision,
  AgentToolCallsDecision,
} from "../../loop/decision/decision.js";
import type { ToolObservationPolicySnapshot } from "../../loop/types.js";

/**
 * The durable Run continuation domain.
 *
 * A continuation is what a Run holds while it is *not* executing: the semantic input a restart
 * needs in order to resume the same work rather than guess at it. It is Agent-owned because every
 * one of its discriminants is a statement about a model turn or a Tool turn, not about this
 * host's storage or its coding subsystems.
 *
 * ```text
 * WAITING_TOOL_RESULTS          the model asked for Tools and they are not all answered
 * AWAITING_VERIFICATION         a final candidate is waiting for a completion decision
 * WAITING_VERIFICATION_REPAIR   the completion decision asked this Run to try again
 * WAITING_RESOURCE              execution paused on a resource decision
 * WAITING_STEERING             a complete answer deferred for accepted user corrections
 * WAITING_RETRY                 a retryable provider failure is waiting for its next attempt
 * ```
 *
 * The discriminants are the durable spellings and are deliberately not renamed: they are already
 * persisted, and a rename would be a schema migration wearing a refactor's clothes.
 *
 * Every message-shaped field is an `AIMessage` contract. Nothing here knows about a legacy
 * durable message encoding, a storage row or a provider payload — the storage adapter is what
 * projects between this domain and the bytes it keeps.
 */

/** A Run waiting for the Tool results its model turn requested. */
export interface WaitingToolResultsContinuation {
  readonly type: "WAITING_TOOL_RESULTS";
  readonly runId: RunId;
  /**
   * The durable Step that requested these Tools.
   *
   * It is the resume provenance: a recovery re-opens *this* Step's turn, never the Step of an
   * attempt that failed and never a model call identity.
   */
  readonly sourceStepId: StepId;
  readonly pendingDecision: AgentToolCallsDecision;
  readonly receivedResults?: readonly AIToolResultMessage[] | undefined;
  /**
   * The observation policy the requesting turn was prepared under.
   *
   * Snapshotted so a later Tool projection uses the policy that was in force when the turn was
   * prepared, rather than whatever a restarted process happens to default to. Absent on a
   * continuation written before the field existed; the projection layer decides that fallback,
   * not this contract.
   */
  readonly observationPolicy?: ToolObservationPolicySnapshot | undefined;
  readonly waitingApproval?:
    | {
        readonly invocationId: ToolInvocationId;
        readonly approvalId?: ApprovalRequestId | undefined;
        readonly externalCallId: string;
        readonly toolName: ToolName;
      }
    | undefined;
}

/** A final candidate waiting for a completion decision. */
export interface AwaitingVerificationContinuation {
  readonly type: "AWAITING_VERIFICATION";
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly verificationPlanId: VerificationPlanId;
  readonly finalDecision: AgentFinalCandidateDecision;
}

/** The completion decision asked this same Run to repair and try again. */
export interface WaitingVerificationRepairContinuation {
  readonly type: "WAITING_VERIFICATION_REPAIR";
  readonly runId: RunId;
  readonly failedPlanId: VerificationPlanId;
  readonly sourceStepId: StepId;
  readonly failedCheckIds: readonly VerificationCheckId[];
  readonly evidenceIds: readonly VerificationEvidenceId[];
  readonly repairCycle: number;
}

/**
 * A Run whose model answer was complete, but which owes the user's accepted corrections first.
 *
 * The answer that would have ended the Run was settled as commentary and the corrections were
 * recorded as canonical USER messages in the *same* transaction. This checkpoint is the durable
 * fact that those messages are the next turn's input: consuming it is what opens the next Step,
 * and a restart re-reads it instead of guessing that the Run simply finished.
 *
 * Every message here is already durable. The checkpoint carries IDs, never text and never a
 * provider message array, so it cannot become a second conversation authority.
 */
export interface WaitingSteeringContinuation {
  readonly type: "WAITING_STEERING";
  readonly runId: RunId;
  /** The Step whose answer was deferred by this boundary. */
  readonly sourceStepId: StepId;
  /** The canonical STEERING USER messages the next model turn must carry, in order. */
  readonly messageIds: readonly string[];
}

/** Execution paused on a resource or side-effect reconciliation decision. */
export type WaitingResourceContinuation =
  | {
      readonly type: "WAITING_RESOURCE";
      readonly runId: RunId;
      readonly sourceStepId: StepId;
      readonly pendingDecision: AgentToolCallsDecision;
      readonly reason: "NO_PROGRESS";
      readonly replanCount: number;
    }
  | {
      readonly type: "WAITING_RESOURCE";
      readonly runId: RunId;
      readonly sourceStepId: StepId;
      readonly pendingDecision: AgentToolCallsDecision;
      readonly reason: "EFFECT_UNCONFIRMED";
      readonly observationPolicy?: ToolObservationPolicySnapshot | undefined;
      readonly invocationId: ToolInvocationId;
      readonly toolName: ToolName;
      readonly reasonCode: "DOES_NOT_MATCH" | "INCONCLUSIVE" | "UNSUPPORTED" | "UNAVAILABLE";
    };

/** Provider failures that may enter cooldown and transport recovery. */
export type ProviderRetryErrorCode = "LLM_RATE_LIMIT" | "LLM_NETWORK" | "LLM_TIMEOUT";

/** The durable retry error spellings, including the bounded output recovery retry. */
export type RetryErrorCode = ProviderRetryErrorCode | "LLM_OUTPUT_TRUNCATED";

/** A bounded transport identity snapshot carried across a durable retry boundary. */
export interface ModelTransportRecoveryCheckpoint {
  readonly currentTransportId: string;
  readonly attemptedTransportIds: readonly string[];
}

interface WaitingRetryContinuationBase {
  readonly type: "WAITING_RETRY";
  readonly runId: RunId;
  /**
   * The Step of the attempt that failed.
   *
   * Deliberately not the resume provenance: a retry of a Tool resume must re-open the Step that
   * *requested* the Tools, which is carried separately below.
   */
  readonly failedStepId: StepId;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Number of provider retry episodes already entered (first episode is 1). */
  readonly episode?: number | undefined;
  /** Total provider requests that failed across all episodes; never reset on episode rotation. */
  readonly totalAttempts?: number | undefined;
  readonly nextAttemptAt: TimestampMs;
  readonly errorCode: RetryErrorCode;
  /** Optional for backward decoding of checkpoints written before transport recovery. */
  readonly transport?: ModelTransportRecoveryCheckpoint | undefined;
}

export type WaitingRetryContinuation =
  | (WaitingRetryContinuationBase & {
      readonly mode: "START";
      readonly pendingDecision?: never;
      readonly receivedResults?: never;
      readonly sourceStepId?: undefined;
    })
  | (WaitingRetryContinuationBase & {
      readonly mode: "TOOL_RESULTS";
      readonly pendingDecision: AgentToolCallsDecision;
      readonly receivedResults: readonly AIToolResultMessage[];
      /**
       * The Step that requested the Tools this retry is resuming with.
       *
       * Optional because the field arrived after the shape did: a checkpoint written by an
       * earlier build does not contain it, and the decoder distinguishes "absent" from "present
       * but undefined". Recovery either determines it from the durable ledger or fails closed.
       */
      readonly sourceStepId?: StepId | undefined;
      readonly observationPolicy?: ToolObservationPolicySnapshot | undefined;
    })
  | (WaitingRetryContinuationBase & {
      /**
       * A steering turn that failed and will be resent.
       *
       * The messages are already durable, so the retry re-uses the same IDs instead of appending a
       * second correction. Without this arm a failed steering turn would have to resume from
       * `START`, which re-derives the original goal and loses the reason the turn ran at all.
       */
      readonly mode: "STEERING";
      readonly messageIds: readonly string[];
      /** The Step whose deferred answer created the steering boundary. */
      readonly sourceStepId: StepId;
      readonly pendingDecision?: never;
      readonly receivedResults?: never;
    });

type ReplaceContinuationType<T, Type extends string> = T extends { readonly type: string }
  ? Omit<T, "type"> & { readonly type: Type }
  : never;

type NarrowRetryErrorCode<T> = T extends { readonly errorCode: RetryErrorCode }
  ? Omit<T, "errorCode"> & { readonly errorCode: ProviderRetryErrorCode }
  : never;

/** A durable wait after one provider retry episode is exhausted. */
export type WaitingProviderContinuation = NarrowRetryErrorCode<
  ReplaceContinuationType<WaitingRetryContinuation, "WAITING_PROVIDER">
>;

/** Every durable continuation a Run may hold. */
export type RunContinuationCheckpoint =
  | WaitingToolResultsContinuation
  | AwaitingVerificationContinuation
  | WaitingVerificationRepairContinuation
  | WaitingResourceContinuation
  | WaitingSteeringContinuation
  | WaitingProviderContinuation
  | WaitingRetryContinuation;

/** Every durable continuation discriminant, in canonical order. */
export const RUN_CONTINUATION_TYPES = [
  "WAITING_TOOL_RESULTS",
  "AWAITING_VERIFICATION",
  "WAITING_VERIFICATION_REPAIR",
  "WAITING_RESOURCE",
  "WAITING_STEERING",
  "WAITING_PROVIDER",
  "WAITING_RETRY",
] as const satisfies readonly RunContinuationCheckpoint["type"][];

/** The continuation kinds a *running* Run holds, as opposed to one it parks on before settling. */
export const RUNNING_CONTINUATION_TYPES = [
  "WAITING_TOOL_RESULTS",
  "WAITING_VERIFICATION_REPAIR",
  "WAITING_RESOURCE",
  "WAITING_STEERING",
  "WAITING_PROVIDER",
  "WAITING_RETRY",
] as const satisfies readonly RunContinuationCheckpoint["type"][];

/** Whether a continuation is a boundary a running Run holds. */
export function isRunningContinuation(
  continuation: RunContinuationCheckpoint | undefined,
): boolean {
  if (continuation === undefined) return false;
  return (RUNNING_CONTINUATION_TYPES as readonly string[]).includes(continuation.type);
}
