import type {
  AIAssistantMessage,
  AIErrorCode,
  AIMessage,
  AIToolSpec,
  ModelUsage,
} from "@caelush/ai";
import type {
  AgentBudgetBlock as FrozenAgentBudgetBlock,
  AgentDecision,
  AgentExecutionIdentity,
  AgentLoopAdvanceInput,
  AgentLoopAdvanceResult,
  AgentLoop as FrozenAgentLoop,
  AgentLoopFailedResult,
  AgentRetryMetadata as FrozenAgentRetryMetadata,
  AgentTurnRef,
  ContextBuildReport,
  ContextEnginePort,
  ContextPrepareInput,
  PreparedModelContext,
  ModelRequestAdmissionPort,
  ModelTurnBoundaryPort,
  ModelTurnExecutionErrorCode,
  ModelTurnExecutor,
} from "@caelush/agent";
import { createAgentDecisionClassifier, createAgentLoop, toAIModelSettings } from "@caelush/agent";
import { toModelTurnExecutionError } from "./model-turn-error-mapping.js";
import type {
  AgentError,
  AgentRun,
  AgentState,
  AgentStep,
  StepId,
  TimestampMs,
} from "@caelush/protocol";
import {
  beginAgentStepState,
  cancelAgentStepState,
  markAgentStateCancelled,
  markAgentStateMaxStepsReached,
  markAgentStateVerifying,
  settleAgentStepState,
} from "./agent-state.js";
import {
  cancelAgentStep,
  completeAgentStep,
  createRunningAgentStep,
  failAgentStep,
} from "./agent-step.js";
import { evaluateAgentStepGate } from "./agent-step-gate.js";
import { normalizeToolResultBatch } from "./agent-tool-results.js";
import { summarizeAgentDecision } from "./agent-summary.js";
import type {
  AgentLoopCancelledResult,
  AgentLoopCommonInput,
  AgentLoopContinuationInput,
  AgentLoopExecutionResult,
  AgentLoopFailureResult,
  AgentLoopOutcomeResult,
  AgentLoopResumeInput,
  AgentLoopStartInput,
} from "./agent-loop-input.js";
import { AgentBudgetAdmissionError } from "./agent-errors.js";
import { isAIAbortError, mapAgentLoopError } from "./agent-error-mapper.js";
import { prepareResumeHistory, validateAgentLoopInput } from "./agent-loop-history.js";
import type {
  AgentLoopDependencies,
  AgentLoopLifecycleHooks,
  AgentProviderTurnState,
} from "./agent-loop-ports.js";
import { createLegacyContextRuntimeAdapter } from "./legacy-context-runtime-adapter.js";
import {
  createLegacyFacadeConversation,
  type LegacyFacadeTurnInput,
} from "./legacy-agent-conversation.js";

/**
 * The legacy Core AgentLoop facade.
 *
 * ```text
 * run()                     → advance(USER_INPUT)
 * resumeWithToolResults()   → advance(TOOL_RESULTS)
 * ```
 *
 * Phase 3B made the frozen `@caelush/agent` `AgentLoop.advance()` the only Reason
 * implementation. This facade is the Run Layer's compatibility surface over it: it owns the
 * lifecycle the general kernel deliberately does not — the max-step gate, Step identity and
 * settlement, `AgentState` projection, the durable provider-turn boundary, and the durable
 * legacy message shape the RunController persists.
 *
 * It creates the Step. The frozen loop never does, and it never receives a clock, a step-id
 * factory or an `AgentState`. Step ownership moves to the Run Layer in the next phase.
 */
export class AgentLoop {
  constructor(private readonly dependencies: AgentLoopDependencies) {}

  withLifecycleHooks(lifecycle: AgentLoopLifecycleHooks): AgentLoop {
    return new AgentLoop({ ...this.dependencies, lifecycle });
  }

  async run(input: AgentLoopStartInput): Promise<AgentLoopExecutionResult> {
    validateAgentLoopInput(input);
    if (input.signal.aborted) return this.cancelledBeforeStep(input);
    const currentUserMessage = { role: "user" as const, content: input.run.goal };
    const gate = evaluateAgentStepGate(input.state, input.run.limits);
    if (!gate.allowed) {
      return this.maxStepsResult(input.state, gate.outcome, [currentUserMessage]);
    }

    return this.advanceTurn(
      input,
      gate.nextSequence,
      { kind: "USER_INPUT", messages: [currentUserMessage] },
      input.history,
      [currentUserMessage],
    );
  }

