import type { AIModelRequest, ModelDescriptor } from "@caelush/ai";

import type { AgentExecutionIdentity, AgentTurnRef } from "../types.js";

/**
 * The model admission port.
 *
 * Admission answers one question before any provider work starts: **may this model turn
 * be attempted at all?** It is a typed decision, not an exception:
 *
 * ```text
 * ALLOWED              the turn may proceed
 * BLOCKED(BUDGET)      a durable budget authority refused it
 * ```
 *
 * A budget refusal is a normal, expected outcome — a Run that has spent its budget is a
 * Run behaving correctly, not a crash. Modelling it as a thrown error forced every
 * caller to catch an exception to discover a business decision, so the frozen port
 * returns a decision instead. `AgentBudgetAdmissionError` remains only as a legacy
 * compatibility shape inside the Core boundary and is never the target API here.
 */
export type AgentModelAdmissionDecision =
  | { readonly kind: "ALLOWED" }
  | { readonly kind: "BLOCKED"; readonly reason: "BUDGET"; readonly block: AgentBudgetBlock };

/**
 * A durable budget refusal, in the frozen durable vocabulary.
 *
 * `EXCEEDED` names the dimension that ran out so the Run Layer can settle
 * `BUDGET_EXCEEDED` with the same accounting it already keeps. `UNAVAILABLE` is the
 * fail-closed case: enforcement could not be established at all, which is deliberately
 * *not* the same outcome as spending a budget and must never be reported as one.
 */
export interface AgentBudgetBlock {
  readonly kind: "EXCEEDED" | "UNAVAILABLE";
  readonly dimension?: "TOOL_CALLS" | "TOKENS" | "COST";
  readonly accounted?: number;
  readonly limit?: number;
  readonly limitMicros?: number;
  readonly accountedMicros?: number;
  readonly reason?: "PRICING" | "TOKEN_ESTIMATE";
}

/** What admission is asked about. */
export interface ModelRequestAdmissionInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly request: AIModelRequest;
  /** The model authority the request was resolved against. */
  readonly model: ModelDescriptor;
  readonly signal: AbortSignal;
}

/**
 * The frozen admission port.
 *
 * It must run after the request is fully prepared — a budget estimate needs the context,
 * the messages, the tool definitions and the tool results — and before the durable model
 * turn boundary. An implementation performs no provider I/O and owns no retry.
 */
export interface ModelRequestAdmissionPort {
  admit(input: ModelRequestAdmissionInput): Promise<AgentModelAdmissionDecision>;
}

/** The single frozen admission outcome for "this turn may proceed". */
export const ALLOWED_MODEL_ADMISSION: AgentModelAdmissionDecision = Object.freeze({
  kind: "ALLOWED",
});
