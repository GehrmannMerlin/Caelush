import type { AIMessage } from "@caelush/ai";

import type { ContextEnginePort, ContextPrepareMode } from "./context/context-engine-port.js";
import {
  createAgentDecisionClassifier,
  type AgentDecisionClassifier,
} from "./decision/decision-classifier.js";
import type {
  AgentModelAdmissionDecision,
  AgentBudgetBlock,
  ModelRequestAdmissionPort,
} from "./ports/model-request-admission.js";
import type { ModelTurnBoundaryPort } from "./ports/model-turn-boundary.js";
import {
  createModelRequestBuilder,
  type ModelRequestBuilder,
} from "./turn/model-request-builder.js";
import type { ModelTurnExecutionError } from "./turn/model-turn-error.js";
import type { ModelTurnExecutor } from "./turn/model-turn-executor.js";
import type {
  AgentLoopAdvanceInput,
  AgentLoopAdvanceResult,
  AgentLoopFailureStage,
  AgentTurnInput,
  PreparedModelContext,
} from "./types.js";

/**
 * The frozen AgentLoop — one Reason Kernel.
 *
 * ```text
 * Turn Input
 *   ↓ ContextEnginePort.prepare()
 *   ↓ ModelRequestBuilder
 *   ↓ ModelRequestAdmissionPort
 *   ↓ ModelTurnBoundaryPort
 *   ↓ ModelTurnExecutor
 *   ↓ AgentDecisionClassifier
 *   ↓ AgentLoopAdvanceResult
 * ```
 *
 * `advance()` performs exactly one Reason. There is no `while`, so the loop cannot execute a
 * Tool and cannot run a Run. Everything a Run needs beyond this turn — step identity, time,
 * retry, timeout, budget policy, Run status, verification — belongs to a layer that injects a
 * port here or consumes the result.
 *
 * The order above is the correctness contract, not a suggestion:
 *
 * ```text
 * context is prepared first        a failed preparation must cost no provider call
 * admission precedes the boundary  a refused turn must not commit a durable Step
 * the boundary precedes the model  a durable commit failure must cost no provider call
 * ```
 */
export interface AgentLoop {
  advance(input: AgentLoopAdvanceInput): Promise<AgentLoopAdvanceResult>;
}

/**
 * The frozen collaborators of the AgentLoop.
 *
 * The shape is the whole dependency surface, and every entry is a port the Run Layer or the
 * host owns. There is deliberately no project inspector, relevant-file planner, context
 * builder, clock, step-id factory or lifecycle hook: a general kernel has no coding-agent
 * knowledge and no self-managed lifecycle.
 *
 * `modelTurnBoundary` is optional only so a unit test can drive the loop without a durable
 * store. In production it is required: the invariant it carries — *durable commit before
 * provider I/O* — is the phase's highest-priority recovery invariant, and a composition root
 * that omits it silently loses that guarantee.
 */
export interface AgentLoopDependencies {
  readonly contextEngine: ContextEnginePort;
  readonly modelTurnExecutor: ModelTurnExecutor;
  /** Defaults to the frozen classifier. Injected so a host can prove an alternate decision. */
  readonly decisionClassifier?: AgentDecisionClassifier;
  /** Absent means no admission authority is configured and the turn is admitted. */
  readonly modelAdmission?: ModelRequestAdmissionPort;
  /** Absent means no durable boundary is configured and no commit precedes the model. */
  readonly modelTurnBoundary?: ModelTurnBoundaryPort;
  /** Defaults to the frozen builder. Injected so a host can swap in its own request policy. */
  readonly modelRequestBuilder?: ModelRequestBuilder;
}

