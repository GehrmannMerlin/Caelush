import type { JsonObject } from "@caelush/ai";

import { canonicalJsonText, digestJsonValue } from "../../messages/canonical-json.js";
import { PRIVATE_REPLAY_REFERENCE_KIND } from "../../messages/private-replay.js";
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
        messageRefs: prefix.messageRefs,
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
 * User constraints remain exact safety requirements. Progress, completed work, discoveries, and
 * decisions are compactable semantic memory and may be merged or retired after resolution.
 */
function validateProtectedSummaryFacts(input: {
  readonly previousCheckpoint?: import("../checkpoint/structured-checkpoint.js").StructuredCheckpoint;
  readonly semantic: ContextSummarizationResult["semantic"];
}): string | undefined {
  const previous = input.previousCheckpoint;
  if (previous === undefined) return undefined;
  const returnedConstraints = new Set(input.semantic.constraints);
  if (previous.constraints.some((constraint) => !returnedConstraints.has(constraint))) {
    return "Semantic summary omitted a protected user constraint.";
  }
  return undefined;
}

function normalizeSummaryReplayInput(input: ContextSummarizationInput): ContextSummarizationInput {
  if (!isContextSummaryReplayPrefixEligible(input)) {
    return withoutReplayPrefix(input);
  }
  return Object.freeze({
    ...input,
    purpose: "COMPACTION",
    cacheEligibility: "CACHE_REUSE_ELIGIBLE",
  });
}

/** Validate the full provider-neutral identity before a host adapter may replay a main prefix. */
export function isContextSummaryReplayPrefixEligible(input: ContextSummarizationInput): boolean {
  const prefix = input.replayPrefix;
  return (
    input.cacheEligibility === "CACHE_REUSE_ELIGIBLE" &&
    prefix !== undefined &&
    input.replayPrefixFingerprint === createContextSummaryReplayPrefixFingerprint(prefix) &&
    prefix.modelRef.provider === input.model.ref.provider &&
    prefix.modelRef.model === input.model.ref.model &&
    prefix.api === input.model.api &&
    /^sha256:[0-9a-f]{64}$/.test(prefix.surfaceFingerprint) &&
    hasCompleteReplayPrefix(input)
  );
}

function hasCompleteReplayPrefix(input: ContextSummarizationInput): boolean {
  const prefix = input.replayPrefix;
  if (prefix === undefined || prefix.messageRefs.length === 0) return false;
  const refs = new Map<string, (typeof prefix.messageRefs)[number]>();
  for (const ref of prefix.messageRefs) {
    if (
      ref.messageId.trim().length === 0 ||
      ref.runId.trim().length === 0 ||
      ref.conversationTurnId.trim().length === 0 ||
      !Number.isSafeInteger(ref.sequence) ||
      ref.sequence < 1 ||
      !Number.isSafeInteger(ref.schemaVersion) ||
      ref.schemaVersion < 1 ||
      (ref.modelProjectionVersion !== null &&
        (!Number.isSafeInteger(ref.modelProjectionVersion) || ref.modelProjectionVersion < 1)) ||
      refs.has(ref.messageId)
    ) {
      return false;
    }
    refs.set(ref.messageId, ref);
  }
  for (const source of input.sourceMessages) {
    if (!refs.has(String(source.message.id))) return false;
  }
  for (const message of prefix.messages) {
    if (message.role !== "assistant" || message.providerState === undefined) continue;
    const payload = message.providerState.payload;
    if (
      message.providerState.version !== 1 ||
      message.providerState.providerId !== prefix.modelRef.provider ||
      message.providerState.api !== prefix.api ||
      !isBoundPrivateReplayPayload(payload, {
        sessionId: String(input.identity.sessionId),
        model: prefix.modelRef.model,
        messageRefs: refs,
      })
    ) {
      return false;
    }
  }
  return true;
}

function isBoundPrivateReplayPayload(
  value: Readonly<Record<string, unknown>>,
  expected: {
    readonly sessionId: string;
    readonly model: string;
    readonly messageRefs: ReadonlyMap<string, unknown>;
  },
): boolean {
  const keys = ["kind", "replayId", "sessionId", "runId", "callId", "model", "replayVersion"];
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    value.kind === PRIVATE_REPLAY_REFERENCE_KIND &&
    typeof value.replayId === "string" &&
    expected.messageRefs.has(value.replayId) &&
    value.sessionId === expected.sessionId &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    typeof value.callId === "string" &&
    value.callId.length > 0 &&
    value.model === expected.model &&
    value.replayVersion === 1
  );
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
