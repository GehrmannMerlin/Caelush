import type { AIModelRequest } from "@caelush/ai";

import type { AgentExecutionIdentity, AgentTurnRef } from "../types.js";

/**
 * The model admission port.
 *
 * Admission answers one question before any provider work starts: **may this model turn
 * be attempted at all?** It is a typed decision, not an exception:
 *
 * ```text
 * ALLOWED(request)      the turn may proceed, with the request admission approved
 * BLOCKED(BUDGET)       a durable budget authority refused it
 * ```
 *
 * A budget refusal is a normal, expected outcome — a Run that has spent its budget is a
 * Run behaving correctly, not a crash. Modelling it as a thrown error forced every
 * caller to catch an exception to discover a business decision, so the frozen port
 * returns a decision instead. `AgentBudgetAdmissionError` remains only as a legacy
 * compatibility shape inside the Core boundary and is never the target API here.
 *
 * `ALLOWED` carries the request admission approved, and the Agent Loop executes *that*
 * request. The returned request is the same provider-independent `AIModelRequest` the port
 * was given, adjusted under the existing request validation: admission is a budget
 * authority, not a second model authority, so it may not swap the `ModelRef`, bypass the
 * resolved `ModelDescriptor`, or inject a provider-native field.
 */
export type ModelRequestAdmissionDecision =
  | {
      readonly kind: "ALLOWED";

      readonly request: AIModelRequest;
    }
  | {
      readonly kind: "BLOCKED";

      readonly reason: "BUDGET";

      readonly block: AgentBudgetBlock;
    };

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
}

/**
 * The frozen admission port.
 *
 * It must run after the request is fully prepared — a budget estimate needs the context,
 * the messages, the tool definitions and the tool results — and before the durable model
 * turn boundary. An implementation performs no provider I/O, owns no retry, and receives
 * no model authority or cancellation signal: a budget decision is a pure function of the
 * request and the durable Run accounting.
 */
export interface ModelRequestAdmissionPort {
  admit(input: ModelRequestAdmissionInput): Promise<ModelRequestAdmissionDecision>;
}

/**
 * The frozen admission outcome for "this turn may proceed unchanged".
 *
 * A constant cannot express this outcome any more: `ALLOWED` carries the request, and a
 * shared frozen object cannot name a request it has never seen. The factory is the
 * replacement for the old constant, and it keeps the single-allocation convenience for the
 * common case where admission approves the request it was given.
 */
export function allowedModelAdmission(request: AIModelRequest): ModelRequestAdmissionDecision {
  return Object.freeze({ kind: "ALLOWED", request });
}
