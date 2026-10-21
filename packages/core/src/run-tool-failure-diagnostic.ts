import {
  ToolBatchInfrastructureError,
  ToolExecutionInfrastructureError,
  ToolExecutionUncertainError,
  ToolPreparationInfrastructureError,
  type ToolExecutionInfrastructurePhase,
} from "@caelush/agent";
import type { RunId, StepId, ToolInfrastructureFailureReason } from "@caelush/protocol";

import type { RunContextPreparationDiagnostic } from "./run-context-preparation-diagnostic.js";
import {
  causeKindOf,
  collectCauseChain,
  MAX_DIAGNOSTIC_CAUSE_LINKS,
} from "./run-failure-cause-chain.js";

export { MAX_DIAGNOSTIC_CAUSE_LINKS };

/**
 * Core's safe reading of a Tool infrastructure failure.
 *
 * ```text
 * caught exception
 *   → at most four typed cause links
 *   → the first ToolExecutionInfrastructureError.phase     (typed; never a message)
 *   → one closed reason code
 *   → a bounded, JSON-safe diagnostic
 * ```
 *
 * ## What it deliberately cannot produce
 *
 * The diagnostic carries no message, no stack, no argument, no provider state and no host path. It
 * exists so a host can *log and display* which stage broke; it is not a channel for the exception,
 * and nothing downstream may widen it into one. `causeKinds` is a whitelist of structural labels, so
 * even the shape of the chain cannot leak content.
 *
 * ## Why the stage is read from the type and not the text
 *
 * The Preparer, the executor, the result pipeline and the settlement each raise their own typed
 * error. Matching on `message` would make the classification depend on wording that is free to
 * change, and an unknown error would be mislabelled as a specific stage — which is exactly the kind
 * of confident-but-wrong diagnosis this exists to avoid. An unrecognized failure is reported as
 * `TOOL_INFRASTRUCTURE_FAILED`, and that answer is honest.
 */

/** One bounded Tool failure fact. Safe to serialize, log and show. */
export interface RunToolFailureDiagnostic {
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly stage: ToolExecutionInfrastructurePhase | "UNKNOWN";
  readonly reasonCode: ToolInfrastructureFailureReason;
  /** Class names only, outermost first, at most `MAX_DIAGNOSTIC_CAUSE_LINKS`. */
  readonly causeKinds: readonly string[];
}

/**
 * The host's diagnostic sink.
 *
 * Optional, and deliberately fire-and-forget: a host that wants to log a Tool failure provides one,
 * and a host that does not keeps the previous behaviour. The port receives no Error object, so it
 * cannot accidentally serialize one.
 *
 * `recordContextPreparationFailure` is separately optional because a host may have shipped a logger
 * for Tool failures before Context preparation had a vocabulary. A missing method means "not
 * interested", never "unable to record": the durable Run settlement carries the same classification
 * either way, so nothing about the Run depends on a host implementing it.
 */
export interface RunFailureDiagnosticsPort {
  recordToolFailure(diagnostic: RunToolFailureDiagnostic): void;
  recordContextPreparationFailure?(diagnostic: RunContextPreparationDiagnostic): void;
}

const REASON_BY_PHASE: Readonly<
  Record<ToolExecutionInfrastructurePhase, ToolInfrastructureFailureReason>
> = Object.freeze({
  PREPARATION: "TOOL_PREPARATION_FAILED",
  ADMISSION: "TOOL_ADMISSION_FAILED",
  EXECUTION: "TOOL_EXECUTION_INFRASTRUCTURE_FAILED",
  RESULT_PIPELINE: "TOOL_RESULT_PIPELINE_FAILED",
  SETTLEMENT: "TOOL_SETTLEMENT_FAILED",
  RECOVERY: "TOOL_RECOVERY_FAILED",
});

/**
 * The structural label vocabulary.
 *
 * Only these names can appear in a diagnostic. A custom error class is labelled `UnknownCause`
 * rather than by its own name, so an application's naming cannot become a diagnostic surface.
 * Subclasses come first: the Preparer's error *is* a Tool execution infrastructure error.
 */
const CAUSE_LABELS = Object.freeze([
  { type: ToolPreparationInfrastructureError, label: "ToolPreparationInfrastructureError" },
  { type: ToolExecutionInfrastructureError, label: "ToolExecutionInfrastructureError" },
  { type: ToolBatchInfrastructureError, label: "ToolBatchInfrastructureError" },
  { type: ToolExecutionUncertainError, label: "ToolExecutionUncertainError" },
]);

/**
 * Classify one caught Tool failure without reading any of its content.
 *
 * Safe for a hostile input: a throwing `cause` accessor, a cyclic chain, a non-Error cause and a
 * chain longer than the bound all produce a diagnostic rather than an exception. A classifier that
 * could throw would replace the Run's real failure with its own.
 */
export function classifyToolFailure(input: {
  readonly runId: RunId;
  readonly sourceStepId: StepId;
  readonly cause: unknown;
}): RunToolFailureDiagnostic {
  const chain = collectCauseChain(input.cause);
  let stage: ToolExecutionInfrastructurePhase | "UNKNOWN" = "UNKNOWN";
  let reasonCode: ToolInfrastructureFailureReason = "TOOL_INFRASTRUCTURE_FAILED";
  for (const link of chain) {
    if (link instanceof ToolExecutionInfrastructureError) {
      stage = link.phase;
      reasonCode = REASON_BY_PHASE[link.phase] ?? "TOOL_INFRASTRUCTURE_FAILED";
      break;
    }
  }
  return Object.freeze({
    runId: input.runId,
    sourceStepId: input.sourceStepId,
    stage,
    reasonCode,
    causeKinds: Object.freeze(chain.map((link) => causeKindOf(link, CAUSE_LABELS))),
  });
}