  /**
   * Continue the same Run without a new user message.
   *
   * A verification repair is a continuation, not a new user request: the Run, the Session and
   * the durable conversation all stay as they are, and only the Run Layer's repair context
   * changes what the next Reason is shown. Expressing it as a `USER_INPUT` would re-append the
   * Run's goal as if the user had typed it again, which is both a duplicate durable message and
   * a false statement about who produced it.
   */
  async continueRun(input: AgentLoopContinuationInput): Promise<AgentLoopExecutionResult> {
    validateAgentLoopInput(input);
    if (input.signal.aborted) return this.cancelledBeforeStep(input);

    const gate = evaluateAgentStepGate(input.state, input.run.limits);
    if (!gate.allowed) return this.maxStepsResult(input.state, gate.outcome, []);

    return this.advanceTurn(
      input,
      gate.nextSequence,
      {
        kind: "CONTINUATION",
        reason: input.reason,
        ...(input.messages === undefined ? {} : { messages: input.messages }),
      },
      input.history,
      // A continuation contributes no caller-visible message of its own: the previous Reasons'
      // messages are already durable, so re-appending anything here would duplicate the ledger.
      input.messages ?? [],
    );
  }

  async resumeWithToolResults(input: AgentLoopResumeInput): Promise<AgentLoopExecutionResult> {
    validateAgentLoopInput(input);
    if (input.signal.aborted) return this.cancelledBeforeStep(input);

    let normalizedResults;
    try {
      normalizedResults = normalizeToolResultBatch(
        input.pendingDecision.toolRequests,
        input.toolResults,
      );
    } catch (error) {
      if (input.signal.aborted) return this.cancelledBeforeStep(input);
      return this.failureBeforeStep(input.state, mapAgentLoopError(error), []);
    }

    // The legacy history invariants stay in force: the open user turn must be intact, the
    // pending assistant must match the decision, and the results must not already be present.
    try {
      prepareResumeHistory(
        input.history,
        input.pendingDecision,
        normalizedResults,
        input.historySourceSequences,
      );
    } catch (error) {
      if (input.signal.aborted) return this.cancelledBeforeStep(input);
      return this.failureBeforeStep(input.state, mapAgentLoopError(error), []);
    }

    const gate = evaluateAgentStepGate(input.state, input.run.limits);
    if (!gate.allowed) return this.maxStepsResult(input.state, gate.outcome, normalizedResults);

    return this.advanceTurn(
      input,
      gate.nextSequence,
      {
        kind: "TOOL_RESULTS",
        // The durable Step that requested these tools, supplied by the Run Layer. It is never
        // the model turn's call identity and never this attempt's own Step: the frozen field
        // names the AgentStep a recovery must re-open, not the provider call that asked.
        sourceStepId: input.sourceStepId,
        pendingDecision: input.pendingDecision,
        results: normalizedResults,
      },
      // Phase 5D's compatibility translator needs the pending assistant together with the open
      // user turn. The durable-ID input then selects the newly appended Tool-result records; it
      // must not reconstruct the assistant from the pending decision or pass a partial history.
      input.history,
      normalizedResults,
    );
  }

