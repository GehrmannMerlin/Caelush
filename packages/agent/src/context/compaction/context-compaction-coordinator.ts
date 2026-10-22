import { createContextCompactionDigestBuilder } from "./context-compaction-digest.js";
import {
  createContextSummarizationRunner,
  serializeContextSummarySource,
  type ContextSummaryExecutionResult,
} from "./context-summary.js";
import { ContextSummarizationInfrastructureError } from "./context-summary.js";
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  createContextMessageRange,
  type ContextHistoryIndex,
  type ContextCompactionPlan,
  type ContextCheckpointCreateInputV2,
  type ContextCompactionCoordinator,
  type ContextCompactionCoordinatorOptions,
  type ContextCompactionEventFactoryInput,
  type ContextCompactionOutcome,
  type ContextCompactionRequest,
  type ContextCheckpointRecordV2,
  type ContextMessageRange,
  type ContextSummarizationInput,
} from "./context-compaction-contracts.js";
import { ContextCheckpointBudgetUnavailableError } from "./checkpoint-budget.js";
import { isMeaningfulContextCompactionGain } from "./compaction-gain.js";
import type { ContextCompactionRebuildInput } from "./context-compaction-rebuilder.js";
import type { DeterministicCompactionFacts } from "./deterministic-compaction-facts.js";
import { createHistorySourceRef } from "../../messages/history-lookup-port.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { ContextHistoryUnit } from "../history/semantic-history-unit.js";
import {
  createUtf8HeuristicTokenEstimator,
  type ContextTokenEstimatorPort,
} from "../token/context-token-estimator.js";
import { digestJsonValue } from "../../messages/canonical-json.js";
import {
  createStructuredCheckpoint as createStructuredCheckpointRecord,
  type StructuredCheckpoint,
} from "../checkpoint/structured-checkpoint.js";
import type { ContextIncrementalCompactionInput } from "./incremental-compaction-resolver.js";
import type { ContextCheckpointBudget } from "./checkpoint-budget.js";

/**
 * The single Agent-owned compaction lifecycle. Host-specific identity and
 * tentative-build closures are deliberately kept outside the frozen request.
 */
