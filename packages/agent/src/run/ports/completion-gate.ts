import type { AgentError, JsonObject, StepId } from "@caelush/protocol";

import type { AgentExecutionIdentity } from "../../loop/types.js";
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
 * The four decisions are closed, discriminated by `kind`, and each means something different to
 * the Run Layer:
 *
 * ```text
 * ACCEPT   the candidate may become the Run result; the gate carries the result it accepted
 * REPAIR   the same Run should try again with a new candidate
 * REJECT   the candidate is refused, and the Run fails with this error
 * ERROR    the gate could not decide; `retryable` says whether a fresh attempt may help
 * ```
 */

/**
 * The result a gate accepted, in the general completion vocabulary.
 *
 * `JsonObject` because the durable `AgentRun.finalResult` is a Protocol JSON value: the general
 * Run Layer must be able to persist whatever a general gate accepted without knowing what a
 * coding gate would have put there. `type` is the discriminated spelling a host may project on,
 * and `text` is the answer itself.
 *
 * Deliberately **not** `VerifiedRunFinalResult`: that is a coding-verification artefact carrying
 * evidence and a seal, and a general Run must be able to complete without one.
 */
export type AgentCompletionResult = JsonObject & {
  readonly type: string;

  readonly text: string;
};

/**
 * What a gate wants a Run to do differently on its next attempt.
 *
 * Described in the host's own terms rather than a coding subsystem's: `repairRef` names the
 * decision the host should act on, `cycle` bounds it, and `metadata` is where a host puts whatever
 * else its own repair policy needs. The kernel does not interpret any of it.
 */
export interface CompletionRepairRequest {
  readonly repairRef: string;

  readonly cycle: number;

  readonly reason: string;

  readonly metadata?: JsonObject;
}

/** What one completion evaluation decided. */
export type CompletionGateDecision =
  | {
      readonly kind: "ACCEPT";

      readonly finalResult: AgentCompletionResult;
    }
  | {
      readonly kind: "REPAIR";

      readonly repair: CompletionRepairRequest;
    }
  | {
      readonly kind: "REJECT";

      readonly error: AgentError;
    }
  | {
      readonly kind: "ERROR";

      readonly error: AgentError;

      readonly retryable: boolean;
    };

/** Every completion decision discriminant, in canonical order. */
export const COMPLETION_GATE_KINDS = [
  "ACCEPT",
  "REPAIR",
  "REJECT",
  "ERROR",
] as const satisfies readonly CompletionGateDecision["kind"][];

/**
 * What one completion evaluation is asked about.
 *
 * Self-contained for the same reason the Tool request is: the candidate was already produced and
 * named, so the gate receives it rather than re-reading a Run to find it.
 *
 * `identity` is carried because a completion decision is about a *Run*, not only about a string of
 * text: a gate that produces durable evidence has to name the Run and session it belongs to, and a
 * gate that read them from somewhere else would be a second identity authority.
 */
export interface CompletionGateInput {
  readonly identity: AgentExecutionIdentity;

  readonly sourceStepId: StepId;

  readonly candidate: AgentFinalCandidateDecision;

  /** `EXECUTE` evaluates a fresh candidate; `RECOVER` re-evaluates one a restart found. */
  readonly mode: RunExecutionMode;

  /** The caller's cancellation signal, forwarded unchanged. */
  readonly signal: AbortSignal;
}

/**
 * Evaluate one final candidate.
 *
 * `id` names the gate the Run Layer configured, so a decision can be attributed to the policy that
 * produced it without the decision itself carrying presentation data.
 *
 * Phase 3E owns its production implementation.
 */
export interface CompletionGate {
  readonly id: string;

  evaluate(input: CompletionGateInput): Promise<CompletionGateDecision>;
}
