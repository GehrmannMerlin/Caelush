import type { AIModelRequest, AIModelTurnResult, ModelUsage } from "@caelush/ai";
import type { ModelTurnExecutor } from "@caelush/agent";
import {
  buildTaskReviewPrompt,
  parseTaskAcceptanceReview,
  type TaskAcceptanceReview,
  type TaskReviewBundle,
} from "@caelush/verification";
import type { AgentRun } from "@caelush/protocol";
import type { AgentBudgetBlock } from "./agent-errors.js";
import type { RunBudgetPort } from "./budget-ports.js";
import type { VerificationTaskReviewerPort } from "./run-controller-ports.js";
import { toAIModelRef } from "./ai-invocation-projection.js";

export interface TaskAcceptanceReviewerDependencies {
  readonly modelTurns: ModelTurnExecutor;
  readonly budget: RunBudgetPort;
  readonly clock: { now(): import("@caelush/protocol").TimestampMs };
  /** Core-side request estimator: the durable budget port receives plain numbers. */
  readonly tokenEstimator?: import("./llm-token-estimator.js").LLMTokenEstimator;
}

/** Provider-neutral reviewer orchestration. It creates neither a Step nor a Tool invocation. */
export class TaskAcceptanceReviewer implements VerificationTaskReviewerPort {
  constructor(private readonly dependencies: TaskAcceptanceReviewerDependencies) {}

  async review(input: {
    readonly run: AgentRun;
    readonly candidateText: string;
    readonly bundle: TaskReviewBundle;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly status: "PASSED" | "FAILED" | "ERROR";
    readonly review?: TaskAcceptanceReview;
    readonly reviewInputHash: string;
    readonly usage?: ModelUsage;
    readonly budget?: AgentBudgetBlock;
    readonly errorCode?: string;
  }> {
    const request: AIModelRequest = {
      model: toAIModelRef(input.run.model),
      messages: [
        {
          role: "system" as const,
          content:
            "Review the supplied task bundle independently. Do not use tools. Return strict JSON only.",
        },
        { role: "user" as const, content: buildTaskReviewPrompt(input.bundle) },
      ],
      toolChoice: { type: "NONE" as const },
      settings: { maxOutputTokens: 1_024 },
    };
    const ownerId = `verify:${input.bundle.plan.checks.find((check) => check.kind === "TASK")?.id ?? input.bundle.plan.id}`;
    const estimatedInputTokens = this.dependencies.tokenEstimator?.estimate(request);
    const admitted = await this.dependencies.budget.admitVerificationLLM?.({
      run: input.run,
      ownerId,
      admission: {
        ...(estimatedInputTokens === undefined ? {} : { estimatedInputTokens }),
        configuredMaxOutputTokens: 1_024,
      },
    });
    if (admitted === undefined) return errorResult(input.bundle, "BUDGET_NOT_CONFIGURED");
    if (admitted.kind !== "ALLOWED") {
      return { ...errorResult(input.bundle, "BUDGET_BLOCKED"), budget: admitted };
    }
    const effectiveRequest =
      admitted.effectiveMaxOutputTokens === undefined
        ? request
        : {
            ...request,
            settings: { ...request.settings, maxOutputTokens: admitted.effectiveMaxOutputTokens },
          };

    let turn: AIModelTurnResult;
    try {
      // The verification reviewer runs through the same model turn authority as a
      // normal agent turn: same AI subsystem, same gateway, no second provider
      // registry generation.
      turn = await this.dependencies.modelTurns.execute({
        request: effectiveRequest,
        signal: input.signal,
      });
    } catch {
      await this.settle(ownerId, input.run.id, undefined);
      return errorResult(
        input.bundle,
        input.signal.aborted ? "RUN_ABORTED" : "REVIEWER_PROVIDER_ERROR",
      );
    }
    const settlement = await this.settle(ownerId, input.run.id, turn.usage);
    if (settlement?.kind === "EXCEEDED") {
      return { ...errorResult(input.bundle, "BUDGET_EXCEEDED"), budget: settlement };
    }
    if (turn.toolCalls.length > 0) return errorResult(input.bundle, "REVIEWER_TOOLS_FORBIDDEN");
    if (turn.finishReason !== "STOP") return errorResult(input.bundle, "REVIEWER_OUTPUT_INVALID");
    try {
      const review = parseTaskAcceptanceReview(turn.text);
      return {
        status: review.verdict === "PASS" ? "PASSED" : "FAILED",
        review,
        reviewInputHash: input.bundle.reviewInputHash,
        ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      };
    } catch {
      return errorResult(input.bundle, "REVIEWER_RESPONSE_INVALID");
    }
  }

  private async settle(ownerId: string, runId: AgentRun["id"], usage: AIModelTurnResult["usage"]) {
    const settlementInput = {
      runId,
      ownerId,
      settledAt: this.dependencies.clock.now(),
      ...(usage === undefined ? {} : { usage }),
    };
    return this.dependencies.budget.settleVerificationLLM?.(settlementInput);
  }
}

function errorResult(bundle: TaskReviewBundle, errorCode: string) {
  return {
    status: "ERROR" as const,
    reviewInputHash: bundle.reviewInputHash,
    errorCode,
  };
}
