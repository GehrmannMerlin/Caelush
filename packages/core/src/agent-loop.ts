import {
  ContextBuildError,
  type BuiltModelContext,
  type ContextBuildInput,
  type ProjectIntelligenceSnapshot,
  type RelevantFileContextPlan,
} from "@caelush/context";
import type { LLMMessage, LLMToolResultMessage } from "@caelush/llm/messages";
import type { LLMRequest } from "@caelush/llm/request";
import { LLMTurnResultSchema, type LLMTurnResult } from "@caelush/llm/turn";
import type { AgentState, AgentStep, TimestampMs } from "@caelush/protocol";
import {
  beginAgentStepState,
  cancelAgentStepState,
  markAgentStateCancelled,
  markAgentStateMaxStepsReached,
  markAgentStateVerifying,
  settleAgentStepState,
} from "./agent-state.js";
import { AgentBudgetAdmissionError } from "./agent-errors.js";
import { classifyAgentDecision } from "./agent-decision-mapper.js";
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
import { mapAgentLoopError, mapAgentRetryMetadata } from "./agent-error-mapper.js";
import { prepareResumeHistory, validateAgentLoopInput } from "./agent-loop-history.js";
import type { AgentLoopDependencies, AgentLoopLifecycleHooks } from "./agent-loop-ports.js";
import { buildAgentLLMRequest } from "./agent-loop-request.js";

export class AgentLoop {
  constructor(private readonly dependencies: AgentLoopDependencies) {}

  withLifecycleHooks(lifecycle: AgentLoopLifecycleHooks): AgentLoop {
    return new AgentLoop({ ...this.dependencies, lifecycle });
  }

  async run(input: AgentLoopStartInput): Promise<AgentLoopExecutionResult> {
    validateAgentLoopInput(input);
    const normalizedInput = input;
    if (normalizedInput.signal.aborted) return this.cancelledBeforeStep(normalizedInput);
    const currentUserMessage = { role: "user" as const, content: normalizedInput.run.goal };
    const gate = evaluateAgentStepGate(normalizedInput.state, normalizedInput.run.limits);
    if (!gate.allowed)
      return this.maxStepsResult(normalizedInput.state, gate.outcome, [currentUserMessage]);

    let prepared: PreparedTurn;
    try {
      prepared = await this.prepareTurn(
        normalizedInput,
        normalizedInput.history,
        currentUserMessage,
      );
    } catch (error) {
      if (normalizedInput.signal.aborted) return this.cancelledBeforeStep(normalizedInput);
      return this.failureBeforeStep(normalizedInput.state, mapAgentLoopError(error), [
        currentUserMessage,
      ]);
    }
    return this.executeProviderTurn(normalizedInput, gate.nextSequence, prepared, [
      currentUserMessage,
    ]);
  }

  async resumeWithToolResults(input: AgentLoopResumeInput): Promise<AgentLoopExecutionResult> {
    validateAgentLoopInput(input);
    const normalizedInput = input;
    if (normalizedInput.signal.aborted) return this.cancelledBeforeStep(normalizedInput);
    let normalizedResults: readonly LLMToolResultMessage[];
    try {
      normalizedResults = normalizeToolResultBatch(
        normalizedInput.pendingDecision.toolRequests,
        normalizedInput.toolResults,
      );
    } catch (error) {
      if (normalizedInput.signal.aborted) return this.cancelledBeforeStep(normalizedInput);
      return this.failureBeforeStep(normalizedInput.state, mapAgentLoopError(error), []);
    }
    const history = prepareResumeHistory(
      normalizedInput.history,
      normalizedInput.pendingDecision,
      normalizedResults,
    );
    const gate = evaluateAgentStepGate(normalizedInput.state, normalizedInput.run.limits);
    if (!gate.allowed)
      return this.maxStepsResult(normalizedInput.state, gate.outcome, normalizedResults);

    let prepared: PreparedTurn;
    try {
      prepared = await this.prepareTurn(
        normalizedInput,
        history.historyBeforeCurrentTurn,
        undefined,
        history.currentTurnMessages,
      );
    } catch (error) {
      if (normalizedInput.signal.aborted) return this.cancelledBeforeStep(normalizedInput);
      return this.failureBeforeStep(
        normalizedInput.state,
        mapAgentLoopError(error),
        normalizedResults,
      );
    }
    return this.executeProviderTurn(
      normalizedInput,
      gate.nextSequence,
      prepared,
      normalizedResults,
    );
  }

