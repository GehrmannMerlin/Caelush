import type { LLMTurnResult } from "@caelush/llm/turn";
import {
  buildTaskReviewPrompt,
  parseTaskAcceptanceReview,
  type TaskAcceptanceReview,
  type TaskReviewBundle,
} from "@caelush/verification";
import type { AgentRun } from "@caelush/protocol";
import type { AgentBudgetBlock } from "./agent-errors.js";
import type { RunBudgetPort } from "./budget-ports.js";
import type {
  VerificationLLMClient,
  VerificationTaskReviewerPort,
} from "./run-controller-ports.js";

export interface TaskAcceptanceReviewerDependencies {
  readonly llmClient: VerificationLLMClient;
  readonly budget: RunBudgetPort;
  readonly clock: { now(): import("@caelush/protocol").TimestampMs };
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
    readonly usage?: import("@caelush/llm/turn").LLMUsage;
    readonly budget?: AgentBudgetBlock;
    readonly errorCode?: string;
  }> {
    const request = {
      model: input.run.model,
      messages: [
        {
          role: "system" as const,
          content:
            "Review the supplied task bundle independently. Do not use tools. Return strict JSON only.",
        },
        { role: "user" as const, content: buildTaskReviewPrompt(input.bundle) },
      ],
      toolChoice: { type: "NONE" as const },
      maxOutputTokens: 1_024,
    };
    const ownerId = `verify:${input.bundle.plan.checks.find((check) => check.kind === "TASK")?.id ?? input.bundle.plan.id}`;
    const admitted = await this.dependencies.budget.admitVerificationLLM?.({
      run: input.run,
      ownerId,
      request,
    });
    if (admitted === undefined) return errorResult(input.bundle, "BUDGET_NOT_CONFIGURED");
    if (admitted.kind !== "ALLOWED") {
      return { ...errorResult(input.bundle, "BUDGET_BLOCKED"), budget: admitted };
    }

    let turn: LLMTurnResult;
    try {
      turn = await this.dependencies.llmClient.complete(admitted.request, { signal: input.signal });
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

  private async settle(ownerId: string, runId: AgentRun["id"], usage: LLMTurnResult["usage"]) {
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
