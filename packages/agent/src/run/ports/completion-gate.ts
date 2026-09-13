import type { AgentError, StepId } from "@caelush/protocol";

import type { AgentFinalCandidateDecision } from "../../loop/decision/decision.js";
import type { RunExecutionMode } from "../directive.js";

/**
 * The completion gate contract.
 *
 * ```text
 * CompletionGate = may this final candidate become the Run's result?
 * ```
 *
 * It exists so the frozen `RunExecutionEffectResult` can wrap a real decision type instead of a
 * coding subsystem's private outcome. The gate is asked about an *existing* candidate: it never
 * generates one, never calls a provider itself and never commits a Run status. Producing evidence
 * is its job; transitioning the Run is the RunController's.
 *
 * This is a contract only. The implementations — an accept-directly gate, a coding verification
 * gate, workspace and Git freshness, the completion seal — belong to Phase 3E, and nothing here
 * implements or approximates them.
 *
 * The four outcomes are closed and each means something different to the Run Layer:
 *
 * ```text
 * ACCEPT   the candidate may become the Run result; the gate produced its evidence
 * REPAIR   the same Run should try again with a new candidate
 * REJECT   the candidate is refused, and the Run fails with a verification error
 * ERROR    the gate could not decide; the Run stays recoverable rather than guessing
 * ```
 */
export type CompletionGateDecision =
  | { readonly outcome: "ACCEPT" }
  | { readonly outcome: "REPAIR"; readonly repairRef: string; readonly cycle: number }
  | { readonly outcome: "REJECT"; readonly reason: string }
  | { readonly outcome: "ERROR"; readonly error: AgentError };

/** Every completion outcome, in canonical order. */
export const COMPLETION_GATE_OUTCOMES = [
  "ACCEPT",
  "REPAIR",
  "REJECT",
  "ERROR",
] as const satisfies readonly CompletionGateDecision["outcome"][];

/**
 * What one completion evaluation is asked about.
 *
 * Self-contained for the same reason the Tool request is: the candidate was already produced and
 * named, so the gate receives it rather than re-reading a Run to find it.
 */
export interface CompletionGateRequest {
  /** `EXECUTE` evaluates a fresh candidate; `RECOVER` re-evaluates one a restart found. */
  readonly mode: RunExecutionMode;
  readonly sourceStepId: StepId;
  readonly candidate: AgentFinalCandidateDecision;
  /** The caller's cancellation signal, forwarded unchanged. */
  readonly signal: AbortSignal;
}

/** Evaluate one final candidate. Phase 3E owns its production implementation. */
export interface CompletionGate {
  evaluate(request: CompletionGateRequest): Promise<CompletionGateDecision>;
}
