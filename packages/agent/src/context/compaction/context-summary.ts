import type { JsonObject } from "@caelush/ai";

import { canonicalJsonText, digestJsonValue } from "../../messages/canonical-json.js";
import {
  createContextSummaryPromptVersion,
  type ContextSummarizationInput,
  type ContextSummarizationResult,
  type ContextSummarizerPort,
  type ContextSummaryPromptVersion,
} from "./context-compaction-contracts.js";
import { createStructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";
import { createContextSummarySourceSerializer } from "./summary-source-serializer.js";

const DEFAULT_SUMMARY_PROMPT_VERSION = createContextSummaryPromptVersion(1);
const summarySourceSerializer = createContextSummarySourceSerializer();

export interface ContextSummaryExecutionResult {
  readonly result: ContextSummarizationResult;
  readonly degraded: boolean;
}

export interface ContextSummarizationRunner {
  summarize(
    input: ContextSummarizationInput,
    options: { readonly signal: AbortSignal },
  ): Promise<ContextSummaryExecutionResult>;
}

export function createContextSummarizationRunner(options: {
  readonly summarizer: ContextSummarizerPort;
}): ContextSummarizationRunner {
  return Object.freeze({
    async summarize(
      input: ContextSummarizationInput,
      callOptions: { readonly signal: AbortSignal },
    ): Promise<ContextSummaryExecutionResult> {
      throwIfAborted(callOptions.signal);
      const sourceDigest = digestJsonValue(serializeContextSummarySource(input));
      try {
        const summarized = await options.summarizer.summarize(input, callOptions);
        throwIfAborted(callOptions.signal);
        const checkpoint = createStructuredCheckpoint(summarized.checkpoint);
        const result = freezeSummaryResult({
          ...summarized,
          checkpoint,
          summaryPromptVersion: createContextSummaryPromptVersion(summarized.summaryPromptVersion),
          sourceDigest,
          checkpointDigest: digestCheckpoint(checkpoint),
        });
        return Object.freeze({ result, degraded: false });
      } catch (error) {
        if (isCancellation(error, callOptions.signal)) throw error;
        const checkpoint = createDeterministicMinimalCheckpoint(input);
        const result = freezeSummaryResult({
          checkpoint,
          modelRef: input.model.ref,
          summaryPromptVersion: DEFAULT_SUMMARY_PROMPT_VERSION,
          sourceDigest,
          checkpointDigest: digestCheckpoint(checkpoint),
        });
        return Object.freeze({ result, degraded: true });
      }
    },
  });
}

/** Serialize canonical semantic facts plus the temporary Phase 7D adapter compatibility fields. */
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
    sourceRange: input.sourceRange as unknown as JsonObject,
    authorities: serializeAuthorities(input),
  };
  return canonicalJsonText(value);
}

function createDeterministicMinimalCheckpoint(
  input: ContextSummarizationInput,
): StructuredCheckpoint {
  const previous = input.previousCheckpoint;
  return createStructuredCheckpoint({
    version: 1,
    goal: input.authorities.goal ?? previous?.goal ?? input.identity.goal,
    constraints: previous?.constraints ?? [],
    completedWork: previous?.completedWork ?? [],
    inProgress: previous?.inProgress ?? [],
    blocked: [
      ...(previous?.blocked ?? []),
      "Semantic summarization was unavailable; continue from the durable source range.",
    ],
    importantDiscoveries: previous?.importantDiscoveries ?? [],
    keyDecisions: previous?.keyDecisions ?? [],
    changedFiles: input.authorities.changedFiles ?? previous?.changedFiles ?? [],
    readFiles: previous?.readFiles ?? [],
    recentErrors: previous?.recentErrors ?? [],
    verificationState:
      input.authorities.verificationState ?? previous?.verificationState ?? "UNKNOWN",
    activeProcesses: input.authorities.activeProcesses ?? previous?.activeProcesses ?? [],
    pendingApprovals: input.authorities.pendingApprovals ?? previous?.pendingApprovals ?? [],
    resourceGovernance:
      input.authorities.resourceGovernance ?? previous?.resourceGovernance ?? "UNKNOWN",
    criticalReferences: previous?.criticalReferences ?? [],
    nextIntent: previous?.nextIntent ?? "Continue from the durable source range.",
    sourceRange: {
      from: input.sourceRange.firstSequence,
      to: input.sourceRange.lastSequence,
    },
  });
}

function serializeAuthorities(input: ContextSummarizationInput): JsonObject {
  return {
    ...(input.authorities.goal === undefined ? {} : { goal: safeText(input.authorities.goal) }),
    ...(input.authorities.changedFiles === undefined
      ? {}
      : { changedFiles: input.authorities.changedFiles.map(safeText) }),
    ...(input.authorities.pendingApprovals === undefined
      ? {}
      : { pendingApprovals: input.authorities.pendingApprovals.map(safeText) }),
    ...(input.authorities.activeProcesses === undefined
      ? {}
      : { activeProcesses: input.authorities.activeProcesses.map(safeText) }),
    ...(input.authorities.verificationState === undefined
      ? {}
      : { verificationState: safeText(input.authorities.verificationState) }),
    ...(input.authorities.resourceGovernance === undefined
      ? {}
      : { resourceGovernance: safeText(input.authorities.resourceGovernance) }),
    ...(input.authorities.projectFacts === undefined
      ? {}
      : { projectFacts: input.authorities.projectFacts.map(safeText) }),
  };
}

function serializeCheckpoint(checkpoint: StructuredCheckpoint): JsonObject {
  return {
    version: checkpoint.version,
    goal: safeText(checkpoint.goal),
    constraints: checkpoint.constraints.map(safeText),
    completedWork: checkpoint.completedWork.map(safeText),
    inProgress: checkpoint.inProgress.map(safeText),
    blocked: checkpoint.blocked.map(safeText),
    importantDiscoveries: checkpoint.importantDiscoveries.map(safeText),
    keyDecisions: checkpoint.keyDecisions.map(safeText),
    changedFiles: checkpoint.changedFiles.map(safeText),
    readFiles: checkpoint.readFiles.map(safeText),
    recentErrors: checkpoint.recentErrors.map(safeText),
    verificationState: safeText(checkpoint.verificationState),
    activeProcesses: checkpoint.activeProcesses.map(safeText),
    pendingApprovals: checkpoint.pendingApprovals.map(safeText),
    resourceGovernance: safeText(checkpoint.resourceGovernance),
    criticalReferences: checkpoint.criticalReferences.map(safeText),
    nextIntent: safeText(checkpoint.nextIntent),
    sourceRange: checkpoint.sourceRange as unknown as JsonObject,
  };
}

function digestCheckpoint(checkpoint: StructuredCheckpoint): string {
  return digestJsonValue(serializeCheckpoint(checkpoint));
}

function freezeSummaryResult(result: ContextSummarizationResult): ContextSummarizationResult {
  return Object.freeze({
    ...result,
    checkpoint: createStructuredCheckpoint(result.checkpoint),
  });
}

function safeText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("Context summarization was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export type { ContextSummaryPromptVersion };
