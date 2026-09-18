import type { AgentError } from "@caelush/protocol";

import type { AgentFinalCandidateDecision } from "../../loop/decision/decision.js";
import type {
  AgentCompletionResult,
  CompletionGate,
  CompletionGateInput,
} from "../ports/completion-gate.js";

/**
 * The accept-directly `CompletionGate`.
 *
 * ```text
 * ACCEPT   the candidate text becomes the Run result
 * ```
 *
 * The frozen `CompletionGate` contract has always named this implementation — "an accept-directly
 * gate, a coding verification gate" — and until Phase 3F only the coding one existed. It is the
 * general case: a host that has no verification subsystem still needs *a* gate, because the frozen
 * `RunExecutionDriver` requires one and because a final candidate that nothing evaluates is a
 * candidate nobody accepted.
 *
 * It is deliberately the smallest thing that satisfies the contract:
 *
 * ```text
 * no Workspace       no Git              no Runtime          no VerificationPlan
 * no model call      no Tool execution   no Run write        no persistence
 * ```
 *
 * Everything it decides comes from the `CompletionGateInput` it is handed, so the whole function is
 * pure apart from the `Promise` the port returns.
 *
 * **It is not a fallback for a strict gate.** A coding host composes the coding gate; a host that
 * cannot verify does not get to accept by default, because "the verifier was missing" must never read
 * as "the candidate passed". This gate is only ever reached by a host that *chose* it at composition
 * time, and `pnpm check:architecture` refuses the coding daemon naming it at all.
 */

/** The gate id every decision from this policy is attributed to. */
export const DIRECT_ACCEPT_COMPLETION_GATE_ID = "caelush.accept-directly-completion-gate.v1";

export interface DirectAcceptCompletionGateOptions {
  /**
   * The `type` discriminator the accepted `AgentCompletionResult` carries.
   *
   * A host may name its own result kind here; it defaults to `TEXT`, which is what a gate that accepts
   * the candidate's own text is actually producing.
   */
  readonly resultType?: string;
}

/**
 * Create the accept-directly gate.
 *
 * An aborted signal is answered the way the frozen contract requires and never with an acceptance: a
 * cancellation or a deadline belongs to the Run's termination authority, which resolves it before and
 * after this call and always wins. Accepting here would let a cancelled Run complete, and the frozen
 * decision union has no `CANCELLED` arm for this gate to reach for — so it suspends instead, exactly
 * as the coding gate does, and never writes a status of its own.
 */
export function createDirectAcceptCompletionGate(
  options: DirectAcceptCompletionGateOptions = {},
): CompletionGate {
  const resultType = options.resultType ?? "TEXT";
  return {
    id: DIRECT_ACCEPT_COMPLETION_GATE_ID,
    async evaluate(input: CompletionGateInput) {
      if (input.signal.aborted) {
        return { kind: "ERROR", error: suspendedError(), retryable: true };
      }
      return { kind: "ACCEPT", finalResult: acceptedResult(input.candidate, resultType) };
    },
  };
}

/**
 * The Run result an accepted candidate becomes.
 *
 * `text` is the candidate's own text, unmodified: the general completion vocabulary is
 * `JsonObject & { type, text }`, and inventing, trimming or summarizing the answer here would mean
 * sealing a result the Run never produced.
 */
function acceptedResult(
  candidate: AgentFinalCandidateDecision,
  resultType: string,
): AgentCompletionResult {
  return { type: resultType, text: candidate.candidateText };
}

/**
 * The sanitized error an undecidable evaluation carries.
 *
 * The frozen `AgentError.code` is a closed vocabulary, so the internal reason is projected onto
 * `INTERNAL_ERROR` rather than invented — nothing about the signal or the host crosses into durable
 * data. `retryable: true` is what tells the Run Layer to end its drive on the durable boundary it
 * already holds instead of asking again.
 */
function suspendedError(): AgentError {
  return {
    code: "INTERNAL_ERROR",
    message: "Completion evaluation could not reach a decision.",
    retryable: false,
    phase: "VERIFICATION",
  };
}