/** Create the frozen AgentLoop over explicit ports. */
export function createAgentLoop(dependencies: AgentLoopDependencies): AgentLoop {
  const classifier = dependencies.decisionClassifier ?? createAgentDecisionClassifier();
  const requestBuilder = dependencies.modelRequestBuilder ?? createModelRequestBuilder();

  return {
    async advance(input: AgentLoopAdvanceInput): Promise<AgentLoopAdvanceResult> {
      const appended = appendedByInput(input.input);

      if (input.signal.aborted) return { status: "CANCELLED" };

      /* 1. Context. A failed preparation costs no durable Step and no provider call. */
      const first = await prepare(dependencies.contextEngine, input, "NORMAL");
      if (first.kind === "CANCELLED") return { status: "CANCELLED" };
      if (first.kind === "FAILED") return failed("CONTEXT", first.error, appended);
      let context = first.context;

      // The request is built from the prepared context only, and it is rebuilt for the
      // recovery attempt below so a retried turn can never resend the context it overflowed.
      let request = buildRequest(requestBuilder, input, context);

      /* 2. Admission. A refusal must not reach the boundary or the provider. */
      if (dependencies.modelAdmission !== undefined) {
        let decision: AgentModelAdmissionDecision;
        try {
          decision = await dependencies.modelAdmission.admit({
            identity: input.identity,
            turn: input.turn,
            request,
            model: input.model,
            signal: input.signal,
          });
        } catch (error) {
          return failed("ADMISSION", toInternalFailure(error), appended);
        }
        if (input.signal.aborted) return { status: "CANCELLED" };
        if (decision.kind === "BLOCKED") {
          return {
            status: "FAILED",
            stage: "ADMISSION",
            error: budgetFailure(decision.block),
            messagesToAppend: appended,
            budgetBlock: decision.block,
          };
        }
      }

      /* 3. The durable boundary. Only a successful commit may open provider I/O. */
      if (dependencies.modelTurnBoundary !== undefined) {
        try {
          await dependencies.modelTurnBoundary.beforeExecute({
            identity: input.identity,
            turn: input.turn,
            request,
            model: input.model,
          });
        } catch (error) {
          return failed("BOUNDARY", toInternalFailure(error), appended);
        }
        if (input.signal.aborted) return { status: "CANCELLED" };
      }

      /* 4. The model turn. At most two provider attempts, and only for overflow. */
      let execution = await executeTurn(dependencies.modelTurnExecutor, input, request);

      if (
        execution.kind === "FAILED" &&
        execution.error.code === "CONTEXT_OVERFLOW" &&
        !input.signal.aborted
      ) {
        // Exactly one forced recovery. A context that overflows twice is exhausted rather
        // than unlucky, and a third identical attempt would only spend another provider call.
        const recovered = await prepare(dependencies.contextEngine, input, "FORCED_RECOVERY");
        if (recovered.kind === "CANCELLED") return { status: "CANCELLED" };
        if (recovered.kind === "FAILED") return failed("CONTEXT", recovered.error, appended);
        context = recovered.context;
        // Recovery is only real if the engine says it produced a context that fits. An engine
        // that cannot compact must not cost a second, identical provider call.
        if (context.recovered !== true) {
          return failed("MODEL", contextExhaustedFailure(), appended, context);
        }
        request = buildRequest(requestBuilder, input, context);
        execution = await executeTurn(dependencies.modelTurnExecutor, input, request);
      }

      if (execution.kind === "CANCELLED") return { status: "CANCELLED" };
      if (execution.kind === "FAILED") {
        // A second overflow is context exhaustion, not a provider failure: retrying it at the
        // Run layer would repeat the same rejected request.
        const error =
          execution.error.code === "CONTEXT_OVERFLOW" ? contextExhaustedFailure() : execution.error;
        // An executor that owns an admission or boundary step of its own reports that stage, so
        // the Run Layer settles the right lifecycle instead of seeing a generic model failure.
        return failed(execution.error.stage ?? "MODEL", error, appended, context, "FAILED");
      }

      /* 5. Classification. A rejected turn is a failure, never a decision. */
      try {
        const decision = classifier.classify(execution.result);
        return {
          status: "COMPLETED",
          decision,
          messagesToAppend: [...appended, decision.modelTurn.assistantMessage],
          ...contextReport(context),
        };
      } catch (error) {
        // The provider turn *did* complete: the model answered and the answer was unusable. The
        // Run Layer records that distinction, and reporting it as a failed provider attempt
        // would lose it.
        return {
          ...failed("MODEL", toInternalFailure(error), appended, context, "COMPLETED"),
          ...(execution.result.usage === undefined ? {} : { usage: execution.result.usage }),
        };
      }
    },
  };
}

/* ------------------------------------------------------------------ helpers */

function buildRequest(
  builder: ModelRequestBuilder,
  input: AgentLoopAdvanceInput,
  context: PreparedModelContext,
): ReturnType<ModelRequestBuilder["build"]> {
  return builder.build({
    context,
    model: input.model,
    tools: input.tools,
    ...(input.settings === undefined ? {} : { settings: input.settings }),
  });
}

function executeTurn(
  executor: ModelTurnExecutor,
  input: AgentLoopAdvanceInput,
  request: ReturnType<ModelRequestBuilder["build"]>,
): ReturnType<ModelTurnExecutor["execute"]> {
  return executor.execute({
    identity: input.identity,
    turn: input.turn,
    request,
    signal: input.signal,
    ...(input.streamSink === undefined ? {} : { streamSink: input.streamSink }),
  });
}

type PreparedAttempt =
  | { readonly kind: "PREPARED"; readonly context: PreparedModelContext }
  | { readonly kind: "FAILED"; readonly error: ModelTurnExecutionError }
  | { readonly kind: "CANCELLED" };

