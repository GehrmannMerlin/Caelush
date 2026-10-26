import {
  createContextCompactionDigestBuilder,
  createContextCompactionDigestBuilderV3,
} from "./context-compaction-digest.js";
import {
  createContextSummarizationRunner,
  createContextSummaryReplayPrefixFingerprint,
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
import type {
  ContextCheckpointCreateInputV3,
  ContextCheckpointRecordV3,
} from "./context-checkpoint-v3.js";
import { estimateAIMessages } from "../token/materialized-message-estimator.js";
import { createContextSourceCoverage } from "./context-source-coverage.js";
import {
  beginPersistedCompactionSubcall,
  createPersistedCompactionAttemptTerminalArtifact,
  finishPersistedCompactionSubcall,
  MAX_PERSISTED_COMPACTION_SUBCALLS,
} from "./persisted-compaction-attempt.js";
import {
  ContextCheckpointBudgetUnavailableError,
  fitStructuredCheckpointToBudget,
} from "./checkpoint-budget.js";
import { isMeaningfulContextCompactionGain } from "./compaction-gain.js";
import type { ContextCompactionRebuildInput } from "./context-compaction-rebuilder.js";
import type { DeterministicCompactionFacts } from "./deterministic-compaction-facts.js";
import {
  acceptCompactionCandidate,
  resolveCompactionRetentionBudget,
} from "./compaction-retention-budget.js";
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
import {
  createStructuredCheckpointV2,
  type StructuredCheckpointV2,
} from "../checkpoint/structured-checkpoint.js";

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
      if (
        options.dependencies.commit.commitV3 !== undefined &&
        options.createEventsV3 !== undefined &&
        request.ownerStepSequence !== undefined
      ) {
        return compactV3({ options, request, plan });
      }
      // A V2 envelope can express one Run-local range only. Without the prepared V3 activation
      // transaction, never persist a partial representation of a multi-Run plan.
      if ((plan.sourceCoverageDelta?.length ?? 1) > 1) {
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
      const retentionBudget = resolveCompactionRetentionBudget({
        fixedTokens:
          request.fixedInputTokens ??
          Math.max(
            0,
            request.estimatedInputTokensBefore -
              (Number.isSafeInteger(request.history.estimatedTokens)
                ? request.history.estimatedTokens
                : plan.estimatedTokensBefore),
          ),
        recentTokens: Math.min(
          plan.retainedTokens,
          request.policy.deepCompaction?.recentTokens ??
            (Number.isSafeInteger(request.policy.targetRecentTailTokens)
              ? request.policy.targetRecentTailTokens
              : plan.targetRecentTailTokens),
        ),
        checkpointMaxTokens: Math.min(
          checkpointBudget.maxTokens,
          request.policy.deepCompaction?.checkpointMaxTokens ?? checkpointBudget.maxTokens,
        ),
        boundaryTokens:
          request.boundaryTokens ??
          request.policy.deepCompaction?.boundaryTokens ??
          Math.min(
            4_096,
            Number.isSafeInteger(request.policy.minRecentTailTokens)
              ? request.policy.minRecentTailTokens
              : plan.minRecentTailTokens,
          ),
        availableInputTokens: request.policy.effectiveInputLimitTokens,
      });

      const incremental = options.dependencies.incrementalResolver.resolve({
        plan,
        latest: options.latest,
        conversation: request.conversation,
      });
      throwIfAborted(request.signal);
      options.onProgress?.("SUMMARIZING", request.reason);
      const summary = await summarizeCompactionSource({
        runner: createAttemptClaimedSummaryRunner({
          runner: summaryRunner,
          request,
          dependencies: options.dependencies,
        }),
        request,
        plan,
        checkpointBudget,
        history: request.history,
        incremental,
        tokenEstimator:
          options.dependencies.summarySourceTokenEstimator ?? createUtf8HeuristicTokenEstimator(),
      });
      throwIfAborted(request.signal);

      /*
       * "The original still fits" is a hypothesis, and a forced recovery has already tested it.
       *
       * A FORCED_PROVIDER_OVERFLOW reason exists because the provider rejected this exact request,
       * so keeping the original replays a request we know fails. When the semantic summary is
       * unavailable, the deterministic fallback is the only path that actually shrinks the input:
       * a degraded checkpoint carrying durable facts beats a guaranteed second rejection.
       */
      if (
        summary.kind === "FALLBACK_REQUIRED" &&
        request.policy.deepCompaction === undefined &&
        request.reason !== "FORCED_PROVIDER_OVERFLOW" &&
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
        checkpointBudget,
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
      const candidateFits =
        request.reason === "FORCED_PROVIDER_OVERFLOW"
          ? rebuild.estimatedInputTokens < request.estimatedInputTokensBefore &&
            rebuild.estimatedInputTokens <= retentionBudget.availableInputTokens
          : acceptCompactionCandidate({
              inputTokens: rebuild.estimatedInputTokens,
              budget: retentionBudget,
            });
      if (!candidateFits) {
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
        ...(rebuild.activation === undefined ? {} : { activation: rebuild.activation }),
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

async function compactV3(input: {
  readonly options: ContextCompactionCoordinatorOptions;
  readonly request: ContextCompactionRequest;
  readonly plan: ContextCompactionPlan;
}): Promise<ContextCompactionOutcome> {
  const { options, request, plan } = input;
  const createEventsV3 = options.createEventsV3;
  const ownerStepSequence = request.ownerStepSequence;
  if (
    options.dependencies.commit.commitV3 === undefined ||
    createEventsV3 === undefined ||
    ownerStepSequence === undefined
  ) {
    throw new TypeError("V3 compaction is missing its atomic commit boundary.");
  }
  throwIfAborted(request.signal);

  let checkpointBudget: ContextCheckpointBudget;
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
  const gain = options.dependencies.gainEvaluator.evaluate({ plan, checkpointBudget });
  if (!isMeaningfulContextCompactionGain(gain)) {
    return { kind: "NOT_APPLICABLE", reason: "INSUFFICIENT_GAIN" };
  }

  const retentionBudget = resolveCompactionRetentionBudget({
    fixedTokens:
      request.fixedInputTokens ??
      Math.max(
        0,
        request.estimatedInputTokensBefore -
          (Number.isSafeInteger(request.history.estimatedTokens)
            ? request.history.estimatedTokens
            : plan.estimatedTokensBefore),
      ),
    recentTokens: Math.min(
      plan.retainedTokens,
      request.policy.deepCompaction?.recentTokens ??
        (Number.isSafeInteger(request.policy.targetRecentTailTokens)
          ? request.policy.targetRecentTailTokens
          : plan.targetRecentTailTokens),
    ),
    checkpointMaxTokens: Math.min(
      checkpointBudget.maxTokens,
      request.policy.deepCompaction?.checkpointMaxTokens ?? checkpointBudget.maxTokens,
    ),
    boundaryTokens:
      request.boundaryTokens ??
      request.policy.deepCompaction?.boundaryTokens ??
      Math.min(
        4_096,
        Number.isSafeInteger(request.policy.minRecentTailTokens)
          ? request.policy.minRecentTailTokens
          : plan.minRecentTailTokens,
      ),
    availableInputTokens: request.policy.effectiveInputLimitTokens,
  });

  const sourceCoverageDelta = plan.sourceCoverageDelta ?? [plan.sourceRange];
  const previousCheckpoint = options.latestSessionCheckpoint;
  const previousCoverage =
    previousCheckpoint === undefined
      ? undefined
      : previousCheckpoint.schemaVersion === 3
        ? previousCheckpoint.coverage
        : createContextSourceCoverage({
            sessionId: request.identity.sessionId,
            segments: [previousCheckpoint.sourceRange],
            conversation: request.conversation,
          });
  const sourceCoverage = createContextSourceCoverage({
    sessionId: request.identity.sessionId,
    segments: [...(previousCoverage?.segments ?? []), ...sourceCoverageDelta],
    conversation: request.conversation,
  });
  const newSourceMessages = selectCoverageDeltaMessages(request.conversation, sourceCoverageDelta);
  if (newSourceMessages.length === 0) {
    return { kind: "NOT_APPLICABLE", reason: "NO_COMPRESSIBLE_HISTORY" };
  }

  throwIfAborted(request.signal);
  options.onProgress?.("SUMMARIZING", request.reason);
  const previousSemanticCheckpoint =
    previousCheckpoint === undefined
      ? undefined
      : previousCheckpoint.schemaVersion === 3
        ? structuredCheckpointV2AsV1(previousCheckpoint.structuredCheckpoint)
        : previousCheckpoint.structuredCheckpoint;
  const summary = await summarizeCompactionSourceV3({
    runner: createAttemptClaimedSummaryRunner({
      runner: createContextSummarizationRunner({
        summarizer: options.dependencies.summarizer,
        validator: options.dependencies.summaryValidator,
      }),
      request,
      dependencies: options.dependencies,
    }),
    request,
    plan,
    checkpointBudget,
    ...(previousSemanticCheckpoint === undefined
      ? {}
      : { previousCheckpoint: previousSemanticCheckpoint }),
    newSourceMessages,
    tokenEstimator:
      options.dependencies.summarySourceTokenEstimator ?? createUtf8HeuristicTokenEstimator(),
  });
  throwIfAborted(request.signal);
  if (
    summary.kind === "FALLBACK_REQUIRED" &&
    request.policy.deepCompaction === undefined &&
    request.reason !== "FORCED_PROVIDER_OVERFLOW" &&
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
    sourceRange: plan.sourceRange,
    signal: request.signal,
  });
  throwIfAborted(request.signal);
  const legacyCheckpoint = createStructuredCheckpoint({
    summary,
    request,
    facts,
    checkpointBudget,
    ...(previousSemanticCheckpoint === undefined
      ? {}
      : { previousCheckpoint: previousSemanticCheckpoint }),
    sourceRange: plan.sourceRange,
    dependencies: options.dependencies,
  });
  const { version, sourceRange, ...semanticFields } = legacyCheckpoint;
  if (
    version !== 1 ||
    sourceRange.from !== plan.sourceRange.firstSequence ||
    sourceRange.to !== plan.sourceRange.lastSequence
  ) {
    throw new TypeError("Legacy checkpoint source range does not match its compaction plan.");
  }
  const structuredCheckpoint = fitStructuredCheckpointToBudget({
    checkpoint: createStructuredCheckpointV2({
      ...semanticFields,
      version: 2,
      sourceCoverage,
    }),
    maxTokens: checkpointBudget.maxTokens,
    model: request.model,
    ...(options.dependencies.summarySourceTokenEstimator === undefined
      ? {}
      : { tokenEstimator: options.dependencies.summarySourceTokenEstimator }),
  });
  const checkpointId = options.dependencies.checkpointIdFactory.create();
  const operationId = `context-compaction:${String(checkpointId)}`;
  const digestBuilder = createContextCompactionDigestBuilderV3();
  const sourceDigest = digestBuilder.source({
    semanticSourceDigest: summarySourceDigest(summary),
    ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
    newSourceMessages,
    sourceCoverageDelta,
    cumulativeCoverage: sourceCoverage,
  });
  const checkpointDigest = digestBuilder.checkpoint({
    structuredCheckpoint,
    coverage: sourceCoverage,
  });
  const degraded = summary.degraded;
  const modelRef = summaryModelRef(summary, request);
  const checkpoint: ContextCheckpointCreateInputV3 = {
    checkpointId,
    ownerRunId: request.identity.runId,
    ownerStepSequence,
    sessionId: request.identity.sessionId,
    ...(previousCheckpoint === undefined
      ? {}
      : { previousCheckpointId: previousCheckpoint.checkpointId }),
    activationOperationId: operationId,
    coverage: sourceCoverage,
    structuredCheckpoint,
    tokensBefore: request.estimatedInputTokensBefore,
    tokensAfter: 0,
    modelRef,
    summaryPromptVersion: summaryPrompt(summary),
    sourceDigest,
    checkpointDigest,
    degraded,
    reason: request.reason,
    targetStatus: retentionBudget.targetStatus,
    createdAt: options.dependencies.clock.now(),
  };
  const rebuildInput: ContextCompactionRebuildInput = {
    conversation: request.conversation,
    checkpoint: structuredCheckpoint,
    sourceRange: plan.sourceRange,
    sourceCoverage,
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
  const candidateFits =
    request.reason === "FORCED_PROVIDER_OVERFLOW"
      ? rebuild.estimatedInputTokens < request.estimatedInputTokensBefore &&
        rebuild.estimatedInputTokens <= retentionBudget.availableInputTokens
      : acceptCompactionCandidate({
          inputTokens: rebuild.estimatedInputTokens,
          budget: retentionBudget,
        });
  if (!candidateFits) {
    return { kind: "NOT_APPLICABLE", reason: "INSUFFICIENT_GAIN" };
  }
  if (rebuild.activation === undefined) {
    throw new TypeError(
      "V3 compaction rebuild did not prepare an atomic Prompt Surface activation.",
    );
  }
  const committedInput: ContextCheckpointCreateInputV3 = {
    ...checkpoint,
    tokensAfter: rebuild.estimatedInputTokens,
  };
  throwIfAborted(request.signal);
  const events = createEventsV3({
    request,
    checkpoint: committedInput,
    epochId: String(rebuild.activation.promptSurface.newEpoch.epochId),
    freedTokens: actualFreedTokens,
  });
  const committed = await options.dependencies.commit.commitV3({
    checkpoint: committedInput,
    events,
    ...(request.persistedAttempt === undefined
      ? {}
      : {
          terminalArtifact: createPersistedCompactionAttemptTerminalArtifact({
            attempt: request.persistedAttempt,
            createdSequence: ownerStepSequence,
            createdAt: options.dependencies.clock.now(),
            outcome: "COMPACTED",
            checkpointId: String(committedInput.checkpointId),
            activationOperationId: committedInput.activationOperationId,
          }),
        }),
    activation: {
      ...rebuild.activation,
      targetStatus: retentionBudget.targetStatus,
    },
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
}

function createAttemptClaimedSummaryRunner(input: {
  readonly runner: ReturnType<typeof createContextSummarizationRunner>;
  readonly request: ContextCompactionRequest;
  readonly dependencies: ContextCompactionCoordinatorOptions["dependencies"];
}): ReturnType<typeof createContextSummarizationRunner> {
  let callOrdinal = 0;
  return Object.freeze({
    async summarize(
      summaryInput: ContextSummarizationInput,
      options: { readonly signal: AbortSignal },
    ): Promise<ContextSummaryExecutionResult> {
      const attempt = input.request.persistedAttempt;
      if (attempt === undefined) return input.runner.summarize(summaryInput, options);
      const store = input.dependencies.attemptStore;
      if (store === undefined) {
        throw new ContextSummarizationInfrastructureError(
          "Persistent compaction attempt has no summary subcall Artifact store.",
        );
      }
      const ordinal = callOrdinal;
      if (ordinal >= MAX_PERSISTED_COMPACTION_SUBCALLS) {
        throw new ContextSummarizationInfrastructureError(
          "Compaction summary exceeded its durable subcall limit.",
        );
      }
      callOrdinal += 1;
      const requestFingerprint = `sha256:${digestJsonValue({
        source: JSON.parse(serializeContextSummarySource(summaryInput)) as never,
        replayPrefixFingerprint: summaryInput.replayPrefixFingerprint ?? null,
        modelRef: summaryInput.model.ref,
        api: summaryInput.model.api,
        targetTokens: summaryInput.targetTokens,
      } as never)}`;
      const createdSequence = input.request.ownerStepSequence ?? 1;
      const createdAt = input.dependencies.clock.now();
      const claimed = await beginPersistedCompactionSubcall({
        store,
        attempt,
        callOrdinal: ordinal,
        requestFingerprint,
        createdSequence,
        createdAt,
      });
      if (claimed.kind !== "CLAIMED") {
        throw new ContextSummarizationInfrastructureError(
          "Compaction summary subcall was already started and cannot be resent.",
        );
      }
      const result = await input.runner.summarize(summaryInput, options);
      await finishPersistedCompactionSubcall({
        store,
        attempt,
        callOrdinal: ordinal,
        requestFingerprint,
        outcome: result.kind === "ACCEPTED" ? "ACCEPTED" : "FALLBACK_REQUIRED",
        createdSequence,
        createdAt: input.dependencies.clock.now(),
      });
      return result;
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
      input.request.identity.goal,
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

async function summarizeCompactionSourceV3(input: {
  readonly runner: ReturnType<typeof createContextSummarizationRunner>;
  readonly request: ContextCompactionRequest;
  readonly plan: ContextCompactionPlan;
  readonly checkpointBudget: ContextCheckpointBudget;
  readonly previousCheckpoint?: StructuredCheckpoint;
  readonly newSourceMessages: readonly StoredAgentMessage[];
  readonly tokenEstimator: ContextTokenEstimatorPort;
}): Promise<ContextSummaryExecutionResult> {
  const wholeSource = createSummaryInput({
    request: input.request,
    plan: input.plan,
    checkpointBudget: input.checkpointBudget,
    sourceMessages: input.newSourceMessages,
    sourceRange: input.plan.sourceRange,
    ...(input.previousCheckpoint === undefined
      ? {}
      : { previousCheckpoint: input.previousCheckpoint }),
  });
  const fullSourceDigest = digestJsonValue(JSON.parse(serializeContextSummarySource(wholeSource)));
  const maxSourceTokens = input.request.policy.effectiveInputLimitTokens;
  const estimate = (summaryInput: ContextSummarizationInput): number =>
    input.tokenEstimator.estimateText(
      serializeContextSummarySource(summaryInput),
      input.request.model,
    );
  if (estimate(wholeSource) <= maxSourceTokens) {
    const replayInput = createCacheCompatibleSummaryInput({
      base: wholeSource,
      request: input.request,
      tokenEstimator: input.tokenEstimator,
    });
    return input.runner.summarize(replayInput ?? wholeSource, {
      signal: input.request.signal,
    });
  }

  const groups = createClosedSummarySourceGroups(
    input.request.history.units,
    input.newSourceMessages,
    input.request.conversation,
  );
  if (groups === undefined) {
    return failedSummary(
      input.request,
      fullSourceDigest,
      "The selected summary source intersects an open or incomplete Tool protocol unit.",
    );
  }
  let previousCheckpoint = input.previousCheckpoint;
  let pending: StoredAgentMessage[] = [];
  let latestAccepted:
    Extract<ContextSummaryExecutionResult, { readonly kind: "ACCEPTED" }> | undefined;
  const segmentDigests: string[] = [];
  const summarizeSegment = async (
    messages: readonly StoredAgentMessage[],
  ): Promise<ContextSummaryExecutionResult> => {
    const sourceRange = firstMessageRange(messages);
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
    if (result.kind === "FALLBACK_REQUIRED") return { ...result, sourceDigest: fullSourceDigest };
    segmentDigests.push(result.result.sourceDigest);
    latestAccepted = result;
    previousCheckpoint = createSemanticMemoryCheckpoint(
      result.result.semantic,
      input.request.identity.goal,
      sourceRange,
      previousCheckpoint,
    );
    return result;
  };

  for (const group of groups) {
    const candidate = [...pending, ...group];
    const candidateInput = createSummaryInput({
      request: input.request,
      plan: input.plan,
      checkpointBudget: input.checkpointBudget,
      sourceMessages: candidate,
      sourceRange: firstMessageRange(candidate),
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

function createCacheCompatibleSummaryInput(input: {
  readonly base: ContextSummarizationInput;
  readonly request: ContextCompactionRequest;
  readonly tokenEstimator: ContextTokenEstimatorPort;
}): ContextSummarizationInput | undefined {
  const prefix = input.request.replayPrefix;
  if (prefix === undefined) return undefined;
  const includedIds = new Set(prefix.messageRefs.map((reference) => reference.messageId));
  if (input.base.sourceMessages.some((stored) => !includedIds.has(String(stored.message.id)))) {
    return undefined;
  }
  const replayInput: ContextSummarizationInput = Object.freeze({
    ...input.base,
    cacheEligibility: "CACHE_REUSE_ELIGIBLE",
    replayPrefix: prefix,
    replayPrefixFingerprint: createContextSummaryReplayPrefixFingerprint(prefix),
  });
  const prefixTokens =
    estimateAIMessages(prefix.messages, input.request.model, input.tokenEstimator) +
    prefix.tools.reduce(
      (total, tool) => total + input.tokenEstimator.estimateAIToolSpec(tool, input.request.model),
      0,
    );
  const scopeText = JSON.stringify({
    purpose: "CONTEXT_SUMMARY",
    sourceMessageIds: input.base.sourceMessages.map((stored) => String(stored.message.id)),
    reason: input.request.reason,
    targetTokens: input.base.targetTokens,
  });
  const appendedTokens = input.tokenEstimator.estimateText(
    `${CONTEXT_SUMMARY_PROMPT_VERSION}:${scopeText}`,
    input.request.model,
  );
  const outputTokens = Math.min(
    input.base.targetTokens,
    input.request.model.limits.maxOutputTokens,
  );
  const safetyMargin = Math.max(
    256,
    Math.ceil(input.request.model.limits.contextWindowTokens * 0.02),
  );
  return prefixTokens + appendedTokens + outputTokens + safetyMargin <=
    input.request.model.limits.contextWindowTokens
    ? replayInput
    : undefined;
}

function firstMessageRange(messages: readonly StoredAgentMessage[]): ContextMessageRange {
  const stored = messages[0];
  if (stored === undefined) throw new TypeError("Compaction summary segment cannot be empty.");
  return createContextMessageRange({
    runId: stored.message.runId,
    conversationTurnId: stored.message.conversationTurnId,
    firstMessageId: stored.message.id,
    lastMessageId: stored.message.id,
    firstSequence: stored.sequence,
    lastSequence: stored.sequence,
  });
}

function selectCoverageDeltaMessages(
  conversation: ContextCompactionRequest["conversation"],
  ranges: readonly ContextMessageRange[],
): StoredAgentMessage[] {
  const selected: StoredAgentMessage[] = [];
  const selectedIds = new Set<string>();
  for (const range of ranges) {
    const turn = conversation.turns.find(
      (candidate) =>
        String(candidate.runId) === String(range.runId) &&
        String(candidate.id) === String(range.conversationTurnId),
    );
    if (turn === undefined || String(turn.sessionId) !== String(conversation.sessionId)) {
      throw new TypeError("Compaction source range is outside the Conversation Session.");
    }
    const messages = turn.messages.filter(
      (stored) =>
        stored.message.audience.model &&
        stored.sequence >= range.firstSequence &&
        stored.sequence <= range.lastSequence,
    );
    if (
      messages.length !== range.lastSequence - range.firstSequence + 1 ||
      String(messages[0]?.message.id) !== String(range.firstMessageId) ||
      String(messages.at(-1)?.message.id) !== String(range.lastMessageId)
    ) {
      throw new TypeError("Compaction source range does not match durable message identities.");
    }
    for (const stored of messages) {
      const id = String(stored.message.id);
      if (selectedIds.has(id)) throw new TypeError("Compaction source ranges overlap.");
      selectedIds.add(id);
      selected.push(stored);
    }
  }
  return selected;
}

function structuredCheckpointV2AsV1(checkpoint: StructuredCheckpointV2): StructuredCheckpoint {
  const { version, sourceCoverage, ...semanticFields } = checkpoint;
  if (version !== 2) throw new TypeError("V2 checkpoint version is invalid.");
  return createStructuredCheckpointRecord({
    ...semanticFields,
    version: 1,
    sourceRange: {
      from: sourceCoverage.segments[0]?.firstSequence ?? 1,
      to: sourceCoverage.segments[0]?.lastSequence ?? 1,
    },
  });
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
  conversation?: ContextCompactionRequest["conversation"],
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
  const turnOrder =
    conversation === undefined
      ? undefined
      : new Map(
          conversation.turns.map((turn, index) => [
            JSON.stringify([String(turn.runId), String(turn.id)]),
            index,
          ]),
        );
  groups.sort((left, right) => {
    const leftFirst = left[0]!;
    const rightFirst = right[0]!;
    if (turnOrder === undefined) return leftFirst.sequence - rightFirst.sequence;
    const leftOrder =
      turnOrder.get(
        JSON.stringify([
          String(leftFirst.message.runId),
          String(leftFirst.message.conversationTurnId),
        ]),
      ) ?? -1;
    const rightOrder =
      turnOrder.get(
        JSON.stringify([
          String(rightFirst.message.runId),
          String(rightFirst.message.conversationTurnId),
        ]),
      ) ?? -1;
    return leftOrder === rightOrder
      ? leftFirst.sequence - rightFirst.sequence
      : leftOrder - rightOrder;
  });

  const merged: StoredAgentMessage[][] = [];
  for (const group of groups) {
    const prior = merged.at(-1);
    const priorLast = prior?.at(-1);
    if (
      prior !== undefined &&
      priorLast !== undefined &&
      String(priorLast.message.runId) === String(group[0]!.message.runId) &&
      String(priorLast.message.conversationTurnId) ===
        String(group[0]!.message.conversationTurnId) &&
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
  goal: string,
  sourceRange: ContextMessageRange,
  previous?: StructuredCheckpoint,
): StructuredCheckpoint {
  return createStructuredCheckpointRecord({
    version: 1,
    goal,
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
  readonly checkpointBudget: ContextCheckpointBudget;
  readonly previousCheckpoint?: import("../checkpoint/structured-checkpoint.js").StructuredCheckpoint;
  readonly sourceRange: ContextMessageRange;
  readonly dependencies: ContextCompactionCoordinatorOptions["dependencies"];
}) {
  const checkpoint =
    input.summary.kind === "ACCEPTED"
      ? (() => {
          const sourceRef = createHistorySourceRef({
            runId: input.sourceRange.runId,
            firstSequence: input.sourceRange.firstSequence,
            lastSequence: input.sourceRange.lastSequence,
          });
          const criticalReferences = [...input.summary.result.semantic.criticalReferences];
          if (!criticalReferences.includes(sourceRef)) criticalReferences.push(sourceRef);
          return input.dependencies.enricher.enrich({
            identity: input.request.identity,
            semantic: { ...input.summary.result.semantic, criticalReferences },
            facts: input.facts,
            sourceRange: input.sourceRange,
          });
        })()
      : input.dependencies.deterministicFallback.build({
          goal: input.request.identity.goal,
          sourceRange: input.sourceRange,
          facts: input.facts,
          ...(input.previousCheckpoint === undefined
            ? {}
            : { previousCheckpoint: input.previousCheckpoint }),
        });
  return fitStructuredCheckpointToBudget({
    checkpoint,
    maxTokens: input.checkpointBudget.maxTokens,
    model: input.request.model,
    ...(input.dependencies.summarySourceTokenEstimator === undefined
      ? {}
      : { tokenEstimator: input.dependencies.summarySourceTokenEstimator }),
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

function checkpointRef(record: ContextCheckpointRecordV2 | ContextCheckpointRecordV3) {
  if (record.schemaVersion === 3) {
    return Object.freeze({
      checkpointId: record.checkpointId,
      schemaVersion: 3 as const,
      sourceCoverage: record.coverage,
      degraded: record.degraded,
    });
  }
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
