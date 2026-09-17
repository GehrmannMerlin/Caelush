import type { AIModelRequest, AIModelTurnResult, ModelUsage } from "@caelush/ai";
import type { AgentExecutionIdentity } from "@caelush/agent";
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

/**
 * The model turn one verification review executes as.
 *
 * ```text
 * identity   the Run the review belongs to
 * request    one provider turn, tools forbidden
 * signal     the Run's own cancellation signal, forwarded unchanged
 * ```
 *
 * The identity is an **explicit argument**. A review is a host action about a Run, not an Agent
 * Reason, so it has no `AgentTurnRef` of its own — but "no turn of its own" never meant "read whatever
 * identity was published last". Phase 3E removed the mutable global that used to answer that question:
 * a reviewer that read it would take a turn identity from another Run's execution, and would fail
 * entirely when no Agent turn happened to have published one first.
 *
 * The identity names the Run for attribution and durable budget ownership. It creates no AgentStep:
 * verification produces evidence, and evidence is not a Reason.
 */
export interface VerificationModelClient {
  execute(input: {
    readonly identity: AgentExecutionIdentity;
    readonly request: AIModelRequest;
    readonly signal: AbortSignal;
  }): Promise<AIModelTurnResult>;
}

export interface TaskAcceptanceReviewerDependencies {
  /**
   * The model turn authority a review executes through.
   *
   * It is the same AI subsystem, gateway and provider registry an ordinary Agent turn uses — there is
   * deliberately no second provider runtime for verification — and it is handed the Run identity per
   * call rather than reading one from anywhere.
   */
  readonly modelTurns: VerificationModelClient;
  readonly budget: RunBudgetPort;
  readonly clock: { now(): import("@caelush/protocol").TimestampMs };
  /** Core-side request estimator: the durable budget port receives plain numbers. */
  readonly tokenEstimator?: import("./llm-token-estimator.js").LLMTokenEstimator;
}

/**
 * Provider-neutral reviewer orchestration.
 *
 * It creates neither a Step nor a Tool invocation, and it owns no identity: the Run it reviews arrives
 * as an argument, and the identity it executes as is projected from that Run by this class and handed
 * to the model client. Nothing here reads a global "active turn", and nothing here publishes one.
 */
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
      // The review runs through the same AI subsystem an Agent turn does — same gateway, same
      // provider registry, no second runtime generation — and it names the Run it belongs to.
      turn = await this.dependencies.modelTurns.execute({
        identity: reviewIdentity(input.run),
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

/**
 * The identity one verification review executes for.
 *
 * It is projected from the Run the review belongs to, which is the only identity a host action about
 * that Run may have. A review creates no AgentStep, so there is no Step identity to project and none
 * is invented.
 */
function reviewIdentity(run: AgentRun): AgentExecutionIdentity {
  return { runId: run.id, sessionId: run.sessionId, goal: run.goal };
}

function errorResult(bundle: TaskReviewBundle, errorCode: string) {
  return {
    status: "ERROR" as const,
    reviewInputHash: bundle.reviewInputHash,
    errorCode,
  };
}
