import type {
  AIGateway,
  AIInvocationAccountingObserver,
  AIModelRequest,
  AIModelTurnResult,
} from "@caelush/ai";
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  ContextSummarizationInfrastructureError,
  digestJsonValue,
  type ContextSummarizerPort,
} from "@caelush/agent";
import type { AgentRun, TimestampMs } from "@caelush/protocol";
import {
  createDefaultLLMTokenEstimator,
  type RunLLMBudgetAdmission,
  type RunBudgetSettlement,
} from "@caelush/core";
import { createAIContextSummarizerAdapter } from "./ai-context-summarizer-adapter.js";

export interface ContextCompactionBudgetPort {
  admitContextCompactionLLM(input: {
    readonly run: AgentRun;
    readonly ownerId: string;
    readonly admission: {
      readonly estimatedInputTokens?: number;
      readonly configuredMaxOutputTokens?: number;
    };
  }): Promise<RunLLMBudgetAdmission>;
  settleContextCompactionLLM(input: {
    readonly runId: AgentRun["id"];
    readonly ownerId: string;
    readonly providerCallId?: string;
    readonly usage?: AIModelTurnResult["usage"];
    readonly settledAt: TimestampMs;
  }): Promise<RunBudgetSettlement | void>;
  markContextCompactionLLMConservative(input: {
    readonly runId: AgentRun["id"];
    readonly ownerId: string;
    readonly settledAt: TimestampMs;
  }): Promise<void>;
}

export interface BudgetedContextSummarizerOptions {
  readonly gateway: AIGateway;
  readonly budget: ContextCompactionBudgetPort;
  readonly run: AgentRun;
  readonly clock: { now(): TimestampMs };
  readonly invocationObserver?: AIInvocationAccountingObserver;
}

export class ContextCompactionBudgetDeniedError extends Error {
  constructor(reason: string) {
    super(`Context compaction summarization budget denied: ${reason}.`);
    this.name = "ContextCompactionBudgetDeniedError";
  }
}

/**
 * Compose the semantic summarizer with the durable Run budget. The adapter
 * reserves before gateway I/O, clamps output to the admitted ceiling, and
 * settles or conservatively closes exactly one auxiliary ledger owner.
 */
export function createBudgetedContextSummarizer(
  options: BudgetedContextSummarizerOptions,
): ContextSummarizerPort {
  const estimator = createDefaultLLMTokenEstimator();
  const gateway: AIGateway = {
    stream: async (request, callOptions) => options.gateway.stream(request, callOptions),
    complete: async (request, callOptions) => {
      const ownerId = contextCompactionOwnerId(options.run, request);
      const estimatedInputTokens = estimator.estimate(request);
      let admission: RunLLMBudgetAdmission;
      try {
        admission = await options.budget.admitContextCompactionLLM({
          run: options.run,
          ownerId,
          admission: {
            ...(estimatedInputTokens === undefined ? {} : { estimatedInputTokens }),
            ...(request.settings?.maxOutputTokens === undefined
              ? {}
              : { configuredMaxOutputTokens: request.settings.maxOutputTokens }),
          },
        });
      } catch (error) {
        throw new ContextSummarizationInfrastructureError(
          "Context compaction budget admission failed.",
          { cause: error },
        );
      }
      if (admission.kind !== "ALLOWED") {
        throw new ContextCompactionBudgetDeniedError(
          admission.kind === "UNAVAILABLE" ? admission.reason : admission.dimension,
        );
      }

      const configuredMaxOutputTokens = request.settings?.maxOutputTokens;
      const admittedMaxOutputTokens = admission.effectiveMaxOutputTokens;
      const maxOutputTokens =
        admittedMaxOutputTokens === undefined
          ? configuredMaxOutputTokens
          : configuredMaxOutputTokens === undefined
            ? admittedMaxOutputTokens
            : Math.min(configuredMaxOutputTokens, admittedMaxOutputTokens);
      const admittedRequest: AIModelRequest = {
        ...request,
        ...(maxOutputTokens === undefined
          ? {}
          : { settings: { ...request.settings, maxOutputTokens } }),
      };
      let result: AIModelTurnResult;
      try {
        result = await options.gateway.complete(admittedRequest, {
          ...callOptions,
          ...(options.invocationObserver === undefined
            ? {}
            : { invocationObserver: options.invocationObserver }),
        });
      } catch (error) {
        await markConservative(options, ownerId);
        throw error;
      }
      try {
        await options.budget.settleContextCompactionLLM({
          runId: options.run.id,
          ownerId,
          providerCallId: result.callId,
          usage: result.usage,
          settledAt: options.clock.now(),
        });
      } catch (error) {
        await markConservative(options, ownerId);
        throw new ContextSummarizationInfrastructureError(
          "Context compaction budget settlement failed.",
          { cause: error },
        );
      }
      return result;
    },
  };
  return createAIContextSummarizerAdapter(gateway);
}

function contextCompactionOwnerId(run: AgentRun, request: AIModelRequest): string {
  return `context-compaction:${digestJsonValue({
    purpose: "COMPACTION",
    runId: String(run.id),
    requestDigest: digestJsonValue(request as never),
    summaryPromptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
  })}`;
}

async function markConservative(
  options: BudgetedContextSummarizerOptions,
  ownerId: string,
): Promise<void> {
  try {
    await options.budget.markContextCompactionLLMConservative({
      runId: options.run.id,
      ownerId,
      settledAt: options.clock.now(),
    });
  } catch (error) {
    throw new ContextSummarizationInfrastructureError(
      "Context compaction budget conservative settlement failed.",
      { cause: error },
    );
  }
}