  private async prepareTurn(
    input: AgentLoopCommonInput & { readonly signal: AbortSignal },
    history: readonly LLMMessage[],
    currentUserMessage: { readonly role: "user"; readonly content: string } | undefined,
    currentTurnMessages?: readonly LLMMessage[],
  ): Promise<PreparedTurn> {
    throwIfAborted(input.signal);
    const snapshotInput =
      input.cwd === undefined
        ? { workspace: input.run.workspace }
        : { workspace: input.run.workspace, cwd: input.cwd };
    const snapshot = await this.dependencies.inspector.inspect(snapshotInput);
    throwIfAborted(input.signal);
    const query =
      input.explicitPaths === undefined
        ? { text: input.run.goal }
        : { text: input.run.goal, explicitPaths: input.explicitPaths };
    const relevantFiles = await this.dependencies.planner.plan({ snapshot, query });
    throwIfAborted(input.signal);
    const contextInput = this.contextInput(
      input,
      snapshot,
      relevantFiles,
      history,
      currentUserMessage,
      currentTurnMessages,
    );
    const context = this.dependencies.contextBuilder.build(contextInput);
    throwIfAborted(input.signal);
    const request = buildAgentLLMRequest(context, input.run, input.tools, input.modelSettings);
    return { context, request };
  }

  private contextInput(
    input: AgentLoopCommonInput & { readonly signal: AbortSignal },
    snapshot: ProjectIntelligenceSnapshot,
    relevantFiles: RelevantFileContextPlan,
    history: readonly LLMMessage[],
    currentUserMessage: { readonly role: "user"; readonly content: string } | undefined,
    currentTurnMessages: readonly LLMMessage[] | undefined,
  ): ContextBuildInput {
    const common = {
      baseSystemPrompt: input.baseSystemPrompt,
      snapshot,
      relevantFiles,
      history,
      limits: input.contextLimits,
      ...(input.verificationRepairContext === undefined
        ? {}
        : { verificationRepairContext: input.verificationRepairContext }),
    };
    if (currentTurnMessages !== undefined) {
      return { ...common, mode: "TOOL_CONTINUATION", currentTurnMessages };
    }
    if (currentUserMessage === undefined) {
      throw new ContextBuildError("current user message is missing");
    }
    return { ...common, currentUserMessage };
  }

