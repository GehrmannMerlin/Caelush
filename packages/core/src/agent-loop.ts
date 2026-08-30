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
  markAgentStateMaxStepsReached,
  markAgentStateVerifying,
  settleAgentStepState,
} from "./agent-state.js";
import { classifyAgentDecision } from "./agent-decision-mapper.js";
import { completeAgentStep, createRunningAgentStep, failAgentStep } from "./agent-step.js";
import { evaluateAgentStepGate } from "./agent-step-gate.js";
import { normalizeToolResultBatch } from "./agent-tool-results.js";
import { summarizeAgentDecision } from "./agent-summary.js";
import type {
  AgentLoopCommonInput,
  AgentLoopExecutionResult,
  AgentLoopFailureResult,
  AgentLoopOutcomeResult,
  AgentLoopResumeInput,
  AgentLoopStartInput,
} from "./agent-loop-input.js";
import { mapAgentLoopError } from "./agent-error-mapper.js";
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
    const currentUserMessage = { role: "user" as const, content: input.run.goal };
    const gate = evaluateAgentStepGate(input.state, input.run.limits);
    if (!gate.allowed) return this.maxStepsResult(input.state, gate.outcome, [currentUserMessage]);

    let prepared: PreparedTurn;
    try {
      prepared = await this.prepareTurn(input, input.history, currentUserMessage);
    } catch (error) {
      return this.failureBeforeStep(input.state, mapAgentLoopError(error), [currentUserMessage]);
    }
    return this.executeProviderTurn(input, gate.nextSequence, prepared, [currentUserMessage]);
  }

  async resumeWithToolResults(input: AgentLoopResumeInput): Promise<AgentLoopExecutionResult> {
    validateAgentLoopInput(input);
    let normalizedResults: readonly LLMToolResultMessage[];
    try {
      normalizedResults = normalizeToolResultBatch(
        input.pendingDecision.toolRequests,
        input.toolResults,
      );
    } catch (error) {
      return this.failureBeforeStep(input.state, mapAgentLoopError(error), []);
    }
    const history = prepareResumeHistory(input.history, input.pendingDecision, normalizedResults);
    const gate = evaluateAgentStepGate(input.state, input.run.limits);
    if (!gate.allowed) return this.maxStepsResult(input.state, gate.outcome, normalizedResults);

    let prepared: PreparedTurn;
    try {
      prepared = await this.prepareTurn(
        input,
        history.historyBeforeCurrentTurn,
        undefined,
        history.currentTurnMessages,
      );
    } catch (error) {
      return this.failureBeforeStep(input.state, mapAgentLoopError(error), normalizedResults);
    }
    return this.executeProviderTurn(input, gate.nextSequence, prepared, normalizedResults);
  }

  private async prepareTurn(
    input: AgentLoopCommonInput,
    history: readonly LLMMessage[],
    currentUserMessage: { readonly role: "user"; readonly content: string } | undefined,
    currentTurnMessages?: readonly LLMMessage[],
  ): Promise<PreparedTurn> {
    const snapshotInput =
      input.cwd === undefined
        ? { workspace: input.run.workspace }
        : { workspace: input.run.workspace, cwd: input.cwd };
    const snapshot = await this.dependencies.inspector.inspect(snapshotInput);
    const query =
      input.explicitPaths === undefined
        ? { text: input.run.goal }
        : { text: input.run.goal, explicitPaths: input.explicitPaths };
    const relevantFiles = await this.dependencies.planner.plan({ snapshot, query });
    const contextInput = this.contextInput(
      input,
      snapshot,
      relevantFiles,
      history,
      currentUserMessage,
      currentTurnMessages,
    );
    const context = this.dependencies.contextBuilder.build(contextInput);
    const request = buildAgentLLMRequest(context, input.run, input.tools, input.modelSettings);
    return { context, request };
  }

  private contextInput(
    input: AgentLoopCommonInput,
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
    input: AgentLoopCommonInput,
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
    try {
      await this.dependencies.lifecycle?.beforeProviderTurn({
        run: input.run,
        state: activeState,
        step,
        model: input.run.model,
      });
    } catch (error) {
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
      result = await this.dependencies.llmClient.complete(prepared.request);
    } catch (error) {
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
    return {
      status: "FAILED",
      error: mapAgentLoopError(error),
      state,
      step: failedStep,
      messagesToAppend: [...appendPrefix],
      contextReport: context.report,
      providerTurnState,
    };
  }

  private failureBeforeStep(
    state: AgentState,
    error: ReturnType<typeof mapAgentLoopError>,
    messagesToAppend: readonly LLMMessage[],
  ): AgentLoopFailureResult {
    return {
      status: "FAILED",
      error,
      state,
      messagesToAppend: [...messagesToAppend],
      providerTurnState: "NOT_STARTED",
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
