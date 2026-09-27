import type { AIFinishReason } from "@caelush/ai";

import {
  createSemanticCheckpointDraft,
  type SemanticCheckpointDraft,
} from "./semantic-checkpoint-draft.js";
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  type ContextSummarizationResult,
} from "./context-compaction-contracts.js";

export type SummaryModelOutcome =
  "ACCEPTED" | "TRUNCATED" | "FILTERED" | "MALFORMED" | "FAILED" | "CANCELLED";

export interface SemanticSummaryValidator {
  validate(input: { readonly result: ContextSummarizationResult }):
    | {
        readonly outcome: "ACCEPTED";
        readonly result: ContextSummarizationResult;
      }
    | {
        readonly outcome: Exclude<SummaryModelOutcome, "ACCEPTED" | "CANCELLED">;
        readonly reason: string;
      };
}

/** A safe, typed boundary error for malformed provider-owned semantic output. */
export class SemanticSummaryMalformedError extends TypeError {
  constructor(message = "Semantic summary output was malformed.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SemanticSummaryMalformedError";
  }
}

export function createSemanticSummaryValidator(): SemanticSummaryValidator {
  const validator: SemanticSummaryValidator = {
    validate(input: { readonly result: ContextSummarizationResult }) {
      const finishOutcome = outcomeForFinishReason(input.result.finishReason);
      if (finishOutcome !== "ACCEPTED") {
        return Object.freeze({
          outcome: finishOutcome,
          reason: `Semantic summary finish reason was ${input.result.finishReason}.`,
        });
      }
      if (input.result.summaryPromptVersion !== CONTEXT_SUMMARY_PROMPT_VERSION) {
        return Object.freeze({
          outcome: "MALFORMED" as const,
          reason: "Semantic summary prompt version is unsupported.",
        });
      }
      try {
        const semantic = createSemanticCheckpointDraft(input.result.semantic);
        return Object.freeze({
          outcome: "ACCEPTED" as const,
          result: Object.freeze({ ...input.result, semantic }),
        });
      } catch {
        return Object.freeze({
          outcome: "MALFORMED" as const,
          reason: "Semantic summary did not match its bounded exact shape.",
        });
      }
    },
  };
  return Object.freeze(validator);
}

export type { AIFinishReason, SemanticCheckpointDraft };

function outcomeForFinishReason(
  finishReason: AIFinishReason,
): Exclude<SummaryModelOutcome, "CANCELLED"> {
  switch (finishReason) {
    case "STOP":
      return "ACCEPTED";
    case "LENGTH":
      return "TRUNCATED";
    case "CONTENT_FILTER":
      return "FILTERED";
    case "TOOL_CALLS":
    case "OTHER":
      return "FAILED";
  }
}
