import { Utf8HeuristicTokenEstimator, type TokenEstimator } from "@caelush/context";
import type { LLMRequest } from "@caelush/llm/request";

export interface LLMTokenEstimator {
  estimate(request: LLMRequest): number | undefined;
}

/**
 * Conservative provider-independent request estimator. It deliberately counts
 * the complete JSON-safe request, including tool schemas and tool results.
 */
export class RequestTokenEstimator implements LLMTokenEstimator {
  constructor(private readonly textEstimator: TokenEstimator) {}

  estimate(request: LLMRequest): number | undefined {
    try {
      const value = this.textEstimator.estimateText(JSON.stringify(request));
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

export function createDefaultLLMTokenEstimator(): RequestTokenEstimator {
  return new RequestTokenEstimator(new Utf8HeuristicTokenEstimator());
}
