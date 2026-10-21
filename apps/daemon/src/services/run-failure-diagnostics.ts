import type { RunFailureDiagnosticsPort, RunToolFailureDiagnostic } from "@caelush/core";
import {
  ToolInfrastructureFailureReasonSchema,
  type ToolInfrastructureFailureReason,
} from "@caelush/protocol";

/**
 * The daemon's sink for the Run Layer's bounded Tool failure diagnostics.
 *
 * ```text
 * RunController        classifies the caught exception into stage + reasonCode
 *   → this adapter     re-checks the closed vocabulary and shapes one log entry
 *   → host logger      records that entry; the exception is never passed on
 * ```
 *
 * The deployment logs *which stage* broke. It cannot log the exception, because the Run Layer never
 * hands one over: a diagnostic carries a stage, a closed reason code and at most four structural
 * class names, so there is nothing here that could turn a crash into a second unbounded reporting
 * channel carrying messages, arguments, provider payloads or host paths.
 *
 * The vocabulary is checked again at the boundary. The Run Layer already produces it from the type
 * system, but an adapter that forwards a value it did not verify would make this file the place where
 * a future drift became a published fact. An unrecognized code degrades to the honest generic one.
 */

/** One log entry. Fixed fields, no free text, safe to serialize as-is. */
export interface ToolFailureLogEntry {
  readonly event: "run.tool.failure";
  readonly runId: RunToolFailureDiagnostic["runId"];
  readonly sourceStepId: RunToolFailureDiagnostic["sourceStepId"];
  readonly stage: RunToolFailureDiagnostic["stage"];
  readonly reasonCode: ToolInfrastructureFailureReason;
  readonly causeKinds: readonly string[];
}

/** The minimal host logger shape. Optional: a deployment without logging simply has no sink. */
export interface RunFailureDiagnosticsLogger {
  toolFailure?(entry: ToolFailureLogEntry): void;
}

export function createRunFailureDiagnostics(
  options: { readonly logger?: RunFailureDiagnosticsLogger } = {},
): RunFailureDiagnosticsPort {
  return {
    recordToolFailure(diagnostic: RunToolFailureDiagnostic): void {
      const entry = toToolFailureLogEntry(diagnostic);
      // Reading the sink late keeps the adapter stateless; a sink that throws is the Run Layer's
      // concern (it isolates diagnostic failures), so this adapter does not swallow anything itself.
      options.logger?.toolFailure?.(entry);
    },
  };
}

export function toToolFailureLogEntry(diagnostic: RunToolFailureDiagnostic): ToolFailureLogEntry {
  const reasonCode = ToolInfrastructureFailureReasonSchema.safeParse(diagnostic.reasonCode);
  return Object.freeze({
    event: "run.tool.failure" as const,
    runId: diagnostic.runId,
    sourceStepId: diagnostic.sourceStepId,
    stage: diagnostic.stage,
    reasonCode: reasonCode.success ? reasonCode.data : "TOOL_INFRASTRUCTURE_FAILED",
    // Bounded by the Run Layer; copied so a later mutation of the diagnostic cannot change a line
    // that was already handed to a logger.
    causeKinds: Object.freeze([...diagnostic.causeKinds]),
  });
}
