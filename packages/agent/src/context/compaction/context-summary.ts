import type { JsonObject } from "@caelush/ai";

import { canonicalJsonText, digestJsonValue } from "../../messages/canonical-json.js";
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  type ContextSummaryReplayPrefix,
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

/** Stable identity for the complete provider-neutral prompt prefix and its model/tool dialect. */
export function createContextSummaryReplayPrefixFingerprint(
  prefix: ContextSummaryReplayPrefix,
): string {
  return `sha256:${digestJsonValue(
    JSON.parse(
      canonicalJsonText({
        modelRef: prefix.modelRef,
        api: prefix.api,
        surfaceFingerprint: prefix.surfaceFingerprint,
        messages: prefix.messages,
        tools: prefix.tools,
      } as never),
    ),
  )}`;
}

/** A host budget/storage invariant failure that must not degrade into fallback. */
export class ContextSummarizationInfrastructureError extends Error {
  constructor(
    message = "Context summarization infrastructure failed.",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ContextSummarizationInfrastructureError";
  }
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
        const summarized = await options.summarizer.summarize(
          normalizeSummaryReplayInput(input),
          callOptions,
        );
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
        const protectedFactFailure = validateProtectedSummaryFacts({
          identityGoal: input.identity.goal,
          ...(input.previousCheckpoint === undefined
            ? {}
            : { previousCheckpoint: input.previousCheckpoint }),
          semantic: validated.result.semantic,
        });
        if (protectedFactFailure !== undefined) {
          return fallbackRequired({
            outcome: "MALFORMED",
            reason: protectedFactFailure,
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
        if (error instanceof ContextSummarizationInfrastructureError) throw error;
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

/**
 * A semantic summary may reorganize history, but it cannot silently discard
 * durable task facts already present in the previous checkpoint. Exact
 * membership is deliberate: paraphrase matching would make this safety check
 * another model judgment.
 */
function validateProtectedSummaryFacts(input: {
  readonly identityGoal: string;
  readonly previousCheckpoint?: import("../checkpoint/structured-checkpoint.js").StructuredCheckpoint;
  readonly semantic: ContextSummarizationResult["semantic"];
}): string | undefined {
  if (input.semantic.goal !== input.identityGoal) {
    return "Semantic summary changed the authoritative Run goal.";
  }
  const previous = input.previousCheckpoint;
  if (previous === undefined) return undefined;
  const protectedLists = [
    ["constraints", previous.constraints, input.semantic.constraints],
    ["completedWork", previous.completedWork, input.semantic.completedWork],
    ["inProgress", previous.inProgress, input.semantic.inProgress],
    ["blocked", previous.blocked, input.semantic.blocked],
    ["importantDiscoveries", previous.importantDiscoveries, input.semantic.importantDiscoveries],
    ["keyDecisions", previous.keyDecisions, input.semantic.keyDecisions],
    ["criticalReferences", previous.criticalReferences, input.semantic.criticalReferences],
  ] as const;
  for (const [field, required, returned] of protectedLists) {
    const returnedValues = new Set(returned);
    if (required.some((fact) => !returnedValues.has(fact))) {
      return `Semantic summary omitted protected ${field} from the previous checkpoint.`;
    }
  }
  return undefined;
}

function normalizeSummaryReplayInput(input: ContextSummarizationInput): ContextSummarizationInput {
  // Semantic compaction is an independent source-data request. Until the Gateway owns a complete
  // cache-prefix resolver and proves the prefix identity/lifecycle for this request, forwarding a
  // valid main-turn prefix would be misleading and could replay unrelated provider state.
  return withoutReplayPrefix(input);
}

function withoutReplayPrefix(input: ContextSummarizationInput): ContextSummarizationInput {
  const { replayPrefix, replayPrefixFingerprint, ...rest } = input;
  void replayPrefix;
  void replayPrefixFingerprint;
  return Object.freeze({
    ...rest,
    purpose: "COMPACTION",
    cacheEligibility: "NOT_ELIGIBLE",
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