export function createContextCompactionCoordinator(
  options: ContextCompactionCoordinatorOptions,
): ContextCompactionCoordinator {
  const summaryRunner = createContextSummarizationRunner({
    summarizer: options.dependencies.summarizer,
    validator: options.dependencies.summaryValidator,
  });
  const digestBuilder = createContextCompactionDigestBuilder();

  return Object.freeze({
    async compact(request: ContextCompactionRequest): Promise<ContextCompactionOutcome> {
      throwIfAborted(request.signal);
      assertTokenEstimate(request.estimatedInputTokensBefore, "estimatedInputTokensBefore");
      options.onProgress?.("PREPARING", request.reason);
      const previousCheckpoint =
        options.latest.kind === "V2" ? options.latest.checkpoint : undefined;
      const plan = options.dependencies.planner.plan({
        history: request.history,
        policy: request.policy,
        reason: request.reason,
        ...(previousCheckpoint === undefined ? {} : { latestCheckpoint: previousCheckpoint }),
      });
      if (plan === null) {
        return { kind: "NOT_APPLICABLE", reason: "NO_COMPRESSIBLE_HISTORY" };
      }

      let checkpointBudget;
      try {
        checkpointBudget = options.dependencies.checkpointBudget.resolve({
          policy: request.policy,
          plan,
        });
      } catch (error) {
        if (error instanceof ContextCheckpointBudgetUnavailableError) {
          return { kind: "NOT_APPLICABLE", reason: "INSUFFICIENT_GAIN" };
        }
        throw error;
      }
      const gain = options.dependencies.gainEvaluator.evaluate({
        plan,
        checkpointBudget,
      });
      if (!isMeaningfulContextCompactionGain(gain)) {
        return { kind: "NOT_APPLICABLE", reason: "INSUFFICIENT_GAIN" };
      }

      const incremental = options.dependencies.incrementalResolver.resolve({
        plan,
        latest: options.latest,
        conversation: request.conversation,
      });
      throwIfAborted(request.signal);
      options.onProgress?.("SUMMARIZING", request.reason);
      const summary = await summarizeCompactionSource({
        runner: summaryRunner,
        request,
        plan,
        checkpointBudget,
        history: request.history,
        incremental,
        tokenEstimator:
          options.dependencies.summarySourceTokenEstimator ?? createUtf8HeuristicTokenEstimator(),
      });
      throwIfAborted(request.signal);

      if (
        summary.kind === "FALLBACK_REQUIRED" &&
        request.estimatedInputTokensBefore <= request.policy.effectiveInputLimitTokens
      ) {
        return {
          kind: "KEEP_ORIGINAL",
          reason: "SUMMARY_UNAVAILABLE_ORIGINAL_FITS",
          summaryOutcome: summary.outcome,
        };
      }

      const facts = await options.dependencies.factsProvider.collect({
        identity: request.identity,
        sourceRange: incremental.cumulativeSourceRange,
        signal: request.signal,
      });
      throwIfAborted(request.signal);

      const structuredCheckpoint = createStructuredCheckpoint({
        summary,
        request,
        facts,
        ...(incremental.previousCheckpoint === undefined
          ? {}
          : { previousCheckpoint: incremental.previousCheckpoint.structuredCheckpoint }),
        sourceRange: incremental.cumulativeSourceRange,
        dependencies: options.dependencies,
      });
      const degraded = summary.degraded;
      const modelRef = summaryModelRef(summary, request);
      const summaryPromptVersion = summaryPrompt(summary);
      const semanticSourceDigest = summarySourceDigest(summary);
      const checkpointId = options.dependencies.checkpointIdFactory.create();
      const sourceDigest = digestBuilder.source({
        semanticSourceDigest,
        ...(incremental.previousCheckpoint === undefined
          ? {}
          : { previousCheckpoint: incremental.previousCheckpoint }),
        newSourceMessages: incremental.newSourceMessages,
        newSourceRange: incremental.newSourceRange,
        cumulativeSourceRange: incremental.cumulativeSourceRange,
      });
      const checkpointDigest = digestBuilder.checkpoint({
        structuredCheckpoint,
        sourceRange: incremental.cumulativeSourceRange,
      });
      const checkpoint = {
        checkpointId,
        runId: request.identity.runId,
        ...(incremental.previousCheckpoint === undefined
          ? {}
          : { previousCheckpointId: incremental.previousCheckpoint.checkpointId }),
        sourceRange: incremental.cumulativeSourceRange,
        structuredCheckpoint,
        tokensBefore: request.estimatedInputTokensBefore,
        tokensAfter: 0,
        modelRef,
        summaryPromptVersion,
        sourceDigest,
        checkpointDigest,
        degraded,
        reason: request.reason,
        createdAt: options.dependencies.clock.now(),
      } as const;

      const rebuildInput: ContextCompactionRebuildInput = {
        conversation: request.conversation,
        checkpoint: structuredCheckpoint,
        sourceRange: incremental.cumulativeSourceRange,
        policy: request.policy,
        model: request.model,
      };
      options.onProgress?.("REBUILDING", request.reason);
      const rebuild = await (options.tentativeRebuild === undefined
        ? options.dependencies.tentativeRebuilder.rebuild(rebuildInput)
        : options.tentativeRebuild({ checkpointId, degraded, input: rebuildInput }));
      throwIfAborted(request.signal);
      assertTokenEstimate(rebuild.estimatedInputTokens, "estimatedInputTokensAfter");
      const actualFreedTokens = request.estimatedInputTokensBefore - rebuild.estimatedInputTokens;
      const softTargetTokens = Math.floor(request.policy.effectiveInputLimitTokens * 0.8);
      if (
        rebuild.estimatedInputTokens > request.policy.effectiveInputLimitTokens ||
        (rebuild.estimatedInputTokens > softTargetTokens &&
          actualFreedTokens < request.policy.outputReserveTokens)
      ) {
        return { kind: "NOT_APPLICABLE", reason: "INSUFFICIENT_GAIN" };
      }

      const committedInput: ContextCheckpointCreateInputV2 = {
        ...checkpoint,
        tokensAfter: rebuild.estimatedInputTokens,
      };
      throwIfAborted(request.signal);
      const eventInput: ContextCompactionEventFactoryInput = {
        request,
        plan,
        checkpoint: committedInput,
        degraded,
      };
      const committed = await options.dependencies.commit.commit({
        checkpoint: committedInput,
        events: options.createEvents?.(eventInput) ?? [],
      });
      options.notifyCommitted?.(committed.events);
      return {
        kind: "COMPACTED",
        checkpoint: committed.checkpoint,
        receipt: {
          reason: request.reason,
          checkpoint: checkpointRef(committed.checkpoint),
          tokensBefore: request.estimatedInputTokensBefore,
          tokensAfter: committed.checkpoint.tokensAfter,
          actualFreedTokens,
          degraded,
        },
      };
    },
  });
}

