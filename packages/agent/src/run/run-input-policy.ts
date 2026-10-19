/**
 * The Run input admission policy.
 *
 * ```text
 * @caelush/agent     owns the decision
 * Core / daemon      asks it before building a request
 * @caelush/storage   asks it again inside the intake transaction
 * ```
 *
 * One predicate, three callers. The intake route cannot accept an input the authoritative
 * transaction would refuse, and the transaction cannot be talked into accepting one by a caller
 * that read a stale snapshot: the policy depends only on the facts the transaction re-reads.
 *
 * It is deliberately *not* a second Run state machine. It answers one question — may this Run take
 * a new mid-Run text correction right now — and it never decides what happens to the Run.
 */

/** Why a Run cannot take a new input. Closed on purpose: the intake API projects it. */
export type RunInputRejectionReason =
  "NOT_SUPPORTED" | "RUN_NOT_READY" | "RUN_TERMINAL" | "TARGET_MISMATCH";

/** The durable facts the policy reads. */
export interface RunInputAdmissionFacts {
  readonly status:
    | "PENDING"
    | "RUNNING"
    | "WAITING_APPROVAL"
    | "WAITING_RESOURCE"
    | "VERIFYING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED"
    | "TIMEOUT"
    | "MAX_STEPS_REACHED"
    | "BUDGET_EXCEEDED";
  /** The persisted completion contract; only `NATURAL_V1` Runs support this version. */
  readonly completionContract?: string | undefined;
  /** A durable cancellation intent exists, whoever wrote it. */
  readonly cancellationRequested: boolean;
  /** The Run's original deadline has passed. */
  readonly deadlineExceeded: boolean;
}

export type RunInputAdmissionDecision =
  | { readonly kind: "ACCEPT" }
  | { readonly kind: "REJECT"; readonly reason: RunInputRejectionReason };

const TERMINAL_STATUSES = new Set<RunInputAdmissionFacts["status"]>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
]);

/**
 * Governance priority, highest first: terminal, cancellation, deadline, contract, status.
 *
 * An input never extends a Run that is already ending: a cancellation intent or an expired
 * deadline outranks it exactly as it outranks every other continuation.
 */
export function evaluateRunInputAdmission(
  facts: RunInputAdmissionFacts,
): RunInputAdmissionDecision {
  if (TERMINAL_STATUSES.has(facts.status)) {
    return { kind: "REJECT", reason: "RUN_TERMINAL" };
  }
  if (facts.cancellationRequested) return { kind: "REJECT", reason: "RUN_TERMINAL" };
  if (facts.deadlineExceeded) return { kind: "REJECT", reason: "RUN_TERMINAL" };
  if (facts.completionContract !== "NATURAL_V1") {
    return { kind: "REJECT", reason: "NOT_SUPPORTED" };
  }
  switch (facts.status) {
    case "RUNNING":
    case "WAITING_APPROVAL":
    case "WAITING_RESOURCE":
      // Paused Runs accept durably and stay paused: acceptance never approves a Tool, resumes a
      // resource or retries a backoff.
      return { kind: "ACCEPT" };
    case "PENDING":
    case "VERIFYING":
      return { kind: "REJECT", reason: "RUN_NOT_READY" };
    default:
      return { kind: "REJECT", reason: "RUN_NOT_READY" };
  }
}
