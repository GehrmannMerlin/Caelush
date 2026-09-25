import type {
  AIMessage,
  AIModelSettings,
  AIToolSpec,
  ModelDescriptor,
  ModelUsage,
} from "@caelush/ai";
import type { AgentError, RunId, SessionId, StepId } from "@caelush/protocol";

import type {
  AgentFinalCandidateDecision,
  AgentModelTurn,
  AgentToolCallsDecision,
} from "./decision/decision.js";
import type { ModelTurnExecutionErrorCode } from "./turn/model-turn-error.js";
import type { AgentConversationSnapshot } from "../messages/conversation/conversation-snapshot.js";
import type { AgentMessageId } from "../messages/types/ids.js";

/**
 * The frozen Agent Kernel contracts of Architecture V2.
 *
 * The kernel knows three things: **who** is reasoning, **what** this turn is, and
 * **what** it decided. Everything a coding agent adds on top — workspace, runtime,
 * permissions, verification — is a port the host injects, never a field here.
 */

/* ------------------------------------------------------------------ identity */

/**
 * Who is reasoning.
 *
 * The identity is the stable handle a durable boundary needs. `runId` and `sessionId`
 * are the Run Layer's own identifiers and `goal` is the task statement the Run was
 * created with; the loop never invents any of them.
 *
 * Deliberately excluded, and each for its own reason:
 *
 * ```text
 * workspace   the Context Engine and the Tool Layer own where work happens
 * runtime     execution substrate selection belongs to the Run Layer
 * permission  authorization belongs to the Security boundary
 * conversationTurnId / branchId
 *             Session System V2 is a separate migration
 * ```
 */
export interface AgentExecutionIdentity {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly goal: string;
}

/* --------------------------------------------------------------- turn refs */

/**
 * One model turn's position in a durable Run.
 *
 * `stepId` is allocated by the Run Layer. The loop never mints a Step identifier and
 * owns no identifier factory: one model turn is one durable AgentStep, and the layer
 * that persists that step is the layer that names it.
 *
 * `sequence` is the durable step sequence, which is `>= 1` because a Run's first turn
 * is step 1. Zero, negative and non-integer sequences are rejected at the boundary
 * rather than stored.
 */
export interface AgentTurnRef {
  readonly stepId: StepId;
  readonly sequence: number;
}

