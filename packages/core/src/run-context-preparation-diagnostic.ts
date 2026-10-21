import {
  ContextExhaustedError,
  ContextPlanningError,
  ContextPressureAccountingError,
  PromptSurfaceCapacityError,
  PromptSurfaceIntegrityError,
  PromptSurfaceRolloverConflictError,
} from "@caelush/agent";
import type {
  AgentError,
  ContextPreparationFailureReason,
  ContextPreparationStage,
  RunId,
  StepId,
} from "@caelush/protocol";

import { causeKindOf, collectCauseChain } from "./run-failure-cause-chain.js";

/**
 * Core's safe reading of a Context preparation failure.
 *
 * ```text
 * caught exception from ContextEnginePort.prepare()
 *   → at most four typed cause links
 *   → the first recognized context error            (typed; never a message)
 *   → one closed stage + reason code + optional measured dimension
 *   → a bounded, JSON-safe diagnostic
 * ```
 *
 * ## Why this is not a provider error
 *
 * The Agent Loop has to report *something* when preparation throws, and its generic branch says
 * "the model context could not be prepared" under a provider-shaped code. That is the one thing the
 * failure provably is not: no provider was contacted, no model output exists, and no money was
 * spent. Settling it as `MODEL_ERROR` tells the user the model refused, which sends them to the
 * wrong place — a provider console, a billing page, a model swap — while the actual fault is a local
 * projection, storage or capacity condition.
 *
 * So Core re-settles exactly this case: the durable error becomes an internal context failure that
 * names the stage, and the host's UI can say "preparing the task context failed" with a correlation
 * ID instead of "the model failed".
 *
 * ## What it deliberately cannot produce
 *
 * No message, no stack, no prompt, no Section text, no host path, no key. `causeKinds` is a
 * whitelist of structural labels, and `dimension`/`observed`/`limit` are the numbers a typed
 * capacity error measured. Reading `message` would be guessing from prose, which is exactly how a
 * diagnosis becomes confidently wrong after the wording changes.
 */

/** One bounded Context preparation fact. Safe to serialize, log and show. */
export interface RunContextPreparationDiagnostic {
  readonly runId: RunId;
  /**
   * The Step the failure happened on, when there is one.
   *
   * Optional on purpose: preparation runs before the turn reaches the provider, and a future
   * caller may classify a failure that happened before any Step was allocated.
   */
  readonly sourceStepId?: StepId;
  readonly stage: ContextPreparationStage;
  readonly reasonCode: ContextPreparationFailureReason;
  /** Which measured bound failed, when the failing error was a typed capacity error. */
  readonly dimension?: string;
  readonly observed?: number;
  readonly limit?: number;
  /** Class names only, outermost first, at most `MAX_DIAGNOSTIC_CAUSE_LINKS`. */
  readonly causeKinds: readonly string[];
}

/**
 * The structural label vocabulary for a context failure.
 *
 * Same rule as the Tool diagnostic: only these names can appear. The context engine's own classes
 * are listed because they *are* the classification — a `PromptSurfaceCapacityError` in the chain is
 * the fact that the Prompt Surface's bound was hit.
 */
const CAUSE_LABELS = Object.freeze([
  { type: PromptSurfaceCapacityError, label: "PromptSurfaceCapacityError" },
  { type: PromptSurfaceIntegrityError, label: "PromptSurfaceIntegrityError" },
  { type: PromptSurfaceRolloverConflictError, label: "PromptSurfaceRolloverConflictError" },
  { type: ContextExhaustedError, label: "ContextExhaustedError" },
  { type: ContextPressureAccountingError, label: "ContextPressureAccountingError" },
  { type: ContextPlanningError, label: "ContextPlanningError" },
]);

/**
 * The one reason code each Prompt Surface capacity reason maps to.
 *
 * The mapping is total over `PROMPT_SURFACE_CAPACITY_REASONS`, and a value outside it degrades to
 * the generic context failure rather than being published as an unknown-but-specific code.
 */
const REASON_BY_SURFACE_REASON: Readonly<Record<string, ContextPreparationFailureReason>> =
  Object.freeze({
    BASELINE_TOO_LARGE: "CONTEXT_SURFACE_BASELINE_TOO_LARGE",
    EPOCH_ROLLOVER_CONFLICT: "CONTEXT_SURFACE_ROLLOVER_CONFLICT",
    EPOCH_ROLLOVER_FAILED: "CONTEXT_SURFACE_ROLLOVER_FAILED",
    SURFACE_PERSISTENCE_FAILED: "CONTEXT_SURFACE_PERSISTENCE_FAILED",
  });