async function summarizeCompactionSource(input: {
  readonly runner: ReturnType<typeof createContextSummarizationRunner>;
  readonly request: ContextCompactionRequest;
  readonly plan: ContextCompactionPlan;
  readonly checkpointBudget: ContextCheckpointBudget;
  readonly history: ContextHistoryIndex;
  readonly incremental: ContextIncrementalCompactionInput;
  readonly tokenEstimator: ContextTokenEstimatorPort;
}): Promise<ContextSummaryExecutionResult> {
  const persistedCheckpoint = input.incremental.previousCheckpoint?.structuredCheckpoint;
  const wholeSource = createSummaryInput({
    request: input.request,
    plan: input.plan,
    checkpointBudget: input.checkpointBudget,
    sourceMessages: input.incremental.newSourceMessages,
    sourceRange: input.incremental.cumulativeSourceRange,
    ...(persistedCheckpoint === undefined ? {} : { previousCheckpoint: persistedCheckpoint }),
  });
  const fullSourceDigest = digestJsonValue(JSON.parse(serializeContextSummarySource(wholeSource)));
  const maxSourceTokens = input.request.policy.effectiveInputLimitTokens;
  const estimate = (summaryInput: ContextSummarizationInput): number =>
    input.tokenEstimator.estimateText(
      serializeContextSummarySource(summaryInput),
      input.request.model,
    );

  if (estimate(wholeSource) <= maxSourceTokens) {
    return input.runner.summarize(wholeSource, { signal: input.request.signal });
  }

  const groups = createClosedSummarySourceGroups(
    input.history.units,
    input.incremental.newSourceMessages,
  );
  if (groups === undefined) {
    return failedSummary(
      input.request,
      fullSourceDigest,
      "The selected summary source intersects an open or incomplete Tool protocol unit.",
    );
  }

  let previousCheckpoint = persistedCheckpoint;
  let pending: StoredAgentMessage[] = [];
  let latestAccepted:
    Extract<ContextSummaryExecutionResult, { readonly kind: "ACCEPTED" }> | undefined;
  const segmentDigests: string[] = [];
  const summarizeSegment = async (
    messages: readonly StoredAgentMessage[],
  ): Promise<ContextSummaryExecutionResult> => {
    const sourceRange = cumulativeRangeThrough(input.incremental.cumulativeSourceRange, messages);
    const summaryInput = createSummaryInput({
      request: input.request,
      plan: input.plan,
      checkpointBudget: input.checkpointBudget,
      sourceMessages: messages,
      sourceRange,
      ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
    });
    if (estimate(summaryInput) > maxSourceTokens) {
      return failedSummary(
        input.request,
        fullSourceDigest,
        "One complete history unit exceeds the model's summary input budget.",
      );
    }
    const result = await input.runner.summarize(summaryInput, {
      signal: input.request.signal,
    });
    if (result.kind === "FALLBACK_REQUIRED") {
      return { ...result, sourceDigest: fullSourceDigest };
    }
    segmentDigests.push(result.result.sourceDigest);
    latestAccepted = result;
    previousCheckpoint = createSemanticMemoryCheckpoint(
      result.result.semantic,
      sourceRange,
      previousCheckpoint,
    );
    return result;
  };

  for (const group of groups) {
    const candidate = [...pending, ...group].sort((left, right) => left.sequence - right.sequence);
    const candidateInput = createSummaryInput({
      request: input.request,
      plan: input.plan,
      checkpointBudget: input.checkpointBudget,
      sourceMessages: candidate,
      sourceRange: cumulativeRangeThrough(input.incremental.cumulativeSourceRange, candidate),
      ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
    });
    if (estimate(candidateInput) <= maxSourceTokens) {
      pending = candidate;
      continue;
    }
    if (pending.length === 0) {
      return failedSummary(
        input.request,
        fullSourceDigest,
        "One complete history unit exceeds the model's summary input budget.",
      );
    }
    const completed = await summarizeSegment(pending);
    if (completed.kind === "FALLBACK_REQUIRED") return completed;
    pending = [...group];
  }

  if (pending.length > 0) {
    const completed = await summarizeSegment(pending);
    if (completed.kind === "FALLBACK_REQUIRED") return completed;
  }

  if (latestAccepted === undefined) {
    // An empty source is still a valid summary input; it is not a reason to invent content.
    return input.runner.summarize(wholeSource, { signal: input.request.signal });
  }
  if (segmentDigests.length === 1) return latestAccepted;
  return {
    ...latestAccepted,
    result: {
      ...latestAccepted.result,
      sourceDigest: digestJsonValue([fullSourceDigest, ...segmentDigests]),
    },
  };
}

