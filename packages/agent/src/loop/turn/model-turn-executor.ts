import { createAIModelTurnAssembler } from "@caelush/ai";
import { AIError } from "@caelush/ai";
import type { AIGateway, AIModelRequest, AIModelTurnResult, AIStreamEvent } from "@caelush/ai";

import type { AgentTransientStreamEvent } from "../events/transient-stream-event.js";
import type { ModelTurnStreamSink } from "../events/transient-stream-event.js";
import type { AgentExecutionIdentity, AgentTurnRef } from "../types.js";
import type { ModelTurnExecutionError, ModelTurnExecutionErrorCode } from "./model-turn-error.js";
import { isRetryableModelTurnErrorCode } from "./model-turn-error.js";

/**
 * The frozen model turn executor.
 *
 * ```text
 * input   identity + turn + request + signal + optional transient sink
 * output  COMPLETED(result) | FAILED(error) | CANCELLED
 * ```
 *
 * The union is the contract. A model failure is a *value*, not a thrown exception: the
 * durable Run Layer receives something it can classify, persist and retry on, instead of
 * an exception whose meaning depends on which call site caught it. There is one
 * exception left, and it is deliberate — a caller's own `AbortSignal` abort is reported
 * as `CANCELLED`, because cancellation is not a failure and must never be turned into a
 * retryable provider error.
 *
 * What the executor does not do, and must never start doing:
 *
 * ```text
 * retry, sleep, back off or fail over
 * persist, commit or touch a store
 * execute a tool
 * verify anything
 * build a request (that is ModelRequestBuilder)
 * classify a decision (that is AgentDecisionClassifier)
 * ```
 *
 * Exactly one gateway invocation per `execute()`. Retry authority belongs to the Run
 * Layer.
 */
export interface ModelTurnExecutionInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly request: AIModelRequest;
  /**
   * The caller's cancellation signal, forwarded to the gateway unchanged.
   *
   * The executor owns no timeout and no abort scope of its own; the Run Layer owns both.
   */
  readonly signal: AbortSignal;
  /** Presentation-only. Nothing it receives is durable. */
  readonly streamSink?: ModelTurnStreamSink;
}

/** The turn produced a settled result. */
export interface ModelTurnExecutionCompleted {
  readonly kind: "COMPLETED";
  readonly result: AIModelTurnResult;
}

/** The turn failed, with a sanitized frozen error. */
export interface ModelTurnExecutionFailed {
  readonly kind: "FAILED";
  readonly error: ModelTurnExecutionError;
}

/** The turn was cancelled. This is not a failure. */
export interface ModelTurnExecutionCancelled {
  readonly kind: "CANCELLED";
}

/** The frozen result union of one model turn execution. */
export type ModelTurnExecutionResult =
  ModelTurnExecutionCompleted | ModelTurnExecutionFailed | ModelTurnExecutionCancelled;

/** The frozen collaborators of a model turn executor. */
export interface ModelTurnExecutorDependencies {
  readonly gateway: AIGateway;
}

/** Execute exactly one model turn. */
export interface ModelTurnExecutor {
  execute(input: ModelTurnExecutionInput): Promise<ModelTurnExecutionResult>;
}

/** Create a model turn executor over the frozen AI gateway. */
export function createModelTurnExecutor(
  dependencies: ModelTurnExecutorDependencies,
): ModelTurnExecutor {
  return {
    async execute(input: ModelTurnExecutionInput): Promise<ModelTurnExecutionResult> {
      // Already cancelled before any provider work: no gateway invocation at all.
      if (input.signal.aborted) return { kind: "CANCELLED" };

      try {
        // Exactly one gateway invocation per execute(): the durable run layer owns
        // retry, never this boundary.
        const stream = await dependencies.gateway.stream(input.request, { signal: input.signal });
        const assembler = createAIModelTurnAssembler();

        for await (const event of stream.events) {
          publishTransient(input.streamSink, event);
          assembler.accept(event);
        }

        // Throws the reconstructed AIError for a failed stream and AI_INVALID_RESPONSE
        // for a stream that never finished.
        return { kind: "COMPLETED", result: assembler.result() };
      } catch (error) {
        return classifyTurnFailure(error, input.signal);
      }
    },
  };
}

/**
 * Forward only the three transient delta kinds to the sink.
 *
 * The gateway's envelope events — `stream.start`, `stream.finish`, `stream.error` —
 * plus `usage`, `tool_call.start` and `tool_call.completed` are deliberately not
 * forwarded: envelope lifecycle, accounting and the durable tool-call lifecycle each
 * belong to their own owner, and a host that received them here would have a second
 * unversioned copy of the turn lifecycle next to the frozen result.
 *
 * A sink failure is isolated. Presentation can never fail a model turn, and it can never
 * change the frozen result the durable layer will persist.
 */
