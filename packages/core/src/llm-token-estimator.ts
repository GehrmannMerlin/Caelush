import type { AIModelRequest } from "@caelush/ai";

export interface LLMTokenEstimator {
  estimate(request: AIModelRequest): number | undefined;
}

/**
 * Conservative provider-independent request estimator. It deliberately counts
 * the complete JSON-safe request, including tool schemas and tool results.
 */
export class RequestTokenEstimator implements LLMTokenEstimator {
  estimate(request: AIModelRequest): number | undefined {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
      return bytes === 0 ? 0 : Math.ceil(bytes / 3);
    } catch {
      return undefined;
    }
  }
}

export function createDefaultLLMTokenEstimator(): RequestTokenEstimator {
  return new RequestTokenEstimator();
}
