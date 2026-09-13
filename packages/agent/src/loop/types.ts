import type { AIMessage, AIModelSettings, AIToolSpec, ModelDescriptor } from "@caelush/ai";
import type { RunId, SessionId, StepId } from "@caelush/protocol";

import type { AgentDecision, AgentToolCallsDecision } from "./decision/decision.js";
import type { ModelTurnStreamSink } from "./events/transient-stream-event.js";
import type { AgentBudgetBlock } from "./ports/model-request-admission.js";
import type { ModelTurnExecutionError } from "./turn/model-turn-error.js";

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
      readonly messages: readonly AIUserInputMessage[];
    }
  | {
      readonly kind: "TOOL_RESULTS";
      readonly sourceStepId: StepId;
      readonly pendingDecision: AgentToolCallsDecision;
      readonly results: readonly AgentToolResultMessage[];
    }
  | {
      readonly kind: "CONTINUATION";
      readonly reason: AgentContinuationReason;
      readonly messages?: readonly AIUserInputMessage[];
    };

/** A user turn message, as carried by the AI message contract. */
export type AIUserInputMessage = Extract<AIMessage, { readonly role: "user" }>;

/** A tool result message, as carried by the AI message contract. */
export type AgentToolResultMessage = Extract<AIMessage, { readonly role: "tool" }>;

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
 * One piece of prepared model context.
 *
 * Text only. The loop must never receive a project snapshot, a Git state, a file list
 * or a workspace path through this contract: a legacy adapter may hold those as
 * compatibility diagnostics, but they do not cross into the general kernel.
 */
export interface ContextItem {
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
 * The Context Engine's answer for one turn.
 *
 * This is what the Model Request Builder consumes and the Model Turn Boundary commits
 * against. `report` is opaque host-facing diagnostics — the loop treats it as data and
 * never reads a field out of it, which is what keeps a coding context implementation
 * from leaking project, Git or workspace semantics into the general loop.
 */
export interface PreparedModelContext {
  readonly messages: readonly AIMessage[];
  readonly report?: Readonly<Record<string, unknown>>;
  /** The observation policy this turn was prepared under, when the host supplied one. */
  readonly observationPolicy?: ObservationPolicySnapshot;
  /** A durable checkpoint reference, when the Context Engine produced one. */
  readonly checkpoint?: ContextCheckpointRef;
  /** A stable digest of the prepared context, for recovery comparisons. */
  readonly contextFingerprint?: string;
  /**
   * Whether a `FORCED_RECOVERY` preparation actually made the context fit.
   *
   * The loop may only spend a second provider attempt on a context that will really differ:
   * if the engine cannot compact, resending the same rejected context would spend an identical
   * provider call for an identical rejection. An engine sets this to `true` when it produced a
   * smaller context; anything else — `false` or absent — means the loop must fail closed as
   * context exhaustion without a second attempt.
   */
  readonly recovered?: boolean;
}

/** A durable context checkpoint reference. Opaque to the loop. */
export interface ContextCheckpointRef {
  readonly id: string;
}

/**
 * The observation policy a tool result must be projected under.
 *
 * It is carried in the prepared context so the Run Layer can snapshot it durably when a
 * Tool boundary opens: a later continuation must project results under the policy that
 * was in force when the turn was prepared, not under whatever a restarted process
 * happens to default to.
 */
export interface ObservationPolicySnapshot {
  readonly id: string;
  readonly maxOutputBytes?: number;
  readonly includeDetails?: boolean;
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
 */
export interface AgentLoopAdvanceInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly input: AgentTurnInput;
  readonly history: readonly AIMessage[];
  readonly model: ModelDescriptor;
  readonly tools: readonly AIToolSpec[];
  readonly settings?: AIModelSettings;
  readonly signal: AbortSignal;
  readonly streamSink?: ModelTurnStreamSink;
}

/** The loop finished one Reason and produced a decision. */
export interface AgentLoopAdvanceCompleted {
  readonly status: "COMPLETED";
  readonly decision: AgentDecision;
  /**
   * Only the messages this Reason adds, in order.
   *
   * `USER_INPUT` contributes the user delta plus the assistant message, `TOOL_RESULTS`
   * contributes the results plus the assistant message, and `CONTINUATION` contributes
   * the supplied continuation messages plus the assistant message. The loop returns AI
   * messages only; the durable legacy projection belongs to the Core boundary.
   */
  readonly messagesToAppend: readonly AIMessage[];
  /** The prepared context's opaque diagnostics, carried through untouched. */
  readonly contextReport?: Readonly<Record<string, unknown>>;
}

/**
 * Which stage of one Reason failed.
 *
 * This exists so the Run Layer can settle the right Step lifecycle without re-deriving where
 * the failure happened from the error code. `CONTEXT` and `ADMISSION` failed *before* the
 * durable boundary, so no Step was ever attempted; `BOUNDARY` failed at the durable commit, so
 * the provider was never contacted; `MODEL` failed after the boundary, so a Step really was
 * attempted and must be settled.
 */
export type AgentLoopFailureStage = "CONTEXT" | "ADMISSION" | "BOUNDARY" | "MODEL";

/**
 * How far the provider turn got.
 *
 * A settled provider turn that the classifier then refuses is *not* a failed provider attempt:
 * the provider answered, the answer was unusable. The Run Layer records that distinction
 * durably, so the loop reports it rather than letting a host infer it from an error code.
 */
export type AgentProviderTurnState = "NOT_STARTED" | "COMPLETED" | "FAILED";

/** The loop could not complete the turn. */
export interface AgentLoopAdvanceFailed {
  readonly status: "FAILED";
  readonly stage: AgentLoopFailureStage;
  readonly error: ModelTurnExecutionError;
  /** How far the provider turn got, when the failure reached it at all. */
  readonly providerTurnState?: AgentProviderTurnState;
  /** The prepared context's opaque diagnostics, when preparation got that far. */
  readonly contextReport?: Readonly<Record<string, unknown>>;
  /** The messages the caller may still append, if the turn got far enough to produce any. */
  readonly messagesToAppend: readonly AIMessage[];
  /**
   * The settled usage, when the turn got far enough to report one.
   *
   * A model turn that settled and *then* failed classification still spent its tokens, and the
   * Run Layer counts settled attempts. The loop therefore reports the usage it received even
   * though it produced no decision, so the accounting is not silently lost.
   */
  readonly usage?: import("@caelush/ai").ModelUsage | undefined;
  /**
   * A durable budget refusal, when the failure came from admission.
   *
   * This is a *value*, not an exception: a Run that has spent its budget is a Run behaving
   * correctly. The general kernel states the refusal in its own frozen vocabulary so the Run
   * Layer can settle `BUDGET_EXCEEDED` without the kernel importing a Run Layer error type.
   */
  readonly budgetBlock?: AgentBudgetBlock;
}

/** The turn was cancelled. Cancellation is not a failure. */
export interface AgentLoopAdvanceCancelled {
  readonly status: "CANCELLED";
}

/**
 * What one `advance()` produced.
 *
 * There is no `COMPLETED`-the-Run variant and no `VERIFYING` variant: the loop reports a
 * decision, and what that decision means for a Run is the Run Layer's to decide.
 */
export type AgentLoopAdvanceResult =
  AgentLoopAdvanceCompleted | AgentLoopAdvanceFailed | AgentLoopAdvanceCancelled;

/* ---------------------------------------------------------------- helpers */

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