  /**
   * One Reason through the frozen loop, wrapped in the legacy Step lifecycle.
   *
   * The Step is created before `advance()` so a durable boundary can commit against a real
   * `AgentTurnRef`. A failure before that boundary settles no Step, because no provider
   * attempt ever happened.
   */
  private async advanceTurn(
    input: AgentLoopCommonInput & { readonly signal: AbortSignal },
    sequence: number,
    turnInput: LegacyFacadeTurnInput,
    history: readonly AIMessage[],
    appendPrefix: readonly AIMessage[],
  ): Promise<AgentLoopExecutionResult> {
    const startedAt = monotonicNow(input.state, this.dependencies.clock.now());
    const step = createRunningAgentStep({
      id: this.dependencies.stepIdFactory.create(),
      runId: input.run.id,
      sequence,
      startedAt,
    });
    const activeState = beginAgentStepState(input.state, step.id, startedAt);
    if (input.signal.aborted) return this.cancelledAfterStep(activeState, step, undefined, false);

    const identity = turnIdentity(input.run);
    this.dependencies.resolveTurnIdentity?.(input.run);
    const turn: AgentTurnRef = { stepId: step.id, sequence };

    // The composition for this turn, plus the Core-private record of what the ports this
    // facade owns actually did. The frozen result deliberately reports none of it: the caller
    // that composes the ports is the only party that knows where a Reason failed.
    const { loop, outcome } = this.reason(input, step, activeState);

    let result: AgentLoopAdvanceResult;
    try {
      const settings =
        input.modelSettings === undefined ? undefined : toAIModelSettings(input.modelSettings);
      const durable = createLegacyFacadeConversation({
        run: input.run,
        history,
        appendPrefix,
        turnInput,
      });
      const advanceInput: AgentLoopAdvanceInput = {
        identity,
        turn,
        conversation: durable.conversation,
        input: durable.input,
        model: this.dependencies.models.resolve(input.run.model),
        tools: input.tools ?? [],
        ...(settings === undefined ? {} : { modelSettings: settings }),
        signal: input.signal,
      };
      result = await loop.advance(advanceInput);
    } catch (error) {
      // A throw that escapes `advance()` is an infrastructure failure, not a model outcome.
      if (input.signal.aborted) return this.cancelledAfterStep(activeState, step, undefined, false);
      return this.failureAfterStep(
        activeState,
        step,
        undefined,
        appendPrefix,
        mapAgentLoopError(error),
        undefined,
        undefined,
        "NOT_STARTED",
      );
    }

    switch (result.kind) {
      case "CANCELLED":
        return this.cancelledAfterStep(activeState, step, result.context?.report, true, result);
      case "FAILED":
        return this.failureFromAdvance(input, activeState, step, result, appendPrefix, outcome);
      case "TOOL_REQUESTS":
      case "FINAL_CANDIDATE": {
        const decision = result.decision;
        const finishedAt = monotonicNow(activeState, this.dependencies.clock.now());
        const usage = result.modelTurn.usage;
        const completedStep = completeAgentStep(step, {
          finishedAt,
          reasoningSummary: summarizeAgentDecision(decision),
        });
        const settledState = settleAgentStepState(
          activeState,
          usage === undefined
            ? { stepId: step.id, now: finishedAt }
            : { stepId: step.id, usage, now: finishedAt },
        );
        const decidedState =
          decision.type === "FINAL_CANDIDATE"
            ? markAgentStateVerifying(settledState, finishedAt)
            : settledState;
        return this.outcome(
          decision,
          decidedState,
          completedStep,
          result.context.report,
          [...appendPrefix, projectAssistantMessage(result.modelTurn)],
          result,
        );
      }
    }
  }