/** Assert the frozen turn-ref invariant: an integer sequence of at least 1. */
export function assertAgentTurnRef(value: unknown): asserts value is AgentTurnRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Agent turn ref must be an object, received ${describeValue(value)}.`);
  }
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.stepId !== "string" || candidate.stepId.length === 0) {
    throw new TypeError(
      `Agent turn ref stepId must be a non-empty string, received ${describeValue(candidate.stepId)}.`,
    );
  }
  const sequence = candidate.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError(
      `Agent turn ref sequence must be a safe integer >= 1, received ${describeValue(sequence)}.`,
    );
  }
}

/** Create a validated turn ref. */
export function createAgentTurnRef(stepId: StepId, sequence: number): AgentTurnRef {
  const turn: AgentTurnRef = { stepId, sequence };
  assertAgentTurnRef(turn);
  return turn;
}

/* ------------------------------------------------------------- turn input */

/**
 * What the loop reasons about for exactly one turn.
 *
 * The union is the whole input surface, and it is intentionally narrow. The loop never
 * derives a user message from `identity.goal`: real user input arrives as an explicit
 * `USER_INPUT`, so "the goal" and "what the user just said" can never be conflated.
 *
 * Deliberately excluded: `cwd`, `workspace`, `explicitPaths`, `verificationPlan`,
 * `projectFacts`, `runtime`. Each of those is how a *coding* host describes its
 * environment; a general agent kernel receives the result of that knowledge through
 * the Context Engine port instead.
 */
export type AgentTurnInput =
  | {
      readonly kind: "USER_INPUT";
      /** The durable USER record this turn is about. */
      readonly userMessageId: AgentMessageId;
    }
  | {
      readonly kind: "TOOL_RESULTS";
      readonly sourceStepId: StepId;
      readonly pendingDecision: AgentToolCallsDecision;
      /** Durable TOOL_RESULT records, in the exact requested-call order. */
      readonly toolResultMessageIds: readonly AgentMessageId[];
    }
  | {
      readonly kind: "CONTINUATION";
      readonly reason: "VERIFICATION_REPAIR" | "STEERING";
      /** Optional durable message references supplied by a steering/recovery boundary. */
      readonly messageIds?: readonly AgentMessageId[];
    };

/**
 * Why the loop is being continued without new user input.
 *
 * `STEERING` is a frozen reason with no wired behaviour yet: the contract exists so a
 * later Steering System has a stable discriminant, and the loop must not invent a
 * larger continuation taxonomy in the meantime.
 */
export type AgentContinuationReason = "VERIFICATION_REPAIR" | "STEERING";

/* --------------------------------------------------------- prepared context */

/**
 * Priority class of one prepared context item.
 *
 * A structural rank, not a policy: the Context Engine decides what a class means for a
 * given model budget. It lives here so the general loop can order items without
 * knowing anything about a project, a file or a workspace.
 */
export type ContextItemPriorityClass = "CRITICAL" | "HIGH" | "NORMAL" | "OPTIONAL";

/**
 * One piece of context contributed through the pre-7A Provider compatibility seam.
 *
 * Text only. The loop must never receive a project snapshot, a Git state, a file list
 * or a workspace path through this contract: a legacy adapter may hold those as
 * compatibility diagnostics, but they do not cross into the general kernel.
 */
export interface LegacyContextItem {
  /** Stable identity of the item, for provenance and deduplication. */
  readonly id: string;
  readonly priorityClass: ContextItemPriorityClass;
  /** The already-rendered text this item contributes to the model input. */
  readonly content: string;
  /** Estimated tokens, provider-independent planning metadata rather than billing truth. */
  readonly tokenEstimate?: number;
  /** Why this item was included, for diagnostics. Never model-facing on its own. */
  readonly whyLoaded?: string;
}

/**
 * How much pressure the prepared context is under.
 *
 * A structural classification the Context Engine owns, not a compaction policy the loop
 * may act on: the kernel reports the pressure it was handed and never decides to compact.
 */
export type ContextPressure = "NORMAL" | "PROACTIVE" | "EMERGENCY";

/**
 * What one context contributor put into the model input.
 *
 * `providerId` is the Context Engine's own stable contributor label. The kernel carries
 * it opaquely: it never learns what a contributor is, only how much it contributed.
 */
export interface ContextBuildContribution {
  readonly providerId: string;
  readonly tokenEstimate: number;
  readonly itemCount: number;
  readonly droppedItems: number;
  readonly truncatedItems: number;
}

/**
 * The Context Engine's build report, as the general kernel sees it.
 *
 * This is a typed contract, not an opaque bag: the fields below are the whole report,
 * and a host that needs project, workspace or provider diagnostics keeps them inside its
 * own Context Engine implementation rather than smuggling them through here.
 */
export interface ContextBuildReport {
  readonly estimatedInputTokens: number;

  readonly effectiveInputLimitTokens: number;

  readonly remainingTokens: number;

  readonly pressure: ContextPressure;

  readonly compactionCount: number;

  readonly contributions: readonly ContextBuildContribution[];
}

/**
 * The observation policy a tool result must be projected under.
 *
 * It is carried in the prepared context so the Run Layer can snapshot it durably when a
 * Tool boundary opens: a later continuation must project results under the policy that
 * was in force when the turn was prepared, not under whatever a restarted process
 * happens to default to.
 *
 * The shape stays exactly two members. Phase 5B needed this value to travel inside durable JSON, which
 * `JsonObject` expresses as an index signature, and that signature would widen `keyof` and change this
 * frozen Phase 3 contract. The Message Domain therefore represents the snapshot as an explicit
 * JSON-safe mirror at the point where it enters a record, rather than the snapshot type being widened
 * here.
 */
export interface ToolObservationPolicySnapshot {
  readonly maxSingleObservationTokens: number;

  readonly maxObservationBatchTokens: number;
}

/** A durable context checkpoint reference. Opaque to the loop. */
export interface ContextCheckpointRef {
  readonly id: string;
}

/**
 * The Context Engine's answer for one turn.
 *
 * This is what the Model Request Builder consumes and the Model Turn Boundary commits
 * against. Every field is typed: the report states the budget the context was built
 * under, and the observation policy travels with it so a durable Tool boundary can
 * snapshot the policy that was in force.
 */
export interface PreparedModelContext {
  readonly messages: readonly AIMessage[];

  readonly report: ContextBuildReport;

  readonly observationPolicy: ToolObservationPolicySnapshot;

  /** A durable checkpoint reference, when the Context Engine produced one. */
  readonly checkpoint?: ContextCheckpointRef;

  /** A stable digest of the prepared context, for recovery comparisons. */
  readonly contextFingerprint?: string;
}

/**
 * What the context cost this Reason, carried by every result that prepared one.
 *
 * `recovery` is where a forced re-preparation is recorded — not on the prepared context
 * itself. A Context Engine that cannot compact a rejected context must reject the
 * `FORCED_RECOVERY` preparation instead of answering with a context that does not fit,
 * because the loop may only spend a second provider attempt on a context that really
 * differs from the one that overflowed.
 */
export interface AgentLoopContextReceipt {
  readonly report: ContextBuildReport;

  readonly observationPolicy: ToolObservationPolicySnapshot;

  readonly recovery: "NONE" | "FORCED_CONTEXT_RECOVERY";
}

/* -------------------------------------------------------------- decisions */

/**
 * The decision contract lives in `loop/decision/decision.ts`, which is its canonical home.
 * It is re-exported here so a consumer can name the whole kernel from one module.
 */
export type {
  AgentDecision,
  AgentFinalCandidateDecision,
  AgentModelTurn,
  AgentToolCallsDecision,
  AgentToolRequest,
} from "./decision/decision.js";

/* --------------------------------------------------------- advance contract */

/**
 * The frozen input of `AgentLoop.advance()`.
 *
 * One call performs exactly one Reason. The loop has no `while`, so it cannot execute a
 * tool, and it holds no Run status, Step lifecycle, clock or identifier factory: step
 * identity arrives in `turn` and cancellation arrives in `signal`.
 *
 * Deliberately absent: `settings` (the field is `modelSettings`, and a rename is not a
 * compatible change) and `streamSink`. Live deltas are a `ModelTurnExecutor` concern:
 * the composition root binds a sink by decorating the executor, so presentation never
 * becomes an input of the general loop.
 */
export interface AgentLoopAdvanceInput {
  readonly identity: AgentExecutionIdentity;

  readonly turn: AgentTurnRef;

  /** The validated durable conversation snapshot used by Context and replay. */
  readonly conversation: AgentConversationSnapshot;

  readonly input: AgentTurnInput;

  readonly model: ModelDescriptor;

  readonly tools: readonly AIToolSpec[];

  readonly modelSettings?: AIModelSettings;

  readonly signal: AbortSignal;
}

/* ------------------------------------------------------------- retry metadata */

/**
 * A transient provider condition, in the frozen kernel vocabulary.
 *
 * It reports what the provider already said and decides nothing: the Agent Loop never
 * sleeps, retries or backs off, and the Run Retry Layer owns the durable decision.
 */
export interface AgentRetryMetadata {
  readonly code: ModelTurnExecutionErrorCode;

  readonly retryable: boolean;

  readonly retryAfterMs?: number;
}

/* -------------------------------------------------------------- advance result */

/** What every successful Reason carries, whatever it decided. */
export interface AgentLoopSuccessBase {
  readonly turn: AgentTurnRef;

  readonly modelTurn: AgentModelTurn;

  readonly messagesToAppend: readonly AIMessage[];

  readonly context: AgentLoopContextReceipt;
}

/** The model asked for tools, and the Reason stops at the Tool boundary. */
export interface AgentLoopToolRequestsResult extends AgentLoopSuccessBase {
  readonly kind: "TOOL_REQUESTS";

  readonly decision: AgentToolCallsDecision;
}

/**
 * The model produced an answer that may become completion.
 *
 * A final candidate is only a candidate: the Run Layer moves it toward verification. No
 * shape here can express "the Run completed", which is what keeps completion authority
 * outside the kernel.
 */
export interface AgentLoopFinalCandidateResult extends AgentLoopSuccessBase {
  readonly kind: "FINAL_CANDIDATE";

  readonly decision: AgentFinalCandidateDecision;
}

/**
 * The Reason failed.
 *
 * `error` is the canonical Protocol `AgentError`, produced by exactly one deterministic
 * projection from the model-turn failure vocabulary. The two are deliberately distinct
 * concepts: a failed *model turn* is an input of this result, not the result itself.
 *
 * The failure's *stage* is not a public field. Where a Reason failed is something the
 * caller already knows, because the caller owns the ports the loop called in order.
 */
export interface AgentLoopFailedResult {
  readonly kind: "FAILED";

  readonly turn: AgentTurnRef;

  /** The settled turn, when the provider answered and the answer was unusable. */
  readonly modelTurn?: AgentModelTurn;

  readonly error: AgentError;

  readonly retry?: AgentRetryMetadata;

  readonly usage?: ModelUsage;

  readonly messagesToAppend: readonly AIMessage[];

  /** Absent when the Reason failed before any context was prepared. */
  readonly context?: AgentLoopContextReceipt;
}

/**
 * The turn was cancelled. Cancellation is not a failure.
 *
 * A cancelled Reason contributes no appendable message: partial assistant output is
 * discarded, and the caller's own input is not this Reason's output.
 */
export interface AgentLoopCancelledResult {
  readonly kind: "CANCELLED";

  readonly turn: AgentTurnRef;

  readonly messagesToAppend: readonly AIMessage[];

  /** Absent when the turn was cancelled before any context was prepared. */
  readonly context?: AgentLoopContextReceipt;
}

/**
 * What one `advance()` produced.
 *
 * There is no `COMPLETED`-the-Run variant and no `VERIFYING` variant: the loop reports a
 * decision, and what that decision means for a Run is the Run Layer's to decide.
 */
export type AgentLoopAdvanceResult =
  | AgentLoopToolRequestsResult
  | AgentLoopFinalCandidateResult
  | AgentLoopFailedResult
  | AgentLoopCancelledResult;

/** Every frozen advance-result discriminator, in canonical order. */
export const AGENT_LOOP_ADVANCE_RESULT_KINDS = [
  "TOOL_REQUESTS",
  "FINAL_CANDIDATE",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly AgentLoopAdvanceResult["kind"][];

/* ---------------------------------------------------------------- helpers */

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
