import type {
  RunContextPreparationDiagnostic,
  RunFailureDiagnosticsPort,
  RunToolFailureDiagnostic,
} from "@caelush/core";
import {
  ContextPreparationDiagnosticSchema,
  ToolInfrastructureFailureReasonSchema,
  type ContextPreparationDiagnostic,
  type ToolInfrastructureFailureReason,
} from "@caelush/protocol";

const CONTEXT_PLANNING_ERROR_CODES = new Set([
  "INVALID_CONTEXT_ITEM",
  "DUPLICATE_ITEM_ID",
  "UNKNOWN_ITEM_REFERENCE",
  "BROKEN_ATOMIC_GROUP",
  "INCONSISTENT_PLAN",
  "MANDATORY_INPUT_TOO_LARGE",
  "CURRENT_TURN_TOO_LARGE",
] satisfies readonly NonNullable<RunContextPreparationDiagnostic["planningErrorCode"]>[]);

/**
 * The daemon's sink for the Run Layer's bounded failure diagnostics.
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
  readonly planningErrorCode?: RunContextPreparationDiagnostic["planningErrorCode"];
}

/**
 * One Context preparation log entry.
 *
 * ```text
 * stage        where preparation stopped: read, capacity, persistence, accounting, compaction
 * reasonCode   which artifact broke, in a closed vocabulary
 * dimension    which measured bound failed, with observed/limit, when it was a bound
 * ```
 *
 * A log line says "the Prompt Surface could not be persisted" and stops there. It never says what
 * the Section contained, which file was open, or which model was configured — the diagnostic has no
 * field for any of those, and this adapter does not add one.
 */
export interface ContextPreparationFailureLogEntry {
  readonly event: "run.context.preparation.failure";
  readonly runId: RunContextPreparationDiagnostic["runId"];
  readonly sourceStepId?: RunContextPreparationDiagnostic["sourceStepId"];
  readonly stage: ContextPreparationDiagnostic["stage"];
  readonly reasonCode: ContextPreparationDiagnostic["reasonCode"];
  readonly dimension?: string;
  readonly observed?: number;
  readonly limit?: number;
  readonly causeKinds: readonly string[];
}

/** The minimal host logger shape. Optional: a deployment without logging simply has no sink. */
export interface RunFailureDiagnosticsLogger {
  toolFailure?(entry: ToolFailureLogEntry): void;
  contextPreparationFailure?(entry: ContextPreparationFailureLogEntry): void;
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
    recordContextPreparationFailure(diagnostic: RunContextPreparationDiagnostic): void {
      const entry = toContextPreparationLogEntry(diagnostic);
      options.logger?.contextPreparationFailure?.(entry);
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

/**
 * Shape one Context preparation log entry, re-validating the classification at the boundary.
 *
 * The three measured fields are copied only when they are numbers: a `dimension` without `observed`
 * is still a useful line ("the section-state bound failed"), and a bound the Run Layer could not
 * defend never reaches a log. An unparsable classification degrades to the generic stage and reason
 * rather than being published as itself.
 */
export function toContextPreparationLogEntry(
  diagnostic: RunContextPreparationDiagnostic,
): ContextPreparationFailureLogEntry {
  const parsed = ContextPreparationDiagnosticSchema.safeParse({
    reasonCode: diagnostic.reasonCode,
    stage: diagnostic.stage,
    ...(diagnostic.dimension === undefined ? {} : { dimension: diagnostic.dimension }),
    ...(diagnostic.observed === undefined ? {} : { observed: diagnostic.observed }),
    ...(diagnostic.limit === undefined ? {} : { limit: diagnostic.limit }),
  });
  const safe: ContextPreparationDiagnostic = parsed.success
    ? parsed.data
    : { reasonCode: "CONTEXT_PREPARATION_FAILED", stage: "unknown" };
  const planningErrorCode = diagnostic.planningErrorCode;
  return Object.freeze({
    event: "run.context.preparation.failure" as const,
    runId: diagnostic.runId,
    ...(diagnostic.sourceStepId === undefined ? {} : { sourceStepId: diagnostic.sourceStepId }),
    stage: safe.stage,
    reasonCode: safe.reasonCode,
    ...(safe.dimension === undefined ? {} : { dimension: safe.dimension }),
    ...(safe.observed === undefined ? {} : { observed: safe.observed }),
    ...(safe.limit === undefined ? {} : { limit: safe.limit }),
    causeKinds: Object.freeze([...diagnostic.causeKinds]),
    ...(planningErrorCode === undefined || !CONTEXT_PLANNING_ERROR_CODES.has(planningErrorCode)
      ? {}
      : { planningErrorCode }),
  });
}