  /**
   * Assemble the frozen loop for one turn.
   *
   * The legacy Context System and the legacy provider-turn hooks are both configured per turn —
   * base prompt, limits, cwd, explicit paths, and the Step the hooks commit — so the adapters
   * are built here rather than once per loop. This method is the only place the Core boundary
   * learns that a legacy context implementation and a legacy lifecycle hook exist.
   *
   * It is also where Core keeps the record the frozen result deliberately does not carry: which
   * port failed, whether the provider was contacted, and how it answered. Every value is read
   * from a port *this* facade owns, so nothing has to be smuggled through an `@caelush/agent`
   * contract to be observable here.
   */
  private reason(
    input: AgentLoopCommonInput,
    step: AgentStep,
    state: AgentState,
  ): { readonly loop: FrozenAgentLoop; readonly outcome: CoreTurnOutcome } {
    const legacy = this.dependencies.modelTurns;
    const lifecycle = this.dependencies.lifecycle;
    const presentation = this.dependencies.streamSink;
    const outcome: CoreTurnOutcome = { providerTurnState: "NOT_STARTED" };

    const modelTurnExecutor: ModelTurnExecutor = {
      execute: async (execution) => {
        if (execution.signal.aborted) return { kind: "CANCELLED" as const };
        try {
          const result = await legacy.execute({
            request: execution.request,
            signal: execution.signal,
            // The frozen `advance()` has no presentation input, so the sink is bound here: the
            // composition decorates the `ModelTurnExecutor`, and this facade is that decoration
            // for the Core path. It lands on the frozen `ModelTurnExecutionInput`, which is the
            // only contract that may carry live deltas.
            ...(presentation === undefined ? {} : { streamSink: presentation }),
          });
          // The provider answered. Whether the classifier accepts the answer is a separate
          // question, and the frozen result reports that distinction itself.
          outcome.providerTurnState = "COMPLETED";
          return { kind: "COMPLETED" as const, result };
        } catch (error) {
          // A cancellation is not a provider failure: it must stay distinguishable all the way
          // up to the Run termination authority.
          if (isAIAbortError(error) || execution.signal.aborted) {
            outcome.providerTurnState = "CANCELLED";
            return { kind: "CANCELLED" as const };
          }
          outcome.providerTurnState = "FAILED";
          outcome.providerError = error;
          return { kind: "FAILED" as const, error: toModelTurnExecutionError(error) };
        }
      },
    };

    // Budget admission is a Run Layer authority, and it is the *first* thing after the context
    // is prepared: a refused turn must cost no provider call and must not create a durable Step,
    // which is exactly why the frozen loop runs admission before the durable boundary.
    //
    // The admitted request travels back through the frozen `ALLOWED.request`, which is what the
    // loop actually executes — no side table keyed by request identity is needed any more, and
    // a restatement cannot be lost by an object that failed to compare equal.
    const modelAdmission: ModelRequestAdmissionPort = {
      admit: async ({ request }) => {
        try {
          const admitted = await lifecycle?.beforeProviderAdmission?.({
            run: withCurrentStep(input.run, step.id),
            state: withCurrentStep(state, step.id),
            step,
            model: input.run.model,
            request,
          });
          return { kind: "ALLOWED", request: admitted ?? request };
        } catch (error) {
          if (error instanceof AgentBudgetAdmissionError) {
            // The durable block keeps its own accounting: the frozen vocabulary names the
            // dimension, while the Run Layer settles with the numbers.
            outcome.admissionBlock = error.block;
            return { kind: "BLOCKED", reason: "BUDGET", block: toFrozenBudgetBlock(error.block) };
          }
          outcome.admissionError = error;
          throw error;
        }
      },
    };

    // An explicitly injected admission port wins; otherwise the legacy hook is the authority.
    const resolvedAdmission =
      this.dependencies.modelAdmission ??
      (lifecycle?.beforeProviderAdmission === undefined ? undefined : modelAdmission);

    const modelTurnBoundary: ModelTurnBoundaryPort | undefined =
      this.dependencies.modelTurnBoundary ??
      (lifecycle?.beforeProviderTurn === undefined
        ? undefined
        : {
            beforeExecute: async () => {
              try {
                await lifecycle.beforeProviderTurn?.({
                  run: withCurrentStep(input.run, step.id),
                  state: withCurrentStep(state, step.id),
                  step,
                  model: input.run.model,
                });
                outcome.boundaryCommitted = true;
              } catch (error) {
                outcome.boundaryError = error;
                throw error;
              }
            },
          });

    return {
      loop: createAgentLoop({
        contextEngine: this.captureContextErrors(this.contextEngine(input), outcome),
        modelTurnExecutor,
        // The composition root owns the classifier. The loop has no default, so there is no
        // second decision authority it could fall back to.
        decisionClassifier: createAgentDecisionClassifier(),
        ...(resolvedAdmission === undefined ? {} : { modelAdmission: resolvedAdmission }),
        ...(modelTurnBoundary === undefined ? {} : { modelTurnBoundary }),
      }),
      outcome,
    };
  }

  /**
   * Record the Context Engine's own failure, without letting it cross the frozen boundary.
   *
   * The kernel reports only that preparation failed. The value itself may quote a path, a
   * document or a prompt, so it is kept here — in the facade that owns the engine — and used to
   * classify the durable failure with the Context vocabulary the Run Layer settles.
   */
  private captureContextErrors(
    engine: ContextEnginePort,
    outcome: CoreTurnOutcome,
  ): ContextEnginePort {
    return {
      prepare: async (prepareInput: ContextPrepareInput): Promise<PreparedModelContext> => {
        try {
          return await engine.prepare(prepareInput);
        } catch (error) {
          outcome.contextError = error;
          throw error;
        }
      },
    };
  }

