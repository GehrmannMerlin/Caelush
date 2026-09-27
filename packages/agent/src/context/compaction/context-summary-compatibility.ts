import type {
  ContextSummarizationInput,
  ContextSummarizationResult,
  ContextSummarizerPort,
} from "./context-compaction-contracts.js";
import type { ContextSummarizationRunner } from "./context-summary.js";
import { ContextExhaustedError } from "../planner/context-planning-errors.js";

/** Compatibility adapter for sealed 8A–8D callers during the 8E cutover. */
export function createContextSummarizerFromRunner(
  runner: ContextSummarizationRunner | undefined,
): ContextSummarizerPort {
  return Object.freeze({
    async summarize(
      input: ContextSummarizationInput,
      options: { readonly signal: AbortSignal },
    ): Promise<ContextSummarizationResult> {
      if (runner === undefined) throw new ContextExhaustedError();
      const result = await runner.summarize(input, options);
      if (result.kind !== "ACCEPTED") throw new Error(result.reason);
      return result.result;
    },
  });
}
