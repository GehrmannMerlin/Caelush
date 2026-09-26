import type { JsonObject } from "@caelush/ai";

import { canonicalJsonText, digestJsonValue } from "../../messages/canonical-json.js";
import type {
  AgentAssistantContentPart,
  AgentUserContentPart,
} from "../../messages/types/content.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import {
  createContextSummaryPromptVersion,
  type ContextSummarizationInput,
  type ContextSummarizationResult,
  type ContextSummarizerPort,
  type ContextSummaryPromptVersion,
} from "./context-compaction-contracts.js";
import { createStructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";

const DEFAULT_SUMMARY_PROMPT_VERSION = createContextSummaryPromptVersion(1);
const MAX_SUMMARY_TEXT = 512;
const MAX_SUMMARY_MESSAGES = 128;
const MAX_SUMMARY_CONTENT_PARTS = 32;
const MAX_SERIALIZED_SUMMARY_SOURCE = 24_000;

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

/** Serialize only bounded semantic facts suitable for a summarizer adapter. */
export function serializeContextSummarySource(input: ContextSummarizationInput): string {
  const messages = input.sourceMessages
    .slice(0, MAX_SUMMARY_MESSAGES)
    .map((stored) => serializeStoredMessage(stored));
  const value: JsonObject = {
    reason: input.reason,
    targetTokens: input.targetTokens,
    model: {
      provider: input.model.ref.provider,
      model: input.model.ref.model,
    },
    sourceRange: input.sourceRange as unknown as JsonObject,
    authorities: serializeAuthorities(input),
    previousCheckpoint:
      input.previousCheckpoint === undefined ? null : serializeCheckpoint(input.previousCheckpoint),
    messages,
    omittedMessageCount: Math.max(0, input.sourceMessages.length - messages.length),
  };
  const serialized = canonicalJsonText(value);
  return serialized.length <= MAX_SERIALIZED_SUMMARY_SOURCE
    ? serialized
    : `${serialized.slice(0, MAX_SERIALIZED_SUMMARY_SOURCE - 1)}…`;
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

function serializeStoredMessage(stored: StoredAgentMessage): JsonObject {
  const message = stored.message;
  const base: JsonObject = {
    messageId: message.id,
    runId: message.runId,
    conversationTurnId: message.conversationTurnId,
    sequence: stored.sequence,
    schemaVersion: stored.schemaVersion,
    modelProjectionVersion: stored.modelProjectionVersion ?? null,
    type: message.type,
  };
  if (message.type === "USER") {
    return {
      ...base,
      content: message.content.slice(0, MAX_SUMMARY_CONTENT_PARTS).map(serializeUserPart),
    };
  }
  if (message.type === "ASSISTANT") {
    return {
      ...base,
      content: message.content.slice(0, MAX_SUMMARY_CONTENT_PARTS).map(serializeAssistantPart),
    };
  }
  if (message.type === "TOOL_RESULT") {
    return {
      ...base,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      observation: message.observation.kind,
      projectedContent: "[tool observation omitted from semantic summary]",
    };
  }
  return base;
}

function serializeUserPart(part: AgentUserContentPart): JsonObject {
  if (part.type === "TEXT") return { type: part.type, text: safeText(part.text) };
  return {
    type: part.type,
    artifactId: safeText(part.artifactId),
    ...(part.label === undefined ? {} : { label: safeText(part.label) }),
    ...(part.mediaType === undefined ? {} : { mediaType: safeText(part.mediaType) }),
  };
}

function serializeAssistantPart(part: AgentAssistantContentPart): JsonObject {
  if (part.type === "TEXT") return { type: part.type, text: safeText(part.text) };
  return {
    type: part.type,
    toolCallId: part.toolCallId,
    toolName: safeText(part.toolName),
    input: "[tool input omitted from semantic summary]",
  };
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
  const redacted = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
  return redacted.length <= MAX_SUMMARY_TEXT
    ? redacted
    : `${redacted.slice(0, MAX_SUMMARY_TEXT - 1)}…`;
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
