import { AIError, createAIError } from "@caelush/ai";
import type { AIErrorCode, AIModelRequest, AIModelTurnResult } from "@caelush/ai";
import type {
  AgentExecutionIdentity,
  AgentTurnRef,
  ModelTurnExecutionInput,
  ModelTurnExecutor,
  ModelTurnStreamSink,
} from "@caelush/agent";
import type { StepId } from "@caelush/protocol";

/**
 * TRANSITIONAL — the legacy throw-based facade over the frozen `ModelTurnExecutor`.
 *
 * Phase 3A aligned the agent executor with the frozen contract: one model turn now
 * resolves a `ModelTurnExecutionResult` union instead of throwing. The Core consumers that
 * were written against the previous throw-based semantics — the legacy `AgentLoop` — keep
 * working through this adapter:
 *
 * ```text
 * COMPLETED → the AIModelTurnResult
 * FAILED    → a thrown, mapped AIError
 * CANCELLED → a thrown cancellation signal (AIError AI_ABORTED)
 * ```
 *
 * The `@caelush/agent` package keeps no throw-based public interface: this shape exists only
 * at the legacy host boundary.
 *
 * Phase 3F retired it from production composition entirely. Its remaining consumers are the legacy
 * Core `AgentLoop` unit tests and this file's own tests: Phase 3E moved the last host-driven model
 * turn — the verification review — onto an explicit-identity client, so nothing in `apps/` or in the
 * production Agent path constructs one.
 *
 * ```text
 * EXIT CONDITION: deleted with the legacy Core `AgentLoop` facade and its tests.
 * ```
 */

/**
 * The Core compatibility boundary's thrown-failure projection.
 *
 * Re-exported from `model-turn-error-mapping.ts`, where it now lives: the pure mapping has its own
 * module so that a consumer needing only the mapping does not have to import this executor's
 * implementation. Nothing about the classification or the error semantics changed in the move.
 */
export { toModelTurnExecutionError } from "./model-turn-error-mapping.js";

/** The legacy throw-based model turn contract. */
export interface LegacyModelTurnExecutor {
  execute(input: {
    readonly request: AIModelRequest;
    readonly signal: AbortSignal;
    /**
     * The transient presentation sink for this turn, when the host configured one.
     *
     * The frozen `AgentLoop.advance()` has no `streamSink` input: live deltas belong to the
     * `ModelTurnExecutor`, and the composition binds them by decorating the executor. This facade
     * is the decoration point for the Core path — it forwards the sink into the frozen
     * `ModelTurnExecutionInput`, which is the only place that may project provider deltas.
     */
    readonly streamSink?: ModelTurnStreamSink;
  }): Promise<AIModelTurnResult>;
}

/** Where a legacy executor gets the durable turn identity the frozen one requires. */
export interface LegacyModelTurnExecutorDependencies {
  readonly executor: ModelTurnExecutor;
  /**
   * The Run identity the loop is executing for.
   *
   * The frozen boundary port commits against `runId` and `sessionId`, so a fabricated
   * identifier would mean a durable commit against a Run that does not exist. The caller
   * that owns the Run supplies the identity, and the executor asks for it per call because
   * one loop instance serves many Runs.
   */
  readonly identity: () => AgentExecutionIdentity;
  /** Mints the durable step id. The Run Layer owns Step identity, never this facade. */
  readonly createStepId: () => StepId;
}

/**
 * Create the legacy throwing facade.
 *
 * The synthetic turn sequence is deliberately monotonically increasing and never zero: a
 * turn ref must carry `sequence >= 1`, and a sequence that could be mistaken for "not
 * started" would be worse than no sequence at all. Phase 3B replaces this facade with a
 * real `AgentTurnRef` allocated by the Run Layer.
 */
export function createLegacyModelTurnExecutor(
  dependencies: LegacyModelTurnExecutorDependencies,
): LegacyModelTurnExecutor {
  let sequence = 0;

  return {
    async execute(input: {
      readonly request: AIModelRequest;
      readonly signal: AbortSignal;
      readonly streamSink?: ModelTurnStreamSink;
    }): Promise<AIModelTurnResult> {
      sequence += 1;
      const turn: AgentTurnRef = {
        stepId: dependencies.createStepId(),
        sequence,
      };

      const execution: ModelTurnExecutionInput = {
        identity: dependencies.identity(),
        turn,
        request: input.request,
        signal: input.signal,
        ...(input.streamSink === undefined ? {} : { streamSink: input.streamSink }),
      };
      const result = await dependencies.executor.execute(execution);

      switch (result.kind) {
        case "COMPLETED":
          return result.result;
        case "CANCELLED":
          // The legacy path is throw-based, and a cancellation must stay distinguishable
          // from an ordinary provider failure: `AI_ABORTED` is the code the legacy error
          // mapper reads to reach `CANCELLED` rather than a retryable failure.
          throw createAIError("AI_ABORTED", "The model turn was cancelled.");
        case "FAILED":
          throw toLegacyAIError(result.error);
      }
    },
  };
}

/**
 * Map a frozen failure code back onto the frozen AI error code.
 *
 * Only the codes the legacy consumers branch on keep a distinct identity; everything else
 * collapses to `AI_PROVIDER_ERROR`, which is exactly what the legacy mapper already did for
 * an unclassified provider failure. The reverse mapping is deliberately lossy in one
 * direction only: an AI code that mapped into a frozen code can be recovered here, and a
 * frozen code that never had an AI-specific spelling becomes the generic provider failure.
 */
function toLegacyAIError(error: {
  readonly code: string;
  readonly message: string;
  readonly retryAfterMs?: number;
}): AIError {
  const code = toAIErrorCode(error.code);
  return createAIError(code, error.message, {
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    // The original frozen error stays reachable for local debugging and is never
    // serialized.
    cause: error,
  });
}

function toAIErrorCode(code: string): AIErrorCode {
  switch (code) {
    case "AUTHENTICATION":
      return "AI_AUTHENTICATION";
    case "RATE_LIMIT":
      return "AI_RATE_LIMIT";
    case "NETWORK":
      return "AI_NETWORK";
    case "TIMEOUT":
      return "AI_TIMEOUT";
    case "CONTEXT_OVERFLOW":
      return "AI_CONTEXT_OVERFLOW";
    case "INVALID_RESPONSE":
      return "AI_INVALID_RESPONSE";
    case "UNSUPPORTED_MODEL":
      return "AI_MODEL_UNSUPPORTED";
    case "UNSUPPORTED_CAPABILITY":
      return "AI_CAPABILITY_UNSUPPORTED";
    default:
      return "AI_PROVIDER_ERROR";
  }
}
