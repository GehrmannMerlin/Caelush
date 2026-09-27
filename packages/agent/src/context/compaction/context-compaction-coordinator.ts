import { createContextCompactionDigestBuilder } from "./context-compaction-digest.js";
import {
  createContextSummarizationRunner,
  type ContextSummaryExecutionResult,
} from "./context-summary.js";
import {
  ContextSummarizationInfrastructureError,
} from "./context-summary.js";
import {
  CONTEXT_SUMMARY_PROMPT_VERSION,
  type ContextCheckpointCreateInputV2,
  type ContextCompactionCoordinator,
  type ContextCompactionCoordinatorOptions,
  type ContextCompactionEventFactoryInput,
  type ContextCompactionOutcome,
  type ContextCompactionRequest,
  type ContextCheckpointRecordV2,
  type ContextMessageRange,
} from "./context-compaction-contracts.js";
import { ContextCheckpointBudgetUnavailableError } from "./checkpoint-budget.js";
import { isMeaningfulContextCompactionGain } from "./compaction-gain.js";
import type { ContextCompactionRebuildInput } from "./context-compaction-rebuilder.js";
import type { DeterministicCompactionFacts } from "./deterministic-compaction-facts.js";

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
      const summary = await summaryRunner.summarize(
        {
          identity: request.identity,
          reason: request.reason,
          ...(incremental.previousCheckpoint === undefined
            ? {}
            : { previousCheckpoint: incremental.previousCheckpoint.structuredCheckpoint }),
          sourceMessages: incremental.newSourceMessages,
          sourceRange: incremental.cumulativeSourceRange,
          cut: plan.cut,
          targetTokens: checkpointBudget.targetTokens,
          model: request.model,
        },
        { signal: request.signal },
      );
      throwIfAborted(request.signal);

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
        tokensBefore: plan.estimatedTokensBefore,
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
      const rebuild = await (options.tentativeRebuild === undefined
        ? options.dependencies.tentativeRebuilder.rebuild(rebuildInput)
        : options.tentativeRebuild({ checkpointId, degraded, input: rebuildInput }));
      throwIfAborted(request.signal);
      if (rebuild.estimatedInputTokens > request.policy.effectiveInputLimitTokens) {
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
          tokensBefore: plan.estimatedTokensBefore,
          tokensAfter: committed.checkpoint.tokensAfter,
          degraded,
        },
      };
    },
  });
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
    return input.dependencies.enricher.enrich({
      semantic: input.summary.result.semantic,
      facts: input.facts,
      sourceRange: input.sourceRange,
    });
  }
  return input.dependencies.deterministicFallback.build({
    goal: input.request.identity.goal,
    sourceRange: input.sourceRange,
    facts: input.facts,
    ...(input.previousCheckpoint === undefined ? {} : { previousCheckpoint: input.previousCheckpoint }),
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