function createSummaryInput(input: {
  readonly request: ContextCompactionRequest;
  readonly plan: ContextCompactionPlan;
  readonly checkpointBudget: ContextCheckpointBudget;
  readonly sourceMessages: readonly StoredAgentMessage[];
  readonly sourceRange: ContextMessageRange;
  readonly previousCheckpoint?: StructuredCheckpoint;
}): ContextSummarizationInput {
  return {
    purpose: "COMPACTION",
    cacheEligibility: "NOT_ELIGIBLE",
    identity: input.request.identity,
    reason: input.request.reason,
    ...(input.previousCheckpoint === undefined
      ? {}
      : { previousCheckpoint: input.previousCheckpoint }),
    sourceMessages: input.sourceMessages,
    sourceRange: input.sourceRange,
    cut: input.plan.cut,
    targetTokens: input.checkpointBudget.targetTokens,
    model: input.request.model,
  };
}

/**
 * Build complete batches from durable message identities. Open or partial Tool units are never
 * split to make a summary fit; the caller degrades to a readable source reference instead.
 */
function createClosedSummarySourceGroups(
  units: readonly ContextHistoryUnit[],
  sourceMessages: readonly StoredAgentMessage[],
): readonly (readonly StoredAgentMessage[])[] | undefined {
  if (sourceMessages.length === 0) return [];
  const sourceById = new Map(sourceMessages.map((stored) => [String(stored.message.id), stored]));
  if (sourceById.size !== sourceMessages.length) return undefined;
  const covered = new Set<string>();
  const groups: StoredAgentMessage[][] = [];
  for (const unit of units) {
    if (unit.kind !== "TOOL_PROTOCOL") continue;
    const members = unit.messages.filter((message) => sourceById.has(String(message.messageId)));
    if (members.length === 0) continue;
    if (
      unit.status !== "CLOSED" ||
      !unit.compactionEligible ||
      members.length !== unit.messages.length
    ) {
      return undefined;
    }
    const group = members
      .map((message) => sourceById.get(String(message.messageId)))
      .filter((stored): stored is StoredAgentMessage => stored !== undefined)
      .sort((left, right) => left.sequence - right.sequence);
    for (const stored of group) covered.add(String(stored.message.id));
    groups.push(group);
  }
  for (const stored of sourceMessages) {
    if (!covered.has(String(stored.message.id))) groups.push([stored]);
  }
  groups.sort((left, right) => left[0]!.sequence - right[0]!.sequence);

  const merged: StoredAgentMessage[][] = [];
  for (const group of groups) {
    const prior = merged.at(-1);
    const priorLast = prior?.at(-1);
    if (
      prior !== undefined &&
      priorLast !== undefined &&
      group[0]!.sequence <= priorLast.sequence
    ) {
      const byId = new Map<string, StoredAgentMessage>();
      for (const stored of [...prior, ...group]) byId.set(String(stored.message.id), stored);
      merged[merged.length - 1] = [...byId.values()].sort(
        (left, right) => left.sequence - right.sequence,
      );
    } else {
      merged.push([...group]);
    }
  }
  const mergedIds = merged.flat().map((stored) => String(stored.message.id));
  if (
    mergedIds.length !== sourceMessages.length ||
    new Set(mergedIds).size !== sourceMessages.length
  ) {
    return undefined;
  }
  return merged;
}

function cumulativeRangeThrough(
  base: ContextMessageRange,
  messages: readonly StoredAgentMessage[],
): ContextMessageRange {
  if (messages.length === 0) return base;
  const last = messages.reduce((latest, stored) =>
    stored.sequence > latest.sequence ? stored : latest,
  );
  if (
    messages.some(
      (stored) =>
        String(stored.message.runId) !== String(base.runId) ||
        String(stored.message.conversationTurnId) !== String(base.conversationTurnId),
    ) ||
    last.sequence < base.firstSequence
  ) {
    throw new TypeError("Summary segments must remain inside one durable source range.");
  }
  return createContextMessageRange({
    ...base,
    lastMessageId: last.message.id,
    lastSequence: last.sequence,
  });
}