  /**
   * Build the Context Engine for one turn.
   *
   * The frozen boundary carries no base prompt, no context limits, no cwd, no explicit paths and
   * no verification-repair text: those are legacy Context configuration and a general kernel
   * must not know them. The facade therefore assembles the legacy adapter from the turn's own
   * input, on every turn, and the injected `createContextEngine` is only an override for a host
   * that composes its own engine.
   *
   * The repair context is handed over as the *supplier* the adapter asks at the moment it builds
   * a `CONTINUATION`. Passing it as data would mean the facade had to know which turn kinds use
   * it; the adapter already does, and only it does.
   */
  private contextEngine(input: AgentLoopCommonInput): ContextEnginePort {
    const override = this.dependencies.createContextEngine?.(input);
    if (override !== undefined) return override;
    const repairContext = input.verificationRepairContext;
    return createLegacyContextRuntimeAdapter({
      inspector: this.dependencies.inspector,
      planner: this.dependencies.planner,
      contextBuilder: this.dependencies.contextBuilder,
      ...(this.dependencies.contextRuntime === undefined
        ? {}
        : { contextRuntime: this.dependencies.contextRuntime }),
      baseSystemPrompt: input.baseSystemPrompt,
      contextLimits: input.contextLimits,
      workspace: input.run.workspace,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.explicitPaths === undefined ? {} : { explicitPaths: input.explicitPaths }),
      ...(repairContext === undefined
        ? {}
        : { verificationRepairContext: () => Promise.resolve(repairContext) }),
    });
  }

  private failureFromAdvance(
    input: AgentLoopCommonInput,
    activeState: AgentState,
    step: AgentStep,
    result: AgentLoopFailedResult,
    appendPrefix: readonly AIMessage[],
    outcome: CoreTurnOutcome,
  ): AgentLoopFailureResult {
    // A failure before the provider was contacted means no provider attempt happened, so no Step
    // is settled and the step budget is untouched. Whether the provider was contacted is a fact
    // this facade observed, not a field the frozen result has to state.
    if (!readProviderAttempted(outcome)) {
      const legacyBlock = outcome.admissionBlock;
      const failure = this.failureBeforeStep(
        input.state,
        mapAgentLoopError(
          legacyBlock === undefined
            ? (outcome.contextError ??
                outcome.admissionError ??
                outcome.boundaryError ??
                frozenFailure(result.error))
            : new AgentBudgetAdmissionError(legacyBlock),
        ),
        appendPrefix,
        result.context?.report,
      );
      return legacyBlock === undefined ? failure : { ...failure, budget: legacyBlock };
    }
    return this.failureAfterStep(
      activeState,
      step,
      result.context?.report,
      appendPrefix,
      // The kernel already projected its own closed failure vocabulary onto the durable
      // `AgentError`, so the post-provider path reuses that one mapping instead of deriving a
      // second one. A settled turn the classifier refused is reported as such by the result.
      result.error,
      result.retry === undefined ? undefined : toDurableRetryMetadata(result.retry),
      result.usage,
      outcome.providerTurnState,
      result,
    );
  }

  private failureAfterStep(
    activeState: AgentState,
    step: AgentStep,
    contextReport: ContextBuildReport | undefined,
    appendPrefix: readonly AIMessage[],
    error: AgentError,
    retry: import("./agent-loop-input.js").AgentRetryMetadata | undefined,
    usage: ModelUsage | undefined,
    providerTurnState: AgentProviderTurnState,
    canonical?: AgentLoopAdvanceResult,
  ): AgentLoopFailureResult {
    const finishedAt = monotonicNow(activeState, this.dependencies.clock.now());
    const failedStep = failAgentStep(step, finishedAt);
    const state = settleAgentStepState(
      activeState,
      usage === undefined
        ? { stepId: step.id, now: finishedAt }
        : { stepId: step.id, usage, now: finishedAt },
    );
    return {
      status: "FAILED",
      error,
      state,
      step: failedStep,
      messagesToAppend: [...appendPrefix],
      ...(contextReport === undefined ? {} : { contextReport }),
      providerTurnState,
      ...(retry === undefined ? {} : { retry }),
      ...(usage === undefined ? {} : { usage }),
      // Present only on the post-provider path: this is the one failure a kernel `advance()`
      // actually produced, which is exactly what makes it plannable. A throw that escaped
      // `advance()` is an infrastructure failure with no frozen result behind it.
      ...(canonical === undefined ? {} : { canonical }),
    };
  }

  private failureBeforeStep(
    state: AgentState,
    error: AgentError,
    messagesToAppend: readonly AIMessage[],
    contextReport?: ContextBuildReport,
  ): AgentLoopFailureResult {
    return {
      status: "FAILED",
      error,
      state,
      messagesToAppend: [...messagesToAppend],
      ...(contextReport === undefined ? {} : { contextReport }),
      providerTurnState: "NOT_STARTED",
    };
  }

  private cancelledBeforeStep(input: AgentLoopCommonInput): AgentLoopCancelledResult {
    const now = monotonicNow(input.state, this.dependencies.clock.now());
    return {
      status: "CANCELLED",
      state: markAgentStateCancelled(input.state, now),
      messagesToAppend: [],
      providerTurnState: "NOT_STARTED",
    };
  }

  private cancelledAfterStep(
    activeState: AgentState,
    step: AgentStep,
    contextReport: ContextBuildReport | undefined,
    countAttempt: boolean,
    canonical?: AgentLoopAdvanceResult,
  ): AgentLoopCancelledResult {
    const finishedAt = monotonicNow(activeState, this.dependencies.clock.now());
    const cancelledStep = cancelAgentStep(step, finishedAt);
    const clearedState = cancelAgentStepState(activeState, {
      stepId: step.id,
      now: finishedAt,
      countAttempt,
    });
    return {
      status: "CANCELLED",
      state: markAgentStateCancelled(clearedState, finishedAt),
      step: cancelledStep,
      messagesToAppend: [],
      ...(contextReport === undefined ? {} : { contextReport }),
      providerTurnState: countAttempt ? "CANCELLED" : "NOT_STARTED",
      // Recorded only when a kernel `advance()` really returned it. A cancellation this facade
      // observed on its own — before the call, or because the call threw — has no frozen result,
      // and inventing one is exactly what the carrier must never do.
      ...(canonical === undefined ? {} : { canonical }),
    };
  }

  private maxStepsResult(
    state: AgentState,
    outcome: Extract<AgentLoopOutcomeResult["outcome"], { type: "MAX_STEPS_REACHED" }>,
    messagesToAppend: readonly AIMessage[],
  ): AgentLoopOutcomeResult {
    return {
      status: "OUTCOME",
      outcome,
      state: markAgentStateMaxStepsReached(
        state,
        monotonicNow(state, this.dependencies.clock.now()),
      ),
      messagesToAppend: [...messagesToAppend],
      providerTurnState: "NOT_STARTED",
    };
  }

  private outcome(
    outcome: AgentDecision,
    state: AgentState,
    step: AgentStep,
    contextReport: ContextBuildReport | undefined,
    messagesToAppend: readonly AIMessage[],
    canonical: AgentLoopAdvanceResult,
  ): AgentLoopOutcomeResult {
    return {
      status: "OUTCOME",
      outcome,
      state,
      step,
      ...(contextReport === undefined ? {} : { contextReport }),
      messagesToAppend: [...messagesToAppend],
      providerTurnState: "COMPLETED",
      // The exact object `advance()` returned. The settlement router plans from this rather than
      // from the projection above, so nothing has to be re-derived or guessed.
      canonical,
    };
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * The Core-private record of what the ports this facade owns actually did for one turn.
 *
 * Every field is observed by Core itself — the Context Engine decorator, the admission port, the
 * durable boundary and the model turn executor are all composed here — which is why the frozen
 * `advance()` result needs to carry none of it. `providerAttempted` is derived from whether the
 * executor was entered, so it is exact rather than inferred from an error code.
 */
interface CoreTurnOutcome {
  /** The Context Engine's own thrown value. It never crosses the frozen boundary. */
  contextError?: unknown;
  /** The durable budget block a legacy admission hook refused with, accounting included. */
  admissionBlock?: import("./agent-errors.js").AgentBudgetBlock;
  admissionError?: unknown;
  boundaryError?: unknown;
  /** True once the durable pre-provider commit resolved. */
  boundaryCommitted?: boolean;
  providerTurnState: AgentProviderTurnState;
  /** The thrown value of the last provider failure, kept Core-side only. */
  providerError?: unknown;
}

function readProviderAttempted(outcome: CoreTurnOutcome): boolean {
  return outcome.providerTurnState !== "NOT_STARTED";
}

/**
 * Rebuild the durable-visible failure of a Reason that never reached the provider.
 *
 * A caller-injected admission or boundary port can reject with a value this facade never saw, and
 * the frozen kernel reports only that the port failed. Reconstructing an AI-shaped failure keeps
 * the single Core classification authority — `mapAgentLoopError` — as the only place a durable
 * error code is decided.
 */
function frozenFailure(error: AgentError): Error {
  const failure = new Error(error.message) as Error & { code: string; retryable: boolean };
  failure.name = "AIError";
  failure.code = toAIErrorCode(error.code);
  failure.retryable = error.retryable;
  return failure;
}

/** Map a canonical durable code back onto the AI code the Core classifier reads. */
function toAIErrorCode(code: AgentError["code"]): AIErrorCode {
  switch (code) {
    case "RATE_LIMIT":
      return "AI_RATE_LIMIT";
    case "NETWORK_ERROR":
      return "AI_NETWORK";
    case "MODEL_TIMEOUT":
      return "AI_TIMEOUT";
    case "CONTEXT_EXHAUSTED":
      return "AI_CONTEXT_OVERFLOW";
    case "CANCELLED":
      return "AI_ABORTED";
    default:
      return "AI_PROVIDER_ERROR";
  }
}

/** Map the kernel's frozen failure code onto the AI code the Core classifier reads. */
function toAIErrorCodeFromTurn(code: ModelTurnExecutionErrorCode): AIErrorCode {
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

/**
 * Project the frozen retry hint onto the durable retry metadata.
 *
 * The durable artifact keeps the legacy `LLM_*` spelling through `toDurableRetryCode`, so this
 * mapping restores the AI spelling the Run Layer stores. Only the three transient codes can reach
 * here, because the kernel emits retry metadata for `retryable` errors only.
 */
function toDurableRetryMetadata(
  retry: FrozenAgentRetryMetadata,
): import("./agent-loop-input.js").AgentRetryMetadata | undefined {
  const code = toAIErrorCodeFromTurn(retry.code);
  if (code !== "AI_RATE_LIMIT" && code !== "AI_NETWORK" && code !== "AI_TIMEOUT") return undefined;
  return {
    code,
    retryable: retry.retryable,
    ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs }),
  };
}