/** Classify one caught Context preparation failure without reading any of its content. */
export function classifyContextPreparationFailure(input: {
  readonly runId: RunId;
  readonly sourceStepId?: StepId | undefined;
  readonly cause: unknown;
}): RunContextPreparationDiagnostic {
  const chain = collectCauseChain(input.cause);
  const base = {
    runId: input.runId,
    ...(input.sourceStepId === undefined ? {} : { sourceStepId: input.sourceStepId }),
    causeKinds: Object.freeze(chain.map((link) => causeKindOf(link, CAUSE_LABELS))),
  } as const;
  for (const link of chain) {
    if (link instanceof PromptSurfaceCapacityError) {
      return Object.freeze({
        ...base,
        stage: link.stage,
        reasonCode: REASON_BY_SURFACE_REASON[link.reason] ?? "CONTEXT_PREPARATION_FAILED",
        ...measuredBounds(link),
      });
    }
    if (link instanceof PromptSurfaceIntegrityError) {
      return Object.freeze({
        ...base,
        stage: "surface_read",
        reasonCode: "CONTEXT_SURFACE_INTEGRITY_FAILED",
      });
    }
    if (link instanceof PromptSurfaceRolloverConflictError) {
      return Object.freeze({
        ...base,
        stage: "surface_capacity",
        reasonCode: "CONTEXT_SURFACE_ROLLOVER_CONFLICT",
      });
    }
    if (link instanceof ContextExhaustedError) {
      /*
       * The window is exhausted *after* the engine tried to reduce the context. Calling the stage
       * `compaction` is the honest description of where the failure was decided; calling it a model
       * or window-size failure would blame the provider for a local reduction that did not succeed.
       */
      return Object.freeze({
        ...base,
        stage: "compaction",
        reasonCode: "CONTEXT_WINDOW_EXHAUSTED",
      });
    }
    if (link instanceof ContextPressureAccountingError) {
      /*
       * The budget could not be established at all — reserves plus the request's own overhead exceed
       * the window, so there is no positive input allowance to plan against. Nothing about the
       * conversation was too large: this is a configuration arithmetic failure, and it is reachable in
       * production with a model whose window cannot hold its own Tool schema.
       */
      return Object.freeze({
        ...base,
        stage: "pressure_accounting",
        reasonCode: "CONTEXT_PRESSURE_ACCOUNTING_FAILED",
      });
    }
    if (link instanceof ContextPlanningError) {
      return Object.freeze({
        ...base,
        stage: "pressure_accounting",
        reasonCode: "CONTEXT_PRESSURE_ACCOUNTING_FAILED",
      });
    }
  }
  return Object.freeze({
    ...base,
    stage: "unknown",
    reasonCode: "CONTEXT_PREPARATION_FAILED",
  });
}

/**
 * The durable error a Context preparation failure settles as.
 *
 * ```text
 * CONTEXT_WINDOW_EXHAUSTED   the context does not fit          → CONTEXT_EXHAUSTED
 * anything else              a local projection/storage fault  → INTERNAL_ERROR
 * ```
 *
 * The code is chosen from the *classification*, never from the exception's message, and `phase` is
 * `INTERNAL` in both cases: this failure happened before any provider I/O, so a `LLM` phase would
 * make every downstream surface describe it as a model fault.
 *
 * A future run of the same condition therefore settles identically and reads identically, which is
 * what makes the durable record comparable across builds.
 */
export function contextPreparationAgentError(
  diagnostic: RunContextPreparationDiagnostic,
): AgentError {
  const details = {
    contextPreparation: {
      reasonCode: diagnostic.reasonCode,
      stage: diagnostic.stage,
      ...(diagnostic.dimension === undefined ? {} : { dimension: diagnostic.dimension }),
      ...(diagnostic.observed === undefined ? {} : { observed: diagnostic.observed }),
      ...(diagnostic.limit === undefined ? {} : { limit: diagnostic.limit }),
    },
  };
  return diagnostic.reasonCode === "CONTEXT_WINDOW_EXHAUSTED"
    ? {
        code: "CONTEXT_EXHAUSTED",
        message: "The task context could not be reduced to fit the model's context window.",
        retryable: false,
        phase: "INTERNAL",
        details,
      }
    : {
        code: "INTERNAL_ERROR",
        message: "The task context could not be prepared for this step.",
        retryable: false,
        phase: "INTERNAL",
        details,
      };
}

/**
 * The measured bounds, only when they are numbers a consumer can trust.
 *
 * A negative or non-integer value would be a bound the diagnostic cannot defend, so it is dropped
 * rather than published: a wrong number in a diagnostic is worse than an absent one.
 */
function measuredBounds(error: PromptSurfaceCapacityError): {
  readonly dimension?: string;
  readonly observed?: number;
  readonly limit?: number;
} {
  const dimension = safeDimensionToken(error.dimension);
  const observed = safeCount(error.observed);
  const limit = safeCount(error.limit);
  return {
    ...(dimension === undefined ? {} : { dimension }),
    ...(observed === undefined ? {} : { observed }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** A dimension is a short token, never free text: the pattern is the bound. */
function safeDimensionToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
