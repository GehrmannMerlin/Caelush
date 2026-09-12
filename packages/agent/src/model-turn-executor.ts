import { createAIModelTurnAssembler } from "@caelush/ai";
import type {
  AIGateway,
  AIModelRequest,
  AIModelTurnResult,
  AIStreamEvent,
} from "@caelush/ai";

/**
 * The transient stream sink.
 *
 * It observes the live event sequence for presentation purposes. Nothing it sees is
 * durable: a reasoning summary in particular is display-only and must never become
 * assistant content or session history.
 */
export interface ModelTurnStreamSink {
  onEvent?(event: AIStreamEvent): void;
}

/** One model turn request. */
export interface ModelTurnExecutionInput {
  readonly request: AIModelRequest;
  /**
   * The caller's cancellation signal.
   *
   * Forwarded to the gateway unchanged. The executor owns no timeout and no abort
   * scope of its own; the run layer owns those.
   */
  readonly signal: AbortSignal;
  readonly sink?: ModelTurnStreamSink;
}

/** The frozen collaborators of a model turn executor. */
export interface ModelTurnExecutorDependencies {
  readonly gateway: AIGateway;
}

/**
 * Executes exactly one model turn.
 *
 * Responsibilities, and nothing beyond them:
 *
 * ```text
 * AIGateway.stream()      → the one provider turn
 * AIStreamEvent           → transient sink and the frozen turn assembler
 * AIModelTurnAssembler    → AIModelTurnResult
 * ```
 *
 * It does not retry, sleep, back off, fail over, switch models, compact context,
 * execute tools, persist anything, verify anything, or know a provider dialect. A
 * `stream.error` rejects with the frozen `AIError`; it never becomes a fabricated
 * successful result, and a partially received tool call can never reach the result
 * because the assembler stores only completed calls.
 */
export interface ModelTurnExecutor {
  execute(input: ModelTurnExecutionInput): Promise<AIModelTurnResult>;
}

/** Create a model turn executor over the frozen AI gateway. */
export function createModelTurnExecutor(
  dependencies: ModelTurnExecutorDependencies,
): ModelTurnExecutor {
  return {
    async execute(input: ModelTurnExecutionInput): Promise<AIModelTurnResult> {
      // Exactly one gateway invocation per execute(): the durable run layer owns
      // retry, never this boundary.
      const stream = await dependencies.gateway.stream(input.request, { signal: input.signal });
      const assembler = createAIModelTurnAssembler();

      for await (const event of stream.events) {
        input.sink?.onEvent?.(event);
        assembler.accept(event);
      }

      // Throws the reconstructed AIError for a failed stream and AI_INVALID_RESPONSE
      // for a stream that never finished.
      return assembler.result();
    },
  };
}