function publishTransient(sink: ModelTurnStreamSink | undefined, event: AIStreamEvent): void {
  if (sink === undefined) return;
  const transient = toTransientEvent(event);
  if (transient === undefined) return;
  try {
    const published = sink.publish(transient);
    // An asynchronous sink owns its own delivery; a rejected publish is discarded for
    // the same reason a synchronous throw is.
    if (published !== undefined && typeof published.then === "function") {
      void published.then(undefined, () => undefined);
    }
  } catch {
    // Deliberately swallowed: a presentation failure is not a model failure.
  }
}

function toTransientEvent(event: AIStreamEvent): AgentTransientStreamEvent | undefined {
  switch (event.type) {
    case "text.delta":
      return { type: "text.delta", text: event.payload.text };
    case "reasoning.summary.delta":
      return { type: "thinking.delta", text: event.payload.text };
    case "tool_call.delta":
      return {
        type: "tool_call.delta",
        toolCallId: event.payload.toolCallId,
        delta: event.payload.delta,
      };
    default:
      return undefined;
  }
}

/**
 * Turn a thrown failure into the frozen union.
 *
 * An abort wins over whatever symptom the transport produced while unwinding, and it
 * becomes `CANCELLED` rather than a failure. Every other AI error is mapped into the
 * closed failure-code set; a non-AI throw becomes a generic `PROVIDER_ERROR`, because an
 * unknown throw at this boundary is a provider-side problem and its raw text must never
 * cross into a public error.
 */
function classifyTurnFailure(error: unknown, signal: AbortSignal): ModelTurnExecutionResult {
  if (signal.aborted || isAbortError(error)) return { kind: "CANCELLED" };
  return { kind: "FAILED", error: toModelTurnExecutionError(error) };
}

function isAbortError(error: unknown): boolean {
  return error instanceof AIError && error.code === "AI_ABORTED";
}

/** Map a thrown AI failure onto the closed frozen error set. */
export function toModelTurnExecutionError(error: unknown): ModelTurnExecutionError {
  if (!(error instanceof AIError)) {
    return failure("PROVIDER_ERROR", "The model turn failed.");
  }
  const code = toModelTurnExecutionErrorCode(error.code);
  // The AI core's own message is already sanitized and is the most accurate safe
  // description available, so it is preferred over a generic one.
  return {
    ...failure(code, error.message),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
}

/**
 * The frozen AI-error-code to model-turn-error-code mapping.
 *
 * It is exhaustive over `AIErrorCode`, so a new AI error code cannot be added without
 * this mapping being revisited.
 */
export function toModelTurnExecutionErrorCode(code: AIError["code"]): ModelTurnExecutionErrorCode {
  switch (code) {
    case "AI_AUTHENTICATION":
      return "AUTHENTICATION";
    case "AI_RATE_LIMIT":
      return "RATE_LIMIT";
    case "AI_NETWORK":
      return "NETWORK";
    case "AI_TIMEOUT":
      return "TIMEOUT";
    case "AI_CONTEXT_OVERFLOW":
      return "CONTEXT_OVERFLOW";
    case "AI_MODEL_UNSUPPORTED":
    case "AI_MODEL_METADATA_INCOMPLETE":
      return "UNSUPPORTED_MODEL";
    case "AI_CAPABILITY_UNSUPPORTED":
      return "UNSUPPORTED_CAPABILITY";
    case "AI_INVALID_RESPONSE":
    case "AI_INVALID_REQUEST":
      return "INVALID_RESPONSE";
    case "AI_ABORTED":
      // Reaching here without the cancellation path above would be a mapping bug; the
      // code is accepted so the mapping stays exhaustive, and the failure is reported as
      // a provider error rather than silently dropped.
      return "PROVIDER_ERROR";
    case "AI_PROVIDER_ERROR":
    case "AI_PROVIDER_NOT_FOUND":
    case "AI_ADAPTER_NOT_FOUND":
      return "PROVIDER_ERROR";
    default:
      return assertNeverCode(code);
  }
}

function assertNeverCode(code: never): never {
  throw new TypeError(`Unmapped AI error code: ${String(code)}`);
}

function failure(code: ModelTurnExecutionErrorCode, message: string): ModelTurnExecutionError {
  return { code, message, retryable: isRetryableModelTurnErrorCode(code) };
}

/** The request type this module's input carries, re-exported for host implementations. */
export type { AIModelRequest };