  private async executeProviderTurn(
    input: AgentLoopCommonInput & { readonly signal: AbortSignal },
    sequence: number,
    prepared: PreparedTurn,
    appendPrefix: readonly LLMMessage[],
  ): Promise<AgentLoopExecutionResult> {
    const startedAt = monotonicNow(input.state, this.dependencies.clock.now());
    const step = createRunningAgentStep({
      id: this.dependencies.stepIdFactory.create(),
      runId: input.run.id,
      sequence,
      startedAt,
    });
    const activeState = beginAgentStepState(input.state, step.id, startedAt);
    if (input.signal.aborted) {
      return this.cancelledAfterStep(input, activeState, step, prepared.context, false);
    }
    let request = prepared.request;
    try {
      const admitted = await this.dependencies.lifecycle?.beforeProviderAdmission?.({
        run: input.run,
        state: input.state,
        step,
        model: input.run.model,
        request,
      });
      if (admitted !== undefined) request = admitted;
      throwIfAborted(input.signal);
    } catch (error) {
      if (input.signal.aborted) {
        return this.cancelledBeforeStep(input);
      }
      const failure = this.failureBeforeStep(
        input.state,
        mapAgentLoopError(error),
        appendPrefix,
        prepared.context.report,
      );
      if (error instanceof AgentBudgetAdmissionError) {
        return { ...failure, budget: error.block };
      }
      return failure;
    }
    try {
      await this.dependencies.lifecycle?.beforeProviderTurn({
        run: input.run,
        state: activeState,
        step,
        model: input.run.model,
      });
      throwIfAborted(input.signal);
    } catch (error) {
      if (input.signal.aborted) {
        return this.cancelledAfterStep(input, activeState, step, prepared.context, false);
      }
      return this.failureAfterStep(
        input,
        activeState,
        step,
        prepared.context,
        appendPrefix,
        error,
        undefined,
        "NOT_STARTED",
      );
    }

    let result: LLMTurnResult;
    try {
      result = await this.dependencies.llmClient.complete(request, {
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) {
        return this.cancelledAfterStep(input, activeState, step, prepared.context, true);
      }
      return this.failureAfterStep(
        input,
        activeState,
        step,
        prepared.context,
        appendPrefix,
        error,
        undefined,
        "FAILED",
      );
    }

    if (input.signal.aborted) {
      return this.cancelledAfterStep(input, activeState, step, prepared.context, true);
    }

    try {
      const decision = classifyAgentDecision(result);
      const finishedAt = monotonicNow(activeState, this.dependencies.clock.now());
      const completedStep = completeAgentStep(step, {
        finishedAt,
        reasoningSummary: summarizeAgentDecision(decision),
      });
      const settledState = settleAgentStepState(
        activeState,
        decision.modelTurn.usage === undefined
          ? { stepId: step.id, now: finishedAt }
          : { stepId: step.id, usage: decision.modelTurn.usage, now: finishedAt },
      );
      if (decision.type === "FINAL_CANDIDATE") {
        const verifyingState = markAgentStateVerifying(settledState, finishedAt);
        return this.outcome(
          decision,
          verifyingState,
          completedStep,
          prepared.context,
          [...appendPrefix, decision.modelTurn.assistantMessage],
          "COMPLETED",
        );
      }
      return this.outcome(
        decision,
        settledState,
        completedStep,
        prepared.context,
        [...appendPrefix, decision.modelTurn.assistantMessage],
        "COMPLETED",
      );
    } catch (error) {
      const parsed = LLMTurnResultSchema.safeParse(result);
      const usage = parsed.success ? parsed.data.usage : undefined;
      return this.failureAfterStep(
        input,
        activeState,
        step,
        prepared.context,
        appendPrefix,
        error,
        usage,
        "COMPLETED",
      );
    }
  }

  private failureAfterStep(
    input: AgentLoopCommonInput,
    activeState: AgentState,
    step: AgentStep,
    context: BuiltModelContext,
    appendPrefix: readonly LLMMessage[],
    error: unknown,
    usage?: import("@caelush/llm/turn").LLMUsage,
    providerTurnState: import("./agent-loop-ports.js").AgentProviderTurnState = "FAILED",
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
      contextReport: context.report,
      providerTurnState,
      ...(retry === undefined ? {} : { retry }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  private failureBeforeStep(
    state: AgentState,
    error: ReturnType<typeof mapAgentLoopError>,
    messagesToAppend: readonly LLMMessage[],
    contextReport?: import("@caelush/context").ContextBuildReport,
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
    _input: AgentLoopCommonInput,
    activeState: AgentState,
    step: AgentStep,
    context: BuiltModelContext,
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
      contextReport: context.report,
      providerTurnState: countAttempt ? "CANCELLED" : "NOT_STARTED",
    };
  }

  private maxStepsResult(
    state: AgentState,
    outcome: Extract<AgentLoopOutcomeResult["outcome"], { type: "MAX_STEPS_REACHED" }>,
    messagesToAppend: readonly LLMMessage[],
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
    outcome: Exclude<AgentLoopOutcomeResult["outcome"], { type: "MAX_STEPS_REACHED" }>,
    state: AgentState,
    step: AgentStep,
    context: BuiltModelContext,
    messagesToAppend: readonly LLMMessage[],
    providerTurnState: import("./agent-loop-ports.js").AgentProviderTurnState,
  ): AgentLoopOutcomeResult {
    return {
      status: "OUTCOME",
      outcome,
      state,
      step,
      contextReport: context.report,
      messagesToAppend: [...messagesToAppend],
      providerTurnState,
    };
  }
}

function monotonicNow(state: AgentState, now: TimestampMs): TimestampMs {
  return Math.max(state.updatedAt, now) as TimestampMs;
}

interface PreparedTurn {
  readonly context: BuiltModelContext;
  readonly request: LLMRequest;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentLoopCancelledError();
}

class AgentLoopCancelledError extends Error {
  constructor() {
    super("Agent loop was cancelled.");
    this.name = "AgentLoopCancelledError";
  }
}