async function prepare(
  engine: ContextEnginePort,
  input: AgentLoopAdvanceInput,
  mode: ContextPrepareMode,
): Promise<PreparedAttempt> {
  try {
    const context = await engine.prepare({
      identity: input.identity,
      turn: input.turn,
      history: input.history,
      input: input.input,
      model: input.model,
      tools: input.tools,
      mode,
      signal: input.signal,
    });
    if (input.signal.aborted) return { kind: "CANCELLED" };
    return { kind: "PREPARED", context };
  } catch (error) {
    if (input.signal.aborted) return { kind: "CANCELLED" };
    return { kind: "FAILED", error: toContextFailure(error) };
  }
}

/**
 * The messages a turn input contributes, before the assistant message.
 *
 * ```text
 * USER_INPUT     the user delta
 * TOOL_RESULTS   the normalized tool results
 * CONTINUATION   the supplied continuation messages, if any
 * ```
 */
function appendedByInput(input: AgentTurnInput): readonly AIMessage[] {
  if (input.kind === "USER_INPUT") return input.messages;
  if (input.kind === "TOOL_RESULTS") return input.results;
  return input.messages ?? [];
}

function failed(
  stage: AgentLoopFailureStage,
  error: ModelTurnExecutionError,
  messagesToAppend: readonly AIMessage[],
  context?: PreparedModelContext,
  providerTurnState?: import("./types.js").AgentProviderTurnState,
): AgentLoopAdvanceResult {
  return {
    status: "FAILED",
    stage,
    error,
    messagesToAppend: [...messagesToAppend],
    ...(context === undefined ? {} : contextReport(context)),
    ...(providerTurnState === undefined ? {} : { providerTurnState }),
  };
}

function contextReport(context: PreparedModelContext): {
  readonly contextReport?: Readonly<Record<string, unknown>>;
} {
  return context.report === undefined ? {} : { contextReport: context.report };
}

/**
 * A context preparation failure, in the frozen failure vocabulary.
 *
 * A context that no longer fits the window is reported as `CONTEXT_OVERFLOW`, because that is
 * the one condition the loop knows how to recover from. An engine failure that is not about
 * the window — an unreachable project, a broken renderer — is something the loop cannot
 * classify, so it fails closed rather than inventing a recovery.
 *
 * The engine's own message is never reused: it may quote a path, a document or a prompt. The
 * message here is always a fixed, safe summary.
 */
function toContextFailure(error: unknown): ModelTurnExecutionError {
  return isContextOverflow(error)
    ? {
        code: "CONTEXT_OVERFLOW",
        message: "The prepared model context exceeds the model context window.",
        retryable: false,
        cause: error,
      }
    : {
        code: "PROVIDER_ERROR",
        message: "The model context could not be prepared.",
        retryable: false,
        cause: error,
      };
}

/**
 * Recognize a cancelled or exhausted context window structurally.
 *
 * A structural read keeps the loop working with either a Context Engine that owns an overflow
 * error class or a host adapter that re-tags the condition, and it avoids a dependency from
 * the general kernel onto any particular context implementation.
 */
function isContextOverflow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly name?: unknown };
  if (
    typeof candidate.code === "string" &&
    /CONTEXT_OVERFLOW|CONTEXT_BUDGET/i.test(candidate.code)
  ) {
    return true;
  }
  return (
    typeof candidate.name === "string" &&
    /ContextBudgetExceeded|ContextOverflow/.test(candidate.name)
  );
}

/** The frozen failure for a context that could not be recovered within the attempt budget. */
function contextExhaustedFailure(): ModelTurnExecutionError {
  return {
    code: "CONTEXT_OVERFLOW",
    message: "The model context is exhausted and could not be recovered.",
    retryable: false,
  };
}

/**
 * A durable budget refusal, in the frozen failure vocabulary.
 *
 * `UNAVAILABLE` is not `EXCEEDED`. Failing to establish enforcement at all is a fail-closed
 * configuration outcome, and reporting it as an exceeded budget would tell the Run Layer that
 * a limit was spent when none was ever applied.
 */
function budgetFailure(block: AgentBudgetBlock): ModelTurnExecutionError {
  return block.kind === "UNAVAILABLE"
    ? {
        code: "PROVIDER_ERROR",
        message: "Budget enforcement is unavailable for this model turn.",
        retryable: false,
      }
    : {
        code: "PROVIDER_ERROR",
        message: "The configured Run budget would be exceeded.",
        retryable: false,
      };
}

/**
 * An unexpected throw from a port, in the frozen failure vocabulary.
 *
 * The throw's own text never crosses: a port may have surfaced a provider body, a prompt or a
 * credential. Only the fact that the port failed is reported. The original value is kept as
 * `cause` so a host boundary can classify it again without the kernel learning what it was.
 */
function toInternalFailure(error: unknown): ModelTurnExecutionError {
  return {
    code: "PROVIDER_ERROR",
    message: "The model turn failed.",
    retryable: false,
    cause: error,
  };
}