function createSemanticMemoryCheckpoint(
  semantic: import("./semantic-checkpoint-draft.js").SemanticCheckpointDraft,
  sourceRange: ContextMessageRange,
  previous?: StructuredCheckpoint,
): StructuredCheckpoint {
  return createStructuredCheckpointRecord({
    version: 1,
    goal: semantic.goal,
    constraints: semantic.constraints,
    completedWork: semantic.completedWork,
    inProgress: semantic.inProgress,
    blocked: semantic.blocked,
    importantDiscoveries: semantic.importantDiscoveries,
    keyDecisions: semantic.keyDecisions,
    changedFiles: previous?.changedFiles ?? [],
    readFiles: previous?.readFiles ?? [],
    recentErrors: previous?.recentErrors ?? [],
    verificationState: previous?.verificationState ?? "UNKNOWN",
    activeProcesses: previous?.activeProcesses ?? [],
    pendingApprovals: previous?.pendingApprovals ?? [],
    resourceGovernance: previous?.resourceGovernance ?? "BOUNDED",
    criticalReferences: semantic.criticalReferences,
    nextIntent: semantic.nextIntent,
    sourceRange: { from: sourceRange.firstSequence, to: sourceRange.lastSequence },
  });
}

function failedSummary(
  request: ContextCompactionRequest,
  sourceDigest: string,
  reason: string,
): ContextSummaryExecutionResult {
  return {
    kind: "FALLBACK_REQUIRED",
    outcome: "FAILED",
    reason,
    modelRef: request.model.ref,
    summaryPromptVersion: CONTEXT_SUMMARY_PROMPT_VERSION,
    sourceDigest,
    degraded: true,
  };
}

function assertTokenEstimate(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

function createStructuredCheckpoint(input: {
  readonly summary: ContextSummaryExecutionResult;
  readonly request: ContextCompactionRequest;
  readonly facts: DeterministicCompactionFacts;
  readonly previousCheckpoint?: import("../checkpoint/structured-checkpoint.js").StructuredCheckpoint;
  readonly sourceRange: ContextMessageRange;
  readonly dependencies: ContextCompactionCoordinatorOptions["dependencies"];
}) {
  if (input.summary.kind === "ACCEPTED") {
    const sourceRef = createHistorySourceRef({
      runId: input.sourceRange.runId,
      firstSequence: input.sourceRange.firstSequence,
      lastSequence: input.sourceRange.lastSequence,
    });
    const criticalReferences = [...input.summary.result.semantic.criticalReferences];
    if (!criticalReferences.includes(sourceRef)) criticalReferences.push(sourceRef);
    return input.dependencies.enricher.enrich({
      semantic: {
        ...input.summary.result.semantic,
        goal: input.request.identity.goal,
        criticalReferences,
      },
      facts: input.facts,
      sourceRange: input.sourceRange,
    });
  }
  return input.dependencies.deterministicFallback.build({
    goal: input.request.identity.goal,
    sourceRange: input.sourceRange,
    facts: input.facts,
    ...(input.previousCheckpoint === undefined
      ? {}
      : { previousCheckpoint: input.previousCheckpoint }),
  });
}

function summaryModelRef(
  summary: ContextSummaryExecutionResult,
  request: ContextCompactionRequest,
) {
  return summary.kind === "ACCEPTED" ? summary.result.modelRef : request.model.ref;
}

function summaryPrompt(summary: ContextSummaryExecutionResult) {
  return summary.kind === "ACCEPTED"
    ? summary.result.summaryPromptVersion
    : CONTEXT_SUMMARY_PROMPT_VERSION;
}

function summarySourceDigest(summary: ContextSummaryExecutionResult): string {
  return summary.kind === "ACCEPTED" ? summary.result.sourceDigest : summary.sourceDigest;
}

function checkpointRef(record: ContextCheckpointRecordV2) {
  return Object.freeze({
    checkpointId: record.checkpointId,
    schemaVersion: 2 as const,
    sourceRange: record.sourceRange,
    degraded: record.degraded,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Context compaction was cancelled.");
  error.name = "AbortError";
  throw error;
}

export { ContextSummarizationInfrastructureError };
