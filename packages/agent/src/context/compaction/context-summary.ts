import type { JsonObject } from "@caelush/ai";

import { canonicalJsonText, digestJsonValue } from "../../messages/canonical-json.js";
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  type ContextSummarizationInput,
  type ContextSummarizationResult,
  type ContextSummarizerPort,
} from "./context-compaction-contracts.js";
import {
  createSemanticSummaryValidator,
  SemanticSummaryMalformedError,
  type SemanticSummaryValidator,
  type SummaryModelOutcome,
} from "./semantic-summary-validator.js";
import { createContextSummarySourceSerializer } from "./summary-source-serializer.js";

const summarySourceSerializer = createContextSummarySourceSerializer();

export type ContextSummaryExecutionResult =
  | {
      readonly kind: "ACCEPTED";
      readonly result: ContextSummarizationResult;
      readonly degraded: false;
    }
  | {
      readonly kind: "FALLBACK_REQUIRED";
      readonly outcome: Exclude<SummaryModelOutcome, "ACCEPTED" | "CANCELLED">;
      readonly reason: string;
      readonly modelRef: ContextSummarizationResult["modelRef"];
      readonly summaryPromptVersion: typeof CONTEXT_SUMMARY_PROMPT_VERSION;
      readonly sourceDigest: string;
      readonly degraded: true;
    };

export interface ContextSummarizationRunner {
  summarize(
    input: ContextSummarizationInput,
    options: { readonly signal: AbortSignal },
  ): Promise<ContextSummaryExecutionResult>;
}

export function createContextSummarizationRunner(options: {
  readonly summarizer: ContextSummarizerPort;
  readonly validator?: SemanticSummaryValidator;
}): ContextSummarizationRunner {
  const validator = options.validator ?? createSemanticSummaryValidator();
  return Object.freeze({
    async summarize(
      input: ContextSummarizationInput,
      callOptions: { readonly signal: AbortSignal },
    ): Promise<ContextSummaryExecutionResult> {
      throwIfAborted(callOptions.signal);
      const sourceDigest = digestJsonValue(JSON.parse(serializeContextSummarySource(input)));
      try {
        const summarized = await options.summarizer.summarize(input, callOptions);
        throwIfAborted(callOptions.signal);
        const validated = validator.validate({ result: summarized });
        if (validated.outcome !== "ACCEPTED") {
          return fallbackRequired({
            outcome: validated.outcome,
            reason: validated.reason,
            sourceDigest,
            modelRef: input.model.ref,
          });
        }
        const result = freezeSummaryResult({
          ...validated.result,
          sourceDigest,
          semanticDigest: digestSemantic(validated.result.semantic),
        });
        return Object.freeze({ kind: "ACCEPTED", result, degraded: false });
      } catch (error) {
        if (isCancellation(error, callOptions.signal)) throw error;
        return fallbackRequired({
          outcome: error instanceof SemanticSummaryMalformedError ? "MALFORMED" : "FAILED",
          reason:
            error instanceof SemanticSummaryMalformedError
              ? "Semantic summary output was malformed."
              : "Semantic summarization failed.",
          sourceDigest,
          modelRef: input.model.ref,
        });
      }
    },
  });
}

/** Serialize the canonical semantic source plus only the request identity fields. */
export function serializeContextSummarySource(input: ContextSummarizationInput): string {
  const semantic = JSON.parse(
    summarySourceSerializer.serialize({
      sourceMessages: input.sourceMessages,
      sourceRange: input.sourceRange,
      cut: input.cut,
      ...(input.previousCheckpoint === undefined
        ? {}
        : { previousCheckpoint: input.previousCheckpoint }),
    }),
  ) as JsonObject;
  const value: JsonObject = {
    ...semantic,
    reason: input.reason,
    targetTokens: input.targetTokens,
    model: {
      provider: input.model.ref.provider,
      model: input.model.ref.model,
    },
  };
  return canonicalJsonText(value);
}

function fallbackRequired(input: {
  readonly outcome: Exclude<SummaryModelOutcome, "ACCEPTED" | "CANCELLED">;
  readonly reason: string;
  readonly sourceDigest: string;
  readonly modelRef: ContextSummarizationResult["modelRef"];
}): ContextSummaryExecutionResult {
  return Object.freeze({
    kind: "FALLBACK_REQUIRED",
    outcome: input.outcome,
    reason: input.reason,
    modelRef: input.modelRef,
    summaryPromptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
    sourceDigest: input.sourceDigest,
    degraded: true,
  });
}

function digestSemantic(semantic: ContextSummarizationResult["semantic"]): string {
  return digestJsonValue(JSON.parse(JSON.stringify(semantic)));
}

function freezeSummaryResult(result: ContextSummarizationResult): ContextSummarizationResult {
  return Object.freeze({
    ...result,
    semantic: Object.freeze({
      ...result.semantic,
      constraints: Object.freeze([...result.semantic.constraints]),
      completedWork: Object.freeze([...result.semantic.completedWork]),
      inProgress: Object.freeze([...result.semantic.inProgress]),
      blocked: Object.freeze([...result.semantic.blocked]),
      importantDiscoveries: Object.freeze([...result.semantic.importantDiscoveries]),
      keyDecisions: Object.freeze([...result.semantic.keyDecisions]),
      criticalReferences: Object.freeze([...result.semantic.criticalReferences]),
    }),
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Context summarization was cancelled.");
  error.name = "AbortError";
  throw error;
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
