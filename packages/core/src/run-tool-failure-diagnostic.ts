import {
  ToolBatchInfrastructureError,
  ToolExecutionInfrastructureError,
  ToolExecutionUncertainError,
  ToolPreparationInfrastructureError,
  type ToolExecutionInfrastructurePhase,
} from "@caelush/agent";
import type { RunId, StepId, ToolInfrastructureFailureReason } from "@caelush/protocol";

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
 */
export interface RunFailureDiagnosticsPort {
  recordToolFailure(diagnostic: RunToolFailureDiagnostic): void;
}

/** The most cause links one diagnostic may describe. */
export const MAX_DIAGNOSTIC_CAUSE_LINKS = 4;

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
 * Only these names can appear in a diagnostic. A custom error class is labelled `UNKNOWN_CAUSE`
 * rather than by its own name, so an application's naming cannot become a diagnostic surface.
 */
const BUILT_IN_CAUSE_KINDS: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

const UNKNOWN_CAUSE_KIND = "UnknownCause";

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
    causeKinds: Object.freeze(chain.map(causeKindOf)),
  });
}

function collectCauseChain(cause: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = cause;
  while (
    current !== null &&
    current !== undefined &&
    chain.length < MAX_DIAGNOSTIC_CAUSE_LINKS &&
    !seen.has(current)
  ) {
    seen.add(current);
    chain.push(current);
    current = readCause(current);
  }
  return chain;
}

/** Reading `cause` may hit an accessor that throws; a broken error must not mask the failure. */
function readCause(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as { readonly cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

function causeKindOf(value: unknown): string {
  // Subclass first: the Preparer's error *is* a Tool execution infrastructure error.
  if (value instanceof ToolPreparationInfrastructureError) {
    return "ToolPreparationInfrastructureError";
  }
  if (value instanceof ToolExecutionInfrastructureError) return "ToolExecutionInfrastructureError";
  if (value instanceof ToolBatchInfrastructureError) return "ToolBatchInfrastructureError";
  if (value instanceof ToolExecutionUncertainError) return "ToolExecutionUncertainError";
  const name = constructorNameOf(value);
  return name !== undefined && BUILT_IN_CAUSE_KINDS.has(name) ? name : UNKNOWN_CAUSE_KIND;
}

function constructorNameOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const ctor = (value as { readonly constructor?: unknown }).constructor;
    const name =
      typeof ctor === "function" ? (ctor as { readonly name?: unknown }).name : undefined;
    return typeof name === "string" && name.length > 0 && name.length <= 64 ? name : undefined;
  } catch {
    return undefined;
  }
}
