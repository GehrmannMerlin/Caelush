import { AIError, createAIError } from "@caelush/ai";
import type { AIErrorCode, AIModelRequest, AIModelTurnResult } from "@caelush/ai";
import type {
  AgentExecutionIdentity,
  AgentTurnRef,
  ModelTurnExecutionInput,
  ModelTurnExecutor,
} from "@caelush/agent";
import type { StepId } from "@caelush/protocol";

/**
 * TRANSITIONAL — the legacy throwing facade over the frozen `ModelTurnExecutor`.
 *
 * Phase 3A aligned the agent executor with the frozen contract: one model turn now
 * resolves a `ModelTurnExecutionResult` union instead of throwing. The Core consumers that
 * were written against the previous throwing semantics — the legacy `AgentLoop` and the
 * verification `TaskAcceptanceReviewer` — keep working through this adapter:
 *
 * ```text
 * COMPLETED → the AIModelTurnResult
 * FAILED    → a thrown, mapped AIError
 * CANCELLED → a thrown cancellation signal (AIError AI_ABORTED)
 * ```
 *
 * The `@caelush/agent` package keeps no throwing public interface: this shape exists only
 * at the legacy host boundary and is deleted when the Core loop is replaced in Phase 3B.
 */

/** The legacy throwing model turn contract. */
export interface LegacyModelTurnExecutor {
  execute(input: {
    readonly request: AIModelRequest;
    readonly signal: AbortSignal;
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
