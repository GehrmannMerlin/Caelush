import {
  ContextBuildError,
  ContextExhaustedError,
  type ContextBuildReport,
} from "@caelush/context";
import type { AIErrorCode, AIToolResultMessage, ModelUsage } from "@caelush/ai";
import type {
  AgentBudgetBlock,
  AgentDecision,
  AgentExecutionIdentity,
  AgentLoopAdvanceFailed,
  AgentLoopAdvanceResult,
  AgentTurnInput,
  AgentTurnRef,
  ContextEnginePort,
  ModelRequestAdmissionPort,
  ModelTurnExecutor,
} from "@caelush/agent";
import { createAgentLoop, toAIModelSettings } from "@caelush/agent";
import { toModelTurnExecutionError } from "./legacy-model-turn-executor.js";
import type {
  AgentRun,
  AgentState,
  AgentStep,
  StepId,
  TimestampMs,
  ToolDefinition,
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
  AgentLoopExecutionResult,
  AgentLoopFailureResult,
  AgentLoopOutcomeResult,
  AgentLoopResumeInput,
  AgentLoopStartInput,
} from "./agent-loop-input.js";
import { AgentBudgetAdmissionError } from "./agent-errors.js";
import { isAIAbortError, mapAgentLoopError, mapAgentRetryMetadata } from "./agent-error-mapper.js";
import { prepareResumeHistory, validateAgentLoopInput } from "./agent-loop-history.js";
import type {
  AgentLoopDependencies,
  AgentLoopLifecycleHooks,
  AgentProviderTurnState,
} from "./agent-loop-ports.js";
import { toAIMessage, toAIToolSpec, toLegacyMessage } from "./ai-invocation-projection.js";
import { createLegacyContextRuntimeAdapter } from "./legacy-context-runtime-adapter.js";

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
    let history;
    try {
      history = prepareResumeHistory(
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
        sourceStepId: input.pendingDecision.modelTurn.callId as StepId,
        pendingDecision: input.pendingDecision,
        results: normalizedResults.map(toAIMessage) as unknown as readonly AIToolResultMessage[],
      },
      AgentLoop.continuationHistory(history.historyBeforeCurrentTurn, input.history),
      normalizedResults,
    );
  }

  /**
   * The messages a frozen turn may use as its prepared history.
   *
   * A tool continuation's open user turn is not ordinary history: it must stay with the tool
   * results so the next request never orphans a call from its result. The frozen context
   * boundary therefore receives the history that precedes the open turn, plus the open turn's
   * own user message — which is what lets the legacy adapter reconstruct the complete
   * `TOOL_CONTINUATION` shape without the frozen boundary growing a
   * `currentTurnMessages` field.
   */
  private static continuationHistory(
    historyBeforeTurn: readonly import("@caelush/llm/messages").LLMMessage[],
    fullHistory: readonly import("@caelush/llm/messages").LLMMessage[],
  ): readonly import("@caelush/llm/messages").LLMMessage[] {
    const openUser = findOpenUserMessage(fullHistory);
    return openUser === undefined ? historyBeforeTurn : [...historyBeforeTurn, openUser];
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
    turnInput: AgentTurnInput,
    history: readonly import("@caelush/llm/messages").LLMMessage[],
    appendPrefix: readonly import("@caelush/llm/messages").LLMMessage[],
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

    let result: AgentLoopAdvanceResult;
    try {
      const advanceInput = {
        identity,
        turn,
        input: turnInput,
        history: history.map(toAIMessage),
        model: this.dependencies.models.resolve(input.run.model),
        tools: input.tools?.map(toAIToolSpec) ?? [],
        signal: input.signal,
      };
      const settings =
        input.modelSettings === undefined ? undefined : toAIModelSettings(input.modelSettings);
      result = await this.reason(input, step, activeState).advance(
        settings === undefined ? advanceInput : { ...advanceInput, settings },
      );
    } catch (error) {
      // A throw that escapes `advance()` is an infrastructure failure, not a model outcome.
      if (input.signal.aborted) return this.cancelledAfterStep(activeState, step, undefined, false);
      return this.failureAfterStep(
        activeState,
        step,
        undefined,
        appendPrefix,
        error,
        undefined,
        "NOT_STARTED",
      );
    }

    switch (result.status) {
      case "CANCELLED":
        return this.cancelledAfterStep(activeState, step, undefined, true);
      case "FAILED":
        return this.failureFromAdvance(input, activeState, step, result, appendPrefix);
      case "COMPLETED": {
        const finishedAt = monotonicNow(activeState, this.dependencies.clock.now());
        const usage = result.decision.modelTurn.usage;
        const completedStep = completeAgentStep(step, {
          finishedAt,
          reasoningSummary: summarizeAgentDecision(result.decision),
        });
        const settledState = settleAgentStepState(
          activeState,
          usage === undefined
            ? { stepId: step.id, now: finishedAt }
            : { stepId: step.id, usage, now: finishedAt },
        );
        const decidedState =
          result.decision.type === "FINAL_CANDIDATE"
            ? markAgentStateVerifying(settledState, finishedAt)
            : settledState;
        return this.outcome(result.decision, decidedState, completedStep, result.contextReport, [
          ...appendPrefix,
          projectAssistantMessage(result.decision.modelTurn),
        ]);
      }
    }
  }

  /**
   * Assemble the frozen loop for one turn.
   *
   * The legacy Context System and the legacy provider-turn hook are both configured per turn —
   * base prompt, limits, cwd, explicit paths, and the Step the hook commits — so the adapters
   * are built here rather than once per loop. This method is the only place the Core boundary
   * learns that a legacy context implementation and a legacy lifecycle hook exist.
   */
  private reason(input: AgentLoopCommonInput, step: AgentStep, state: AgentState) {
    const legacy = this.dependencies.modelTurns;
    const lifecycle = this.dependencies.lifecycle;
    const modelTurnExecutor: ModelTurnExecutor = {
      execute: async (execution) => {
        if (execution.signal.aborted) return { kind: "CANCELLED" as const };
        // The admission hook may have restated the request with a clamped output ceiling.
        const request = admittedRequests.get(execution.request) ?? execution.request;
        try {
          return {
            kind: "COMPLETED" as const,
            result: await legacy.execute({ request, signal: execution.signal }),
          };
        } catch (error) {
          // A cancellation is not a provider failure: it must stay distinguishable all the way
          // up to the Run termination authority.
          if (isAIAbortError(error) || execution.signal.aborted) {
            return { kind: "CANCELLED" as const };
          }
          return { kind: "FAILED" as const, error: toModelTurnExecutionError(error) };
        }
      },
    };

    // The restated request is keyed by the request the admission port saw, so the executor can
    // apply it without the frozen admission contract growing a mutable-request field.
    const admittedRequests = new Map<unknown, import("@caelush/ai").AIModelRequest>();

    // Budget admission is a Run Layer authority, and it is the *first* thing after the context
    // is prepared: a refused turn must cost no provider call and must not create a durable Step,
    // which is exactly why the frozen loop runs admission before the durable boundary.
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
          // The legacy hook may restate the request with a clamped output ceiling. The frozen
          // port cannot restate it, so the executor applies the restatement instead.
          if (admitted !== undefined) admittedRequests.set(request, admitted);
          return { kind: "ALLOWED" };
        } catch (error) {
          if (error instanceof AgentBudgetAdmissionError) {
            return { kind: "BLOCKED", reason: "BUDGET", block: toFrozenBudgetBlock(error.block) };
          }
          throw error;
        }
      },
    };

    // An explicitly injected admission port wins; otherwise the legacy hook is the authority.
    const resolvedAdmission =
      this.dependencies.modelAdmission ??
      (lifecycle?.beforeProviderAdmission === undefined ? undefined : modelAdmission);

    const modelTurnBoundary =
      this.dependencies.modelTurnBoundary ??
      (lifecycle?.beforeProviderTurn === undefined
        ? undefined
        : {
            beforeExecute: async (boundary: {
              readonly request: import("@caelush/ai").AIModelRequest;
              readonly model: import("@caelush/ai").ModelDescriptor;
            }) => {
              await lifecycle.beforeProviderTurn?.({
                run: withCurrentStep(input.run, step.id),
                state: withCurrentStep(state, step.id),
                step,
                model: input.run.model,
              });
              void boundary;
            },
          });

    return createAgentLoop({
      contextEngine: this.contextEngine(input),
      modelTurnExecutor,
      ...(resolvedAdmission === undefined ? {} : { modelAdmission: resolvedAdmission }),
      ...(modelTurnBoundary === undefined ? {} : { modelTurnBoundary }),
    });
  }

  /**
   * Build the Context Engine for one turn.
   *
   * The frozen boundary carries no base prompt, no context limits, no cwd and no explicit
   * paths: those are legacy Context configuration and a general kernel must not know them. The
   * facade therefore assembles the legacy adapter from the turn's own input, on every turn,
   * and the injected `createContextEngine` is only an override for a host that composes its own
   * engine.
   */
  private contextEngine(input: AgentLoopCommonInput): ContextEnginePort {
    const override = this.dependencies.createContextEngine?.(input);
    if (override !== undefined) return override;
    return createLegacyContextRuntimeAdapter({
      inspector: this.dependencies.inspector,
      planner: this.dependencies.planner,
      contextBuilder: this.dependencies.contextBuilder,
      ...(this.dependencies.contextRuntime === undefined
        ? {}
        : { contextRuntime: this.dependencies.contextRuntime }),
      models: this.dependencies.models,
      baseSystemPrompt: input.baseSystemPrompt,
      contextLimits: input.contextLimits,
      workspace: input.run.workspace,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.explicitPaths === undefined ? {} : { explicitPaths: input.explicitPaths }),
    });
  }

  private failureFromAdvance(
    input: AgentLoopCommonInput,
    activeState: AgentState,
    step: AgentStep,
    result: AgentLoopAdvanceFailed,
    appendPrefix: readonly import("@caelush/llm/messages").LLMMessage[],
  ): AgentLoopFailureResult {
    // A failure before the durable boundary means no provider attempt happened, so no Step is
    // settled and the step budget is untouched.
    if (result.stage !== "MODEL") {
      // A budget refusal is a typed value now. The legacy hook reports it as a thrown
      // `AgentBudgetAdmissionError`, whose block is already the durable legacy shape; the frozen
      // kernel reports its own frozen block, which is projected here. Either way the durable
      // settlement is the same, and the classification comes from the block itself rather than
      // from a message.
      const legacyBlock =
        readLegacyBudgetBlock(result.error.cause) ??
        (result.budgetBlock === undefined ? undefined : toLegacyBudgetBlock(result.budgetBlock));
      const failure = this.failureBeforeStep(
        input.state,
        mapAgentLoopError(
          legacyBlock === undefined
            ? advanceError(result)
            : new AgentBudgetAdmissionError(legacyBlock),
        ),
        appendPrefix,
        asContextReport(result.contextReport),
      );
      return legacyBlock === undefined ? failure : { ...failure, budget: legacyBlock };
    }
    return this.failureAfterStep(
      activeState,
      step,
      asContextReport(result.contextReport),
      appendPrefix,
      advanceError(result),
      result.usage,
      // A settled provider turn that the classifier refused is a failed *turn*, not a failed
      // provider attempt, and the durable record keeps that distinction.
      result.providerTurnState ?? "FAILED",
    );
  }

  private failureAfterStep(
    activeState: AgentState,
    step: AgentStep,
    contextReport: ContextBuildReport | undefined,
    appendPrefix: readonly import("@caelush/llm/messages").LLMMessage[],
    error: unknown,
    usage: ModelUsage | undefined,
    providerTurnState: AgentProviderTurnState,
  ): AgentLoopFailureResult {
    const finishedAt = monotonicNow(activeState, this.dependencies.clock.now());
    const failedStep = failAgentStep(step, finishedAt);
    const state = settleAgentStepState(
      activeState,
      usage === undefined
        ? { stepId: step.id, now: finishedAt }
        : { stepId: step.id, usage, now: finishedAt },
    );
    const retry = mapAgentRetryMetadata(error);
    return {
      status: "FAILED",
      error: mapAgentLoopError(error),
      state,
      step: failedStep,
      messagesToAppend: [...appendPrefix],
      ...(contextReport === undefined ? {} : { contextReport }),
      providerTurnState,
      ...(retry === undefined ? {} : { retry }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  private failureBeforeStep(
    state: AgentState,
    error: ReturnType<typeof mapAgentLoopError>,
    messagesToAppend: readonly import("@caelush/llm/messages").LLMMessage[],
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
    };
  }

  private maxStepsResult(
    state: AgentState,
    outcome: Extract<AgentLoopOutcomeResult["outcome"], { type: "MAX_STEPS_REACHED" }>,
    messagesToAppend: readonly import("@caelush/llm/messages").LLMMessage[],
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
    contextReport: Readonly<Record<string, unknown>> | undefined,
    messagesToAppend: readonly import("@caelush/llm/messages").LLMMessage[],
  ): AgentLoopOutcomeResult {
    const report = asContextReport(contextReport);
    return {
      status: "OUTCOME",
      outcome,
      state,
      step,
      ...(report === undefined ? {} : { contextReport: report }),
      messagesToAppend: [...messagesToAppend],
      providerTurnState: "COMPLETED",
    };
  }
}

/* ------------------------------------------------------------------ helpers */

/** The frozen identity of the Run a turn belongs to. */
function turnIdentity(run: AgentRun): AgentExecutionIdentity {
  return { runId: run.id, sessionId: run.sessionId, goal: run.goal };
}

/**
 * The last user message of a conversation.
 *
 * Legacy history keeps exactly one user message per open turn, so the last one is the turn's
 * own opening message.
 */
function findOpenUserMessage(
  history: readonly import("@caelush/llm/messages").LLMMessage[],
): import("@caelush/llm/messages").LLMUserMessage | undefined {
  const last = [...history].reverse().find((message) => message.role === "user");
  return last?.role === "user" ? last : undefined;
}

/**
 * Project the agent's settled assistant message onto the durable legacy conversation record.
 *
 * The shared projection helper is typed for a full AI turn result; the frozen decision carries
 * the assistant message directly, so the one-message case goes through the same field-by-field
 * projection rather than re-deriving any text.
 */
function projectAssistantMessage(
  modelTurn: import("@caelush/agent").AgentModelTurn,
): import("@caelush/llm/messages").LLMAssistantMessage {
  const projected = toLegacyMessage(modelTurn.assistantMessage);
  if (projected.role !== "assistant") {
    throw new TypeError("an agent model turn must project onto an assistant message");
  }
  return projected;
}

function withCurrentStep<T extends AgentRun | AgentState>(value: T, stepId: StepId): T {
  return { ...value, currentStepId: stepId };
}

function asContextReport(
  report: Readonly<Record<string, unknown>> | undefined,
): ContextBuildReport | undefined {
  return report as unknown as ContextBuildReport | undefined;
}

/**
 * The failure a frozen advance result carries, reconstructed for the legacy error mapper.
 *
 * The frozen kernel reports a closed failure vocabulary. The legacy mapper reads AI error codes
 * and Context error classes, so this is where the two vocabularies meet — and it is the only
 * place, which is what keeps the general kernel free of both.
 *
 * The original failure travels as `cause` precisely so this reconstruction can prefer it: a
 * Context failure must stay a Context failure, and re-deriving a `ContextBudgetExceededError`
 * from a generic code would lose the classification the Run Layer settles.
 */
function advanceError(result: AgentLoopAdvanceFailed): unknown {
  if (result.stage === "CONTEXT" && result.error.cause !== undefined) return result.error.cause;
  const { code, message, retryable, retryAfterMs } = result.error;
  switch (code) {
    case "AUTHENTICATION":
      return aiFailure("AI_AUTHENTICATION", message, retryable, retryAfterMs);
    case "RATE_LIMIT":
      return aiFailure("AI_RATE_LIMIT", message, retryable, retryAfterMs);
    case "NETWORK":
      return aiFailure("AI_NETWORK", message, retryable, retryAfterMs);
    case "TIMEOUT":
      return aiFailure("AI_TIMEOUT", message, retryable, retryAfterMs);
    case "CONTEXT_OVERFLOW":
      return message.includes("exhausted")
        ? new ContextExhaustedError()
        : new ContextBuildError(message);
    case "UNSUPPORTED_MODEL":
      return aiFailure("AI_MODEL_UNSUPPORTED", message, retryable, retryAfterMs);
    case "UNSUPPORTED_CAPABILITY":
      return aiFailure("AI_CAPABILITY_UNSUPPORTED", message, retryable, retryAfterMs);
    case "INVALID_RESPONSE":
      return aiFailure("AI_INVALID_RESPONSE", message, retryable, retryAfterMs);
    default:
      return aiFailure("AI_PROVIDER_ERROR", message, retryable, retryAfterMs);
  }
}

/**
 * Rebuild an AI-shaped failure so the legacy mapper classifies it.
 *
 * The mapper reads the fault structurally and never trusts `instanceof`, which is exactly why
 * a structural reconstruction is safe here and a cast would not be.
 */
function aiFailure(
  code: AIErrorCode,
  message: string,
  retryable: boolean,
  retryAfterMs: number | undefined,
): Error {
  const failure = new Error(message) as Error & {
    code: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
  failure.name = "AIError";
  failure.code = code;
  failure.retryable = retryable;
  if (retryAfterMs !== undefined) failure.retryAfterMs = retryAfterMs;
  return failure;
}

/**
 * Read the durable budget block a legacy admission hook refused with.
 *
 * The read is structural for the same reason the error mapper's is: the block is validated by
 * shape, not by class identity, so a second module instance cannot make the classification
 * silently disagree.
 */
function readLegacyBudgetBlock(
  cause: unknown,
): import("./agent-errors.js").AgentBudgetBlock | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const block = (cause as { readonly block?: unknown }).block;
  if (typeof block !== "object" || block === null) return undefined;
  const kind = (block as { readonly kind?: unknown }).kind;
  return kind === "EXCEEDED" || kind === "UNAVAILABLE"
    ? (block as import("./agent-errors.js").AgentBudgetBlock)
    : undefined;
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
): AgentBudgetBlock {
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

/** Project the frozen budget refusal onto the durable legacy block the Run Layer settles. */
function toLegacyBudgetBlock(
  block: AgentBudgetBlock,
): import("./agent-errors.js").AgentBudgetBlock {
  if (block.kind === "UNAVAILABLE") {
    return { kind: "UNAVAILABLE", reason: block.reason ?? "TOKEN_ESTIMATE" };
  }
  return {
    kind: "EXCEEDED",
    dimension: block.dimension ?? "TOKENS",
    accounted: block.accounted ?? 0,
    limit: block.limit ?? 0,
    ...(block.limitMicros === undefined ? {} : { limitMicros: block.limitMicros }),
    ...(block.accountedMicros === undefined ? {} : { accountedMicros: block.accountedMicros }),
  };
}

function monotonicNow(state: AgentState, now: TimestampMs): TimestampMs {
  return Math.max(state.updatedAt, now) as TimestampMs;
}

/** Re-exported so the Run Layer keeps one import for the Tool catalog it passes in. */
export type { ToolDefinition };
