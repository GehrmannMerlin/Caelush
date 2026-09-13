import type { AIMessage } from "@caelush/ai";

import type { ContextEnginePort, ContextPrepareMode } from "./context/context-engine-port.js";
import type { AgentDecisionClassifier } from "./decision/decision-classifier.js";
import { toAgentModelTurn } from "./decision/decision.js";
import type {
  ModelRequestAdmissionDecision,
  ModelRequestAdmissionPort,
} from "./ports/model-request-admission.js";
import type { ModelTurnBoundaryPort } from "./ports/model-turn-boundary.js";
import { toAgentError, toBudgetAgentError } from "./turn/agent-error-projection.js";
import {
  createModelRequestBuilder,
  type ModelRequestBuilder,
} from "./turn/model-request-builder.js";
import type { ModelTurnExecutionError } from "./turn/model-turn-error.js";
import type { ModelTurnExecutor } from "./turn/model-turn-executor.js";
import type {
  AgentLoopAdvanceInput,
  AgentLoopAdvanceResult,
  AgentLoopContextReceipt,
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
 * builder, clock, step-id factory, request builder or lifecycle hook: a general kernel has no
 * coding-agent knowledge, no self-managed lifecycle, and no configurable request policy that
 * could become a second decision authority.
 *
 * `decisionClassifier` is required. A defaulted classifier would let a composition root omit
 * the one component that turns a settled turn into a decision, and the loop would silently
 * supply its own authority; the composition root calls `createAgentDecisionClassifier()`
 * instead.
 *
 * `modelTurnBoundary` is optional only so a unit test can drive the loop without a durable
 * store. In production it is required: the invariant it carries — *durable commit before
 * provider I/O* — is the phase's highest-priority recovery invariant, and a composition root
 * that omits it silently loses that guarantee.
 */
export interface AgentLoopDependencies {
  readonly contextEngine: ContextEnginePort;

  readonly modelTurnExecutor: ModelTurnExecutor;

  readonly decisionClassifier: AgentDecisionClassifier;

  /** Absent means no admission authority is configured and the turn is admitted. */
  readonly modelAdmission?: ModelRequestAdmissionPort;

  /** Absent means no durable boundary is configured and no commit precedes the model. */
  readonly modelTurnBoundary?: ModelTurnBoundaryPort;
}

/** Create the frozen AgentLoop over explicit ports. */
export function createAgentLoop(dependencies: AgentLoopDependencies): AgentLoop {
  const classifier = dependencies.decisionClassifier;
  // The request builder is an implementation detail, not a port: a host that could swap it
  // could build a request the admission and boundary ports never saw.
  const requestBuilder = createModelRequestBuilder();

  return {
    async advance(input: AgentLoopAdvanceInput): Promise<AgentLoopAdvanceResult> {
      const appended = appendedByInput(input.input);

      if (input.signal.aborted) return cancelled(input.turn);

      /* 1. Context. A failed preparation costs no durable Step and no provider call. */
      const first = await prepare(dependencies.contextEngine, input, "NORMAL");
      if (first.kind === "CANCELLED") return cancelled(input.turn);
      if (first.kind === "FAILED") return failed(input.turn, first.error, appended);
      let context = first.context;
      let recovery: AgentLoopContextReceipt["recovery"] = "NONE";

      // The request is built from the prepared context only, and it is rebuilt for the
      // recovery attempt below so a retried turn can never resend the context it overflowed.
      let request = buildRequest(requestBuilder, input, context);

      /* 2. Admission. A refusal must not reach the boundary or the provider. */
      if (dependencies.modelAdmission !== undefined) {
        let decision: ModelRequestAdmissionDecision;
        try {
          decision = await dependencies.modelAdmission.admit({
            identity: input.identity,
            turn: input.turn,
            request,
          });
        } catch {
          return failed(input.turn, toInternalFailure(), appended, receipt(context, recovery));
        }
        if (input.signal.aborted) return cancelled(input.turn, receipt(context, recovery));
        if (decision.kind === "BLOCKED") {
          return {
            kind: "FAILED",
            turn: input.turn,
            error: toBudgetAgentError(decision.block),
            messagesToAppend: [...appended],
            context: receipt(context, recovery),
          };
        }
        // The admitted request is the one that executes. Admission may restate it — a clamped
        // output ceiling, for instance — and ignoring the restatement would spend the provider
        // call on a request the budget authority never approved.
        request = decision.request;
      }

      /* 3. The durable boundary. Only a successful commit may open provider I/O. */
      if (dependencies.modelTurnBoundary !== undefined) {
        try {
          await dependencies.modelTurnBoundary.beforeExecute({
            identity: input.identity,
            turn: input.turn,
            model: input.model.ref,
          });
        } catch {
          return failed(input.turn, toInternalFailure(), appended, receipt(context, recovery));
        }
        if (input.signal.aborted) return cancelled(input.turn, receipt(context, recovery));
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
        // The engine must reject a `FORCED_RECOVERY` preparation it cannot satisfy: a context
        // that does not actually fit must never be answered with, because the loop would then
        // spend a second provider call on the very context that was just rejected.
        const recovered = await prepare(dependencies.contextEngine, input, "FORCED_RECOVERY");
        if (recovered.kind === "CANCELLED")
          return cancelled(input.turn, receipt(context, recovery));
        if (recovered.kind === "FAILED") {
          return failed(input.turn, recovered.error, appended, receipt(context, recovery));
        }
        context = recovered.context;
        recovery = "FORCED_CONTEXT_RECOVERY";
        request = buildRequest(requestBuilder, input, context);
        execution = await executeTurn(dependencies.modelTurnExecutor, input, request);
      }

      const contextReceipt = receipt(context, recovery);
      if (execution.kind === "CANCELLED") return cancelled(input.turn, contextReceipt);
      if (execution.kind === "FAILED") {
        // A second overflow is context exhaustion, not a provider failure: retrying it at the
        // Run layer would repeat the same rejected request.
        const error =
          execution.error.code === "CONTEXT_OVERFLOW" ? contextExhaustedFailure() : execution.error;
        return {
          kind: "FAILED",
          turn: input.turn,
          error: toAgentError(error),
          messagesToAppend: [...appended],
          context: contextReceipt,
          ...retryMetadata(error),
        };
      }

      /* 5. Classification. A rejected turn is a failure, never a decision. */
      try {
        const decision = classifier.classify(execution.result);
        const base = {
          turn: input.turn,
          modelTurn: decision.modelTurn,
          messagesToAppend: [...appended, decision.modelTurn.assistantMessage],
          context: contextReceipt,
        };
        return decision.type === "TOOL_CALLS_REQUESTED"
          ? { kind: "TOOL_REQUESTS", ...base, decision }
          : { kind: "FINAL_CANDIDATE", ...base, decision };
      } catch {
        // The provider turn *did* complete: the model answered and the answer was unusable.
        // Reporting it as a failed provider attempt would lose that distinction, which is why
        // the settled turn travels with the failure.
        const modelTurn = toAgentModelTurn(execution.result);
        const failure = toInternalFailure();
        return {
          kind: "FAILED",
          turn: input.turn,
          ...(modelTurn === undefined ? {} : { modelTurn }),
          error: toAgentError(failure),
          messagesToAppend: [...appended],
          context: contextReceipt,
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
    ...(input.modelSettings === undefined ? {} : { settings: input.modelSettings }),
  });
}

function executeTurn(
  executor: ModelTurnExecutor,
  input: AgentLoopAdvanceInput,
  request: ReturnType<ModelRequestBuilder["build"]>,
): ReturnType<ModelTurnExecutor["execute"]> {
  // No stream sink crosses here. Live deltas belong to the executor the composition root
  // binds, so `advance()` needs no presentation input at all.
  return executor.execute({
    identity: input.identity,
    turn: input.turn,
    request,
    signal: input.signal,
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
  turn: AgentLoopAdvanceInput["turn"],
  error: ModelTurnExecutionError,
  messagesToAppend: readonly AIMessage[],
  context?: AgentLoopContextReceipt,
): AgentLoopAdvanceResult {
  return {
    kind: "FAILED",
    turn,
    error: toAgentError(error),
    messagesToAppend: [...messagesToAppend],
    ...(context === undefined ? {} : { context }),
  };
}

/**
 * The cancelled result.
 *
 * `messagesToAppend` is deliberately empty: partial assistant output is discarded on
 * cancellation, and a turn's own input is the caller's ledger rather than this Reason's
 * output appending it here would double-count it.
 */
function cancelled(
  turn: AgentLoopAdvanceInput["turn"],
  context?: AgentLoopContextReceipt,
): AgentLoopAdvanceResult {
  return {
    kind: "CANCELLED",
    turn,
    messagesToAppend: [],
    ...(context === undefined ? {} : { context }),
  };
}

/** The receipt of the context this Reason actually ran on. */
function receipt(
  context: PreparedModelContext,
  recovery: AgentLoopContextReceipt["recovery"],
): AgentLoopContextReceipt {
  return {
    report: context.report,
    observationPolicy: context.observationPolicy,
    recovery,
  };
}

/** The retry hint a transient provider condition carries, and nothing more. */
function retryMetadata(error: ModelTurnExecutionError): {
  readonly retry?: import("./types.js").AgentRetryMetadata;
} {
  if (!error.retryable) return {};
  return {
    retry: {
      code: error.code,
      retryable: true,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    },
  };
}

/**
 * A context preparation failure, in the frozen failure vocabulary.
 *
 * A context that no longer fits the window is reported as `CONTEXT_OVERFLOW`, because that is
 * the one condition the loop knows how to recover from. An engine failure that is not about
 * the window — an unreachable project, a broken renderer — is something the loop cannot
 * classify, so it fails closed rather than inventing a recovery.
 *
 * The engine's own value is never carried: it may quote a path, a document or a prompt. The
 * loop reports only that preparation failed, and the caller that owns the Context Engine —
 * which is the caller that can classify its own implementation's errors — keeps the original
 * value in its own channel.
 */
function toContextFailure(error: unknown): ModelTurnExecutionError {
  return isContextOverflow(error)
    ? {
        code: "CONTEXT_OVERFLOW",
        message: "The prepared model context exceeds the model context window.",
        retryable: false,
      }
    : {
        code: "PROVIDER_ERROR",
        message: "The model context could not be prepared.",
        retryable: false,
      };
}

/**
 * Recognize a cancelled or exhausted context window structurally.
 *
 * A structural read keeps the loop working with either a Context Engine that owns an overflow
 * error class or a host adapter that re-tags the condition, and it avoids a dependency from
 * the general kernel onto any particular context implementation.
 *
 * An exhausted window and an over-budget one are the same condition for this loop: both mean the
 * context does not fit, and both are recovered the same way — or not at all.
 */
function isContextOverflow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly name?: unknown };
  if (
    typeof candidate.code === "string" &&
    /CONTEXT_OVERFLOW|CONTEXT_BUDGET|CONTEXT_EXHAUSTED/i.test(candidate.code)
  ) {
    return true;
  }
  return (
    typeof candidate.name === "string" &&
    /ContextBudgetExceeded|ContextOverflow|ContextExhausted/.test(candidate.name)
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
 * An unexpected throw from a port, in the frozen failure vocabulary.
 *
 * The throw's own text never crosses: a port may have surfaced a provider body, a prompt or a
 * credential. Only the fact that the port failed is reported, and the original value stays in
 * the caller's own channel — it is never a field of an `@caelush/agent` contract.
 */
function toInternalFailure(): ModelTurnExecutionError {
  return {
    code: "PROVIDER_ERROR",
    message: "The model turn failed.",
    retryable: false,
  };
}