/** The frozen identity of the Run a turn belongs to. */
function turnIdentity(run: AgentRun): AgentExecutionIdentity {
  return { runId: run.id, sessionId: run.sessionId, goal: run.goal };
}

/** The settled assistant message is already the canonical AI message. */
function projectAssistantMessage(
  modelTurn: import("@caelush/agent").AgentModelTurn,
): AIAssistantMessage {
  return modelTurn.assistantMessage;
}

function withCurrentStep<T extends AgentRun | AgentState>(value: T, stepId: StepId): T {
  return { ...value, currentStepId: stepId };
}

/**
 * Project the durable legacy budget block onto the frozen one.
 *
 * The frozen vocabulary is the smaller of the two: it names the dimension that ran out, while
 * the legacy block also carries the accounting the Run Layer settles with. Only the durable
 * fields the frozen contract can express cross, and the legacy block itself is preserved
 * separately for the settlement.
 */
function toFrozenBudgetBlock(
  block: import("./agent-errors.js").AgentBudgetBlock,
): FrozenAgentBudgetBlock {
  if (block.kind === "UNAVAILABLE") {
    return { kind: "UNAVAILABLE", reason: block.reason };
  }
  return {
    kind: "EXCEEDED",
    dimension: block.dimension,
    accounted: block.accounted,
    limit: block.limit,
    ...(block.limitMicros === undefined ? {} : { limitMicros: block.limitMicros }),
    ...(block.accountedMicros === undefined ? {} : { accountedMicros: block.accountedMicros }),
  };
}

function monotonicNow(state: AgentState, now: TimestampMs): TimestampMs {
  return Math.max(state.updatedAt, now) as TimestampMs;
}

/** Re-exported so the Run Layer keeps one import for the Tool catalog it passes in. */
export type { AIToolSpec };
