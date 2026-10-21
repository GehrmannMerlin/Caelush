import { createHash, randomUUID } from "node:crypto";

import type { AIMessage, AIModelSettings } from "@caelush/ai";
import type { EventId, TimestampMs } from "@caelush/protocol";

import type { RunEventNotifierPort } from "../../events/notifier-port.js";
import type { DurableRunEventDraft } from "../../events/durable-run-event-draft.js";
import type { ContextPreflightReport, PreparedModelContext } from "../../loop/types.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { ContextPrepareInput, ContextEnginePort } from "../contracts/context-engine.js";
import type { PreparedPromptSurface } from "../contracts/prepared-agent-context.js";
import {
  PROMPT_SURFACE_ANCHOR_VERSION,
  assertPromptSurfaceEpochWithSnapshots,
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceFingerprint,
  createPromptSurfaceRecord,
  PromptSurfaceIntegrityError,
} from "../surface/prompt-surface.js";
import type {
  PromptSurfaceAnchor,
  PromptSurfaceEpoch,
  PromptSurfaceEpochWithSnapshots,
  PromptSurfaceRecord,
  PromptSurfaceResetReason,
} from "../surface/prompt-surface.js";
import type { PromptSurfaceStorePort } from "../surface/prompt-surface-store.js";
import {
  decidePromptSurfaceCapacity,
  promptSurfaceBaselineTooLarge,
  promptSurfaceReplaySoftBudgetBytes,
} from "../surface/prompt-surface-capacity.js";
import {
  promptSurfaceRolloverOperationId,
  rolloverPromptSurface,
  type PromptSurfaceRolloverOutcome,
} from "../surface/prompt-surface-rollover.js";
import {
  comparePromptSurfaceAnchorOrder,
  latestCompletePromptSurfaceAnchor,
  promptSurfaceAnchorsAreAvailable,
} from "../surface/prompt-surface-anchors.js";
import { renderStableContextHead } from "../surface/prompt-surface-renderer.js";
import { promptSurfaceEpochIdentity } from "../surface/prompt-surface-identity.js";
import {
  applyPromptSurfaceSectionUpdates,
  createPromptSurfaceSectionStates,
  diffPromptSurfaceSections,
  renderPromptSurfaceRecord,
} from "../surface/prompt-surface-v3.js";
import type { PromptSurfaceSectionState } from "../surface/prompt-surface-v3.js";
import {
  createContextCheckpointId,
  type ContextCompactionReason,
  type ContextCheckpointRecordV2,
  type ContextCheckpointRepositoryPort,
  type LegacyContextCheckpointRecordV1,
} from "../compaction/context-compaction-contracts.js";
import { createContextCompactionPlanner } from "../compaction/context-compaction-planner.js";
import { createContextPressureEvaluator } from "../compaction/context-pressure-evaluator.js";
import {
  advanceContextCompactionSchedule,
  initialContextCompactionSchedule,
  type ContextCompactionSchedule,
} from "../compaction/context-compaction-schedule.js";
import type { ContextCompactionCommitPort } from "../ports/context-compaction-commit-port.js";
import {
  createContextCheckpointEnricher,
  type ContextCheckpointEnricher,
} from "../compaction/checkpoint-enricher.js";
import { createContextCompactionRebuilder } from "../compaction/context-compaction-rebuilder.js";
import {
  createDeterministicCheckpointBuilder,
  type DeterministicCheckpointBuilder,
} from "../compaction/deterministic-checkpoint-builder.js";
import type { DeterministicCompactionFactsProvider } from "../compaction/deterministic-compaction-facts.js";
import {
  createContextCompactionCoverage,
  createContextCompactionCoverageForRange,
  type ContextCompactionCoverage,
} from "../compaction/context-compaction-coverage.js";
import {
  createIncrementalCheckpointResolver,
  type IncrementalCheckpointResolver,
  type IncrementalCheckpointState,
} from "../compaction/incremental-checkpoint-resolver.js";
import {
  createContextIncrementalCompactionResolver,
  type ContextIncrementalCompactionResolver,
} from "../compaction/incremental-compaction-resolver.js";
import {
  createContextCheckpointBudgetResolver,
  type ContextCheckpointBudgetResolver,
} from "../compaction/checkpoint-budget.js";
import {
  createContextCompactionGainEvaluator,
  type ContextCompactionGainEvaluator,
} from "../compaction/compaction-gain.js";
import {
  createContextDocumentBuilder,
  type ContextDocumentBuilder,
} from "../document/context-document.js";
import {
  createContextHistoryIndexer,
  type ContextHistoryIndexer,
} from "../history/semantic-history-unit.js";
import type { ContextMaterializer } from "../materializer/context-materializer.js";
import { createContextPlanner, type ContextPlanner } from "../planner/context-planner.js";
import {
  createContextPolicy,
  resolveAdaptiveContextBudget,
  type ContextPlan,
  type ContextPolicyOptions,
  type ContextWorkingSetPolicy,
} from "../policy/context-policy.js";
import {
  createContextReceiptBuilder,
  type ContextReceiptBuilder,
  type ContextReceiptBuilderResult,
} from "../receipts/context-receipt-builder.js";
import type { ContextUsageStorePort } from "../receipts/context-usage.js";
import { collectContextSources } from "../source/context-source-registry.js";
import type {
  ContextSourceCollectionResult,
  ContextSourceRegistry,
} from "../source/context-source.js";
import type { ContextSourceResult } from "../source/context-source.js";
import type {
  ContextAuthorityProviderPort,
  ContextRehydratorPort,
} from "../rehydration/context-authority-contracts.js";
import type { ContextAuthoritySnapshot } from "../rehydration/context-authority-contracts.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";
import type { ContextCompactionReceipt } from "../receipts/context-build-receipt.js";
import { createContextRehydrator } from "../rehydration/context-rehydrator.js";
import {
  createContextRequestOverheadEstimator,
  type ContextRequestOverheadEstimatorPort,
} from "../token/request-overhead-estimator.js";
import {
  createUtf8HeuristicTokenEstimator,
  type ContextTokenEstimatorPort,
} from "../token/context-token-estimator.js";
import { AGENT_CONTEXT_SOURCE_IDS } from "../source/source-ids.js";
import type { ContextCheckpointRef } from "../compaction/context-compaction-contracts.js";
import { ContextExhaustedError } from "../planner/context-planning-errors.js";
import type { AgentExecutionIdentity, ContextRequestBudget } from "../../loop/types.js";
import { createContextItemId } from "../item/context-item.js";
import { createSourceResult, estimateContextTokens } from "../source/generic-provider-helpers.js";
import { createContextCompactionCoordinator } from "../compaction/context-compaction-coordinator.js";
import type {
  ContextCompactionDependencies,
  ContextCompactionRebuildInputWithIdentity,
  ContextCompactionRebuildResult,
  ContextSummaryReplayPrefix,
  ContextSummarizerPort,
} from "../compaction/context-compaction-contracts.js";
import { createContextSummaryReplayPrefixFingerprint } from "../compaction/context-summary.js";
import {
  createContextRecoveryPlanner,
  withRecoveryTailPolicy,
  type ContextRecoveryPlanner,
  type ContextRecoveryPlan,
} from "../compaction/context-recovery-planner.js";
import {
  applyContextRecoveryToPlan,
  contextSourceCriticality,
} from "../compaction/context-recovery-application.js";
import type { SemanticSummaryValidator } from "../compaction/semantic-summary-validator.js";
import { createSemanticSummaryValidator } from "../compaction/semantic-summary-validator.js";

export interface ContextCompactionEventFactory {
  completed(input: {
    readonly identity: AgentExecutionIdentity;
    readonly checkpoint: import("../compaction/context-compaction-contracts.js").ContextCheckpointCreateInputV2;
    readonly reason: ContextCompactionReason;
    readonly tokensBefore: number;
    readonly tokensAfter: number;
    readonly degraded: boolean;
    readonly eventId: EventId;
    readonly timestamp: TimestampMs;
  }): DurableRunEventDraft;
}

export function createContextCompactionEventFactory(): ContextCompactionEventFactory {
  return Object.freeze({
    completed(
      input: Parameters<ContextCompactionEventFactory["completed"]>[0],
    ): DurableRunEventDraft {
      return {
        eventId: input.eventId,
        schemaVersion: 1,
        runId: input.identity.runId,
        sessionId: input.identity.sessionId,
        timestamp: input.timestamp,
        visibility: "SYSTEM" as const,
        durability: { kind: "DURABLE" as const, version: 1 as const },
        type: "context.compaction.completed" as const,
        payload: {
          checkpointId: input.checkpoint.checkpointId,
          reason: input.reason,
          sourceSequenceFrom: input.checkpoint.sourceRange.firstSequence,
          sourceSequenceTo: input.checkpoint.sourceRange.lastSequence,
          tokensBefore: input.tokensBefore,
          tokensAfter: input.tokensAfter,
          degraded: input.degraded,
        },
      };
    },
  });
}

export interface V2ContextEngineOptions {
  /** The daemon-owned durable Prompt Surface boundary for model-input projection. */
  readonly promptSurfaceStore: PromptSurfaceStorePort;
  /** Provider-neutral settings used only to freeze the model-input cache identity. */
  readonly modelSettings?: AIModelSettings;
  /** Persisted Run policy. Missing or legacy snapshots retain historical full-output behavior. */
  readonly requestBudget?: ContextRequestBudget;
  /** V2 selection thresholds that leave request output reserves unchanged. */
  readonly workingSet?: ContextWorkingSetPolicy;
  readonly promptSurfaceEpochIdFactory?: { create(): string };
  readonly sourceRegistry: ContextSourceRegistry;
  readonly checkpointRepository: ContextCheckpointRepositoryPort;
  readonly authorityProvider: ContextAuthorityProviderPort;
  readonly usageStore: ContextUsageStorePort;
  readonly compactionCommit?: ContextCompactionCommitPort;
  readonly notifier?: RunEventNotifierPort;
  readonly compactionEvents?: ContextCompactionEventFactory;
  readonly checkpointIdFactory?: { create(): string };
  readonly eventIdFactory?: { create(): EventId };
  readonly clock: { now(): TimestampMs };
  readonly policy?: ContextPolicyOptions;
  readonly forcedObservationPolicy?: Pick<
    ContextPolicyOptions,
    | "maxSingleObservationTokensCap"
    | "maxSingleObservationRatio"
    | "maxObservationBatchTokensCap"
    | "maxObservationBatchRatio"
  >;
  readonly tokenEstimator?: ContextTokenEstimatorPort;
  readonly requestOverheadEstimator?: ContextRequestOverheadEstimatorPort;
  readonly historyIndexer?: ContextHistoryIndexer;
  readonly planner?: ContextPlanner;
  readonly compactionPlanner?: ReturnType<typeof createContextCompactionPlanner>;
  readonly summarizer?: ContextSummarizerPort;
  readonly summaryValidator?: SemanticSummaryValidator;
  readonly deterministicFactsProvider?: DeterministicCompactionFactsProvider;
  readonly checkpointBuilder?: DeterministicCheckpointBuilder;
  readonly checkpointEnricher?: ContextCheckpointEnricher;
  readonly incrementalCheckpointResolver?: IncrementalCheckpointResolver;
  readonly incrementalCompactionResolver?: ContextIncrementalCompactionResolver;
  readonly checkpointBudgetResolver?: ContextCheckpointBudgetResolver;
  readonly compactionGainEvaluator?: ContextCompactionGainEvaluator;
  readonly recoveryPlanner?: ContextRecoveryPlanner;
  readonly rehydrator?: ContextRehydratorPort;
  readonly documentBuilder?: ContextDocumentBuilder;
  readonly materializer: ContextMaterializer;
  readonly receiptBuilder?: ContextReceiptBuilder;
}

/**
 * The production-capable V2 Context orchestration behind the frozen Agent seam.
 *
 * This class coordinates pure/context-owned components, but it does not own any
 * infrastructure. Storage, live notification, source implementations, clock and
 * AI summarization are all injected through Agent-owned ports.
 */
export function createV2ContextEngine(options: V2ContextEngineOptions): ContextEnginePort {
  const tokenEstimator = options.tokenEstimator ?? createUtf8HeuristicTokenEstimator();
  const overheadEstimator =
    options.requestOverheadEstimator ?? createContextRequestOverheadEstimator({ tokenEstimator });
  const historyIndexer = options.historyIndexer ?? createContextHistoryIndexer();
  const planner = options.planner ?? createContextPlanner();
  const compactionPlanner = options.compactionPlanner ?? createContextCompactionPlanner();
  const recoveryPlanner = options.recoveryPlanner ?? createContextRecoveryPlanner();
  const pressureEvaluator = createContextPressureEvaluator();
  /**
   * Per-Run compaction pacing.
   *
   * It is bounded and disposable: a missing entry means "start armed", which can cost at most one
   * extra attempt and never changes what a compaction is allowed to do. Every attempt still passes
   * through the planner, the semantic validator, the gain gate and the compaction transaction.
   */
  const compactionSchedules = new Map<string, ContextCompactionSchedule>();
  const scheduleFor = (runId: string): ContextCompactionSchedule => {
    const existing = compactionSchedules.get(runId);
    if (existing !== undefined) return existing;
    if (compactionSchedules.size >= 256) {
      const oldest = compactionSchedules.keys().next();
      if (!oldest.done) compactionSchedules.delete(oldest.value);
    }
    return initialContextCompactionSchedule();
  };
  const rehydrator = options.rehydrator ?? createContextRehydrator();
  const documentBuilder = options.documentBuilder ?? createContextDocumentBuilder();
  const summarizer: ContextSummarizerPort =
    options.summarizer ??
    ({
      async summarize() {
        throw new ContextExhaustedError();
      },
    } satisfies ContextSummarizerPort);
  const summaryValidator = options.summaryValidator ?? createSemanticSummaryValidator();
  const checkpointBuilder = options.checkpointBuilder ?? createDeterministicCheckpointBuilder();
  const checkpointEnricher = options.checkpointEnricher ?? createContextCheckpointEnricher();
  const incrementalCheckpointResolver =
    options.incrementalCheckpointResolver ??
    createIncrementalCheckpointResolver({ checkpointRepository: options.checkpointRepository });
  const incrementalCompactionResolver =
    options.incrementalCompactionResolver ?? createContextIncrementalCompactionResolver();
  const checkpointBudgetResolver =
    options.checkpointBudgetResolver ?? createContextCheckpointBudgetResolver();
  const compactionGainEvaluator =
    options.compactionGainEvaluator ?? createContextCompactionGainEvaluator();
  const receiptBuilder =
    options.receiptBuilder ??
    createContextReceiptBuilder({ now: options.clock.now, tokenEstimator });

  return Object.freeze({
    async prepare(input: ContextPrepareInput): Promise<PreparedModelContext> {
      throwIfAborted(input.signal);
      const requestOverhead = overheadEstimator.estimate({
        model: input.model,
        tools: input.tools,
      });
      const adaptiveBudget =
        options.requestBudget?.version === "ADAPTIVE_V1"
          ? resolveAdaptiveContextBudget({
              contextWindowTokens: input.model.limits.contextWindowTokens,
              maxOutputTokens: input.model.limits.maxOutputTokens,
              ...(options.modelSettings?.maxOutputTokens === undefined
                ? {}
                : { configuredOutputCeiling: options.modelSettings.maxOutputTokens }),
              requestOverheadTokens: requestOverhead.totalTokens,
            })
          : undefined;
      if (
        adaptiveBudget !== undefined &&
        (options.requestBudget?.outputReserveTokens !== adaptiveBudget.outputReserveTokens ||
          options.requestBudget.safetyReserveTokens !== adaptiveBudget.safetyReserveTokens)
      ) {
        throw new RangeError(
          "Persisted adaptive context budget does not match the resolved model limits and settings.",
        );
      }
      const configuredPolicyOptions =
        input.mode === "FORCED_RECOVERY" && options.forcedObservationPolicy !== undefined
          ? { ...options.policy, ...options.forcedObservationPolicy }
          : options.policy;
      const policyOptions = {
        ...configuredPolicyOptions,
        ...(adaptiveBudget === undefined
          ? {}
          : {
              outputReserveTokens: adaptiveBudget.outputReserveTokens,
              safetyReserveTokens: adaptiveBudget.safetyReserveTokens,
            }),
        ...(options.workingSet === undefined ? {} : { workingSet: options.workingSet }),
      };
      const policy = createContextPolicy({
        model: input.model,
        tools: input.tools,
        requestOverhead,
        ...(policyOptions === undefined ? {} : { options: policyOptions }),
      });
      if (
        adaptiveBudget !== undefined &&
        policy.effectiveInputLimitTokens !== adaptiveBudget.effectiveInputLimitTokens
      ) {
        throw new RangeError("Adaptive context policy produced an inconsistent input limit.");
      }
      const requestBudget: ContextRequestBudget = Object.freeze({
        ...(options.requestBudget ?? {
          version: "LEGACY_FULL_OUTPUT_V1" as const,
          outputReserveTokens: policy.outputReserveTokens,
          safetyReserveTokens: policy.safetyReserveTokens,
        }),
      });
      throwIfAborted(input.signal);

      const sourceInput = {
        ...input,
        policy,
      };
      const collected = await collectContextSources(options.sourceRegistry, sourceInput);
      const history = historyIndexer.index({
        conversation: input.conversation,
        model: input.model,
      });
      const latestState = await incrementalCheckpointResolver.resolve({
        runId: input.identity.runId,
        history,
      });
      throwIfAborted(input.signal);
      const latestCheckpoint = checkpointFromIncrementalState(latestState);
      const coverage: ContextCompactionCoverage = createContextCompactionCoverage({
        history,
        ...(latestCheckpoint === undefined ? {} : { latestCheckpoint }),
      });
      const sourceResults = removeCoveredConversationMessages(
        collected,
        coverage.coveredMessageIds,
      );
      let activeCheckpoint = latestCheckpoint;
      let activeCoverage = coverage;
      let activeSources = sourceResults;
      let compactionReceipt: ContextCompactionReceipt | undefined;
      let compactionCount = 0;
      const sourceCriticality = contextSourceCriticality(options.sourceRegistry.list());
      const atomicGroupByItemId = contextHistoryAtomicGroups(history);
      const authorities = await options.authorityProvider.snapshot({
        identity: input.identity,
        signal: input.signal,
      });
      throwIfAborted(input.signal);
      const initialProjection = await buildPreparedProjectionWithoutCompaction({
        contextInput: input,
        policy,
        sourceResults,
        activeCoverage: coverage,
        ...(latestCheckpoint?.checkpointId === undefined
          ? {}
          : { promptSurfaceCheckpointId: String(latestCheckpoint.checkpointId) }),
        ...(latestCheckpoint === undefined
          ? {}
          : {
              activeCheckpoint:
                latestCheckpoint.schemaVersion === 2
                  ? activeCheckpointProjection(latestCheckpoint)
                  : { structuredCheckpoint: latestCheckpoint.structuredCheckpoint },
            }),
        authorities,
        planner,
        sourcePriorities: sourcePriorityMap(options.sourceRegistry),
        rehydrator,
        documentBuilder,
        materializer: options.materializer,
        receiptBuilder,
        promptSurfaceStore: options.promptSurfaceStore,
        ...(options.modelSettings === undefined ? {} : { modelSettings: options.modelSettings }),
        ...(options.promptSurfaceEpochIdFactory === undefined
          ? {}
          : { promptSurfaceEpochIdFactory: options.promptSurfaceEpochIdFactory }),
        tokenEstimator,
        clock: options.clock,
        persistPromptSurface: false,
        compactionCount: 0,
      });
      const estimatedInputTokens = initialProjection.audit.report.estimatedInputTokens;
      // The preflight's exact projection, by content. Comparing it with the committed projection is
      // what turns "the estimate and the request disagreed" from an invisible property of this
      // function into a value a caller, a test and a support report can read.
      const preflightFingerprint = projectionContentFingerprint(
        initialProjection.materializedMessages,
      );
      const schedulePressureRatio =
        estimatedInputTokens /
        (options.workingSet?.targetTokens ?? policy.effectiveInputLimitTokens);
      const emergency = estimatedInputTokens >= policy.emergencyCompactionTokens;
      const schedule = advanceContextCompactionSchedule(scheduleFor(String(input.identity.runId)), {
        pressureRatio: schedulePressureRatio,
        emergency,
        forced: input.mode === "FORCED_RECOVERY",
        compacted: false,
      });
      compactionSchedules.set(String(input.identity.runId), schedule);
      const pressure = pressureEvaluator.evaluate({
        estimatedInputTokens,
        selectedPlanningTokens: initialProjection.plan.budget.selectedTokens,
        mandatoryTokens: initialProjection.plan.budget.mandatoryTokens,
        historySelectionPressure: initialProjection.plan.historySelectionPressure,
        effectiveInputLimitTokens: policy.effectiveInputLimitTokens,
        proactiveCompactionTokens: policy.proactiveCompactionTokens,
        emergencyCompactionTokens: policy.emergencyCompactionTokens,
        targetRecentTailTokens: policy.targetRecentTailTokens,
        ...(policy.targetPostCompactionTokens === undefined
          ? {}
          : { targetPostCompactionTokens: policy.targetPostCompactionTokens }),
        minRecentTailTokens: policy.minRecentTailTokens,
        mode: input.mode,
        hasCompressibleHistory: activeCoverage.history.units.some(
          (unit) => unit.status === "CLOSED" && unit.compactionEligible,
        ),
        proactive: {
          enabled: policy.proactiveCompaction.enabled,
          armed: schedule.armed,
          cooldownTurnsRemaining: schedule.cooldownTurnsRemaining,
          emergency,
        },
      });
      const recoveryPlan = recoveryPlanner.plan({
        mode: input.mode,
        pressure,
        policy,
        hasCompressibleHistory: activeCoverage.history.units.some(
          (unit) => unit.status === "CLOSED" && unit.compactionEligible,
        ),
      });
      const recoveryStages =
        input.mode === "FORCED_RECOVERY"
          ? recoveryPlan.actions.filter((action) => action !== "EXHAUSTED")
          : [];
      if (recoveryPlan.actions.includes("COMPACT_HISTORY")) {
        // Recorded when the attempt is made, not when it succeeds: a failed or gainless attempt is
        // exactly the case that must not be retried next turn with the same input and strategy.
        compactionSchedules.set(
          String(input.identity.runId),
          advanceContextCompactionSchedule(
            schedule,
            {
              pressureRatio: schedulePressureRatio,
              emergency,
              forced: input.mode === "FORCED_RECOVERY",
              compacted: true,
            },
            {
              rearmRatio: policy.proactiveCompaction.rearmRatio,
              cooldownTurns: policy.proactiveCompaction.cooldownTurns,
            },
          ),
        );
        const replayProjection = await buildPreparedProjectionWithoutCompaction({
          contextInput: input,
          policy: withRecoveryTailPolicy(policy, recoveryPlan),
          sourceResults: activeSources,
          activeCoverage,
          ...(activeCheckpoint?.checkpointId === undefined
            ? {}
            : { promptSurfaceCheckpointId: String(activeCheckpoint.checkpointId) }),
          ...(activeCheckpoint === undefined || activeCheckpoint.schemaVersion !== 2
            ? {}
            : { activeCheckpoint: activeCheckpointProjection(activeCheckpoint) }),
          authorities,
          planner,
          sourcePriorities: sourcePriorityMap(options.sourceRegistry),
          rehydrator,
          documentBuilder,
          materializer: options.materializer,
          receiptBuilder,
          promptSurfaceStore: options.promptSurfaceStore,
          ...(options.modelSettings === undefined ? {} : { modelSettings: options.modelSettings }),
          ...(options.promptSurfaceEpochIdFactory === undefined
            ? {}
            : { promptSurfaceEpochIdFactory: options.promptSurfaceEpochIdFactory }),
          tokenEstimator,
          clock: options.clock,
          replayOnlyPromptSurface: true,
          recoveryPlan,
          sourceCriticality,
          atomicGroupByItemId,
          compactionCount: 0,
        });
        const beforeCompactionProjection =
          input.mode === "FORCED_RECOVERY"
            ? await buildPreparedProjectionWithoutCompaction({
                contextInput: input,
                policy: withRecoveryTailPolicy(policy, recoveryPlan),
                sourceResults: activeSources,
                activeCoverage,
                ...(activeCheckpoint?.checkpointId === undefined
                  ? {}
                  : { promptSurfaceCheckpointId: String(activeCheckpoint.checkpointId) }),
                ...(activeCheckpoint === undefined
                  ? {}
                  : {
                      activeCheckpoint:
                        activeCheckpoint.schemaVersion === 2
                          ? activeCheckpointProjection(activeCheckpoint)
                          : { structuredCheckpoint: activeCheckpoint.structuredCheckpoint },
                    }),
                authorities,
                planner,
                sourcePriorities: sourcePriorityMap(options.sourceRegistry),
                rehydrator,
                documentBuilder,
                materializer: options.materializer,
                receiptBuilder,
                promptSurfaceStore: options.promptSurfaceStore,
                ...(options.modelSettings === undefined
                  ? {}
                  : { modelSettings: options.modelSettings }),
                ...(options.promptSurfaceEpochIdFactory === undefined
                  ? {}
                  : { promptSurfaceEpochIdFactory: options.promptSurfaceEpochIdFactory }),
                tokenEstimator,
                clock: options.clock,
                persistPromptSurface: false,
                recoveryPlan,
                sourceCriticality,
                atomicGroupByItemId,
                compactionCount: 0,
              })
            : initialProjection;
        const replayProjectionIsComplete = promptProjectionPreservesUncoveredModelMessages({
          conversationMessages: input.conversation.turns.flatMap((turn) => turn.messages),
          selectedMessages: replayProjection.selectedMessages,
          coveredMessageIds: activeCoverage.coveredMessageIds,
        });
        const replayPrefix =
          replayProjection.promptSurface.replayEligible && replayProjectionIsComplete
            ? createContextSummaryReplayPrefix({
                model: input.model,
                tools: input.tools,
                promptSurface: replayProjection.promptSurface,
                messages: replayProjection.materializedMessages,
              })
            : undefined;
        const reason: ContextCompactionReason =
          pressure.trigger === "FORCED_PROVIDER_OVERFLOW"
            ? "FORCED_PROVIDER_OVERFLOW"
            : pressure.trigger === "SELECTION_PRESSURE"
              ? "SELECTION_PRESSURE"
              : "PROACTIVE_PRESSURE";
        const composition = createCompactionComposition({
          options,
          input,
          history,
          collected,
          planner,
          rehydrator,
          documentBuilder,
          receiptBuilder,
          compactionPlanner,
          incrementalCompactionResolver,
          checkpointBudgetResolver,
          compactionGainEvaluator,
          summarizer,
          summaryValidator,
          checkpointBuilder,
          checkpointEnricher,
          latestState,
          recoveryPlan,
          sourceCriticality,
          atomicGroupByItemId,
        });
        const coordinator = createContextCompactionCoordinator({
          dependencies: composition.dependencies,
          latest: latestState,
          createEvents: ({ request, checkpoint, degraded }) =>
            options.compactionEvents === undefined || options.eventIdFactory === undefined
              ? []
              : [
                  options.compactionEvents.completed({
                    identity: request.identity,
                    checkpoint,
                    reason: request.reason,
                    tokensBefore: request.estimatedInputTokensBefore,
                    tokensAfter: checkpoint.tokensAfter,
                    degraded,
                    eventId: options.eventIdFactory.create(),
                    timestamp: options.clock.now(),
                  }),
                ],
          notifyCommitted: (events) => {
            if (events.length > 0) options.notifier?.notifyCommitted(events);
          },
          tentativeRebuild: composition.tentativeRebuild,
        });
        // An elective compaction that cannot run must not fail a turn whose input still fits. The
        // original context is legal; replacing it with a failure would turn "summary unavailable"
        // into "the Run cannot continue", which is exactly the outcome this pacing exists to avoid.
        const elective =
          input.mode !== "FORCED_RECOVERY" &&
          beforeCompactionProjection.audit.report.estimatedInputTokens <=
            policy.effectiveInputLimitTokens;
        let outcome: Awaited<ReturnType<typeof coordinator.compact>> | undefined;
        try {
          outcome = await coordinator.compact({
            identity: input.identity,
            conversation: input.conversation,
            history: activeCoverage.history,
            policy: withRecoveryTailPolicy(policy, recoveryPlan),
            model: input.model,
            ...(replayPrefix === undefined
              ? {}
              : {
                  replayPrefix,
                  replayPrefixFingerprint:
                    createContextSummaryReplayPrefixFingerprint(replayPrefix),
                }),
            reason,
            estimatedInputTokensBefore:
              beforeCompactionProjection.audit.report.estimatedInputTokens,
            signal: input.signal,
          });
        } catch (error) {
          throwIfAborted(input.signal);
          if (!elective) throw error;
          // Bounded, silent fallback: the uncompacted projection is what this turn already had.
          outcome = undefined;
        }
        if (outcome?.kind === "COMPACTED") {
          activeCheckpoint = outcome.checkpoint;
          activeCoverage = createContextCompactionCoverage({
            history,
            latestCheckpoint: outcome.checkpoint,
          });
          activeSources = withActiveCheckpoint(
            removeCoveredConversationMessages(collected, activeCoverage.coveredMessageIds),
            outcome.checkpoint,
          );
          compactionCount = 1;
          compactionReceipt = outcome.receipt;
        }
      }
      const finalPolicy = withRecoveryTailPolicy(policy, recoveryPlan);
      const finalAuthorities =
        compactionCount === 0
          ? authorities
          : await options.authorityProvider.snapshot({
              identity: input.identity,
              signal: input.signal,
            });
      if (compactionCount > 0) throwIfAborted(input.signal);
      const finalProjection = await buildPreparedProjectionWithoutCompaction({
        contextInput: input,
        policy: finalPolicy,
        sourceResults: activeSources,
        activeCoverage,
        ...(activeCheckpoint?.checkpointId === undefined
          ? {}
          : { promptSurfaceCheckpointId: String(activeCheckpoint.checkpointId) }),
        ...(activeCheckpoint === undefined
          ? {}
          : {
              activeCheckpoint:
                activeCheckpoint.schemaVersion === 2
                  ? activeCheckpointProjection(activeCheckpoint)
                  : { structuredCheckpoint: activeCheckpoint.structuredCheckpoint },
            }),
        authorities: finalAuthorities,
        planner,
        sourcePriorities: sourcePriorityMap(options.sourceRegistry),
        rehydrator,
        documentBuilder,
        materializer: options.materializer,
        receiptBuilder,
        promptSurfaceStore: options.promptSurfaceStore,
        ...(options.modelSettings === undefined ? {} : { modelSettings: options.modelSettings }),
        ...(options.promptSurfaceEpochIdFactory === undefined
          ? {}
          : { promptSurfaceEpochIdFactory: options.promptSurfaceEpochIdFactory }),
        tokenEstimator,
        clock: options.clock,
        recoveryPlan,
        sourceCriticality,
        atomicGroupByItemId,
        ...(compactionReceipt === undefined ? {} : { compactionReceipt }),
        compactionCount,
        ...(compactionCount === 0 ? {} : { lastCompactionAt: options.clock.now() }),
      });
      if (
        finalProjection.audit.report.estimatedInputTokens > finalPolicy.effectiveInputLimitTokens
      ) {
        // The committed projection is the one that would be sent. A preflight estimate that no
        // longer describes it must never authorise the request: fail closed and let the existing
        // bounded recovery chain decide whether the Run can continue.
        throw new ContextExhaustedError();
      }
      const sentFingerprint = projectionContentFingerprint(finalProjection.materializedMessages);
      const preflight: ContextPreflightReport = Object.freeze({
        estimatedInputTokens,
        // REPLAY_TOKENS: what re-sending the Surface records costs on its own, before the stable
        // head and the conversation. It is the number the replay soft budget is about.
        replayTokens: initialProjection.promptSurface.receipt.snapshotTokens,
        projectionFingerprint: preflightFingerprint,
        sentFingerprint,
        compacted: compactionCount > 0,
        ...(compactionCount > 0
          ? {}
          : { matchesSentProjection: preflightFingerprint === sentFingerprint }),
      });
      // The preflight is added to the *final* report, never to the projection that produced it: the
      // report describes the request that will be sent, and its preflight field says what the
      // compaction decision was made from.
      const finalReport = Object.freeze({ ...finalProjection.audit.report, preflight });
      await options.usageStore.upsert(
        recoveryStages.length === 0
          ? finalProjection.audit.usage
          : { ...finalProjection.audit.usage, lastRecoveryStages: recoveryStages },
      );
      throwIfAborted(input.signal);
      return Object.freeze({
        messages: finalProjection.materializedMessages,
        requestBudget,
        selectedMessageIds: Object.freeze(
          finalProjection.selectedMessages.map(({ message }) => String(message.id)),
        ),
        selectedAssistantReplaySources: Object.freeze(
          finalProjection.selectedMessages.flatMap(({ message }) => {
            if (message.type !== "ASSISTANT") return [];
            const model = message.model.kind === "MODEL_TURN" ? message.model.model : undefined;
            const providerId = model?.provider ?? message.providerState?.providerId;
            return [
              Object.freeze({
                messageId: String(message.id),
                runId: String(message.runId),
                ...(message.model.kind === "MODEL_TURN" ? { callId: message.model.callId } : {}),
                ...(providerId === undefined ? {} : { providerId }),
                ...(model === undefined ? {} : { model: model.model }),
                ...(message.providerState === undefined ? {} : { api: message.providerState.api }),
                hasProviderState: message.providerState !== undefined,
              }),
            ];
          }),
        ),
        selectedContextSources: Object.freeze(
          finalProjection.audit.receipt.sources.map((source) =>
            Object.freeze({
              providerId: String(source.providerId),
              providerVersion: source.providerVersion,
              selectedItemIds: Object.freeze(source.selectedItemIds.map(String)),
            }),
          ),
        ),
        report: finalReport,
        observationPolicy: finalPolicy.observationPolicy,
        ...checkpointReference(activeCheckpoint),
        contextFingerprint: finalProjection.audit.contextFingerprint,
        contextArtifactId:
          activeCheckpoint?.schemaVersion === 2
            ? String(activeCheckpoint.checkpointId)
            : finalProjection.audit.contextFingerprint,
      });
    },
  });
}

interface ActiveCheckpointProjection {
  readonly checkpointId?: import("../compaction/context-compaction-contracts.js").ContextCheckpointId;
  readonly structuredCheckpoint: StructuredCheckpoint;
  readonly sourceRange?: import("../compaction/context-compaction-contracts.js").ContextMessageRange;
  readonly degraded?: boolean;
}

interface ContextBuildProjection {
  readonly plan: ContextPlan;
  readonly selectedMessages: readonly StoredAgentMessage[];
  readonly materializedMessages: readonly AIMessage[];
  readonly audit: ContextReceiptBuilderResult;
  readonly promptSurface: PromptSurfacePreparationResult;
}

async function buildPreparedProjectionWithoutCompaction(input: {
  readonly contextInput: ContextPrepareInput;
  readonly policy: import("../policy/context-policy.js").ContextPolicy;
  readonly sourceResults: readonly ContextSourceResult[];
  readonly activeCoverage: ContextCompactionCoverage;
  readonly activeCheckpoint?: ActiveCheckpointProjection;
  readonly promptSurfaceCheckpointId?: string;
  readonly authorities: ContextAuthoritySnapshot;
  readonly planner: ContextPlanner;
  readonly sourcePriorities: Readonly<Record<string, number>>;
  readonly rehydrator: ContextRehydratorPort;
  readonly documentBuilder: ContextDocumentBuilder;
  readonly materializer: ContextMaterializer;
  readonly receiptBuilder: ContextReceiptBuilder;
  readonly promptSurfaceStore: PromptSurfaceStorePort;
  readonly modelSettings?: AIModelSettings;
  readonly promptSurfaceEpochIdFactory?: { create(): string };
  readonly tokenEstimator: ContextTokenEstimatorPort;
  readonly clock: { now(): TimestampMs };
  readonly persistPromptSurface?: boolean;
  readonly replayOnlyPromptSurface?: boolean;
  readonly recoveryPlan?: ContextRecoveryPlan;
  readonly sourceCriticality?: Readonly<Record<string, "REQUIRED" | "OPTIONAL">>;
  readonly atomicGroupByItemId?: Readonly<Record<string, string>>;
  readonly compactionReceipt?: ContextCompactionReceipt;
  readonly compactionCount: number;
  readonly lastCompactionAt?: TimestampMs;
}): Promise<ContextBuildProjection> {
  throwIfAborted(input.contextInput.signal);
  const planned = input.planner.plan({
    items: input.sourceResults.flatMap((result) => result.items),
    policy: input.policy,
    history: input.activeCoverage.history,
    currentTurnId: input.contextInput.conversation.currentTurnId,
    sourcePriorities: input.sourcePriorities,
  });
  const plan =
    input.recoveryPlan === undefined || input.sourceCriticality === undefined
      ? planned
      : applyContextRecoveryToPlan({
          plan: planned,
          items: input.sourceResults.flatMap((result) => result.items),
          actions: input.recoveryPlan.actions.filter((action) => action !== "EXHAUSTED"),
          sourceCriticality: input.sourceCriticality,
          ...(input.atomicGroupByItemId === undefined
            ? {}
            : { atomicGroupByItemId: input.atomicGroupByItemId }),
        });
  const rehydrated = await input.rehydrator.rehydrate({
    ...(input.activeCheckpoint === undefined
      ? {}
      : { checkpoint: input.activeCheckpoint.structuredCheckpoint }),
    authorities: input.authorities,
  });
  throwIfAborted(input.contextInput.signal);
  const document = input.documentBuilder.build({ plan, rehydrated });
  const selectedMessages = selectedConversationMessages(plan);
  const checkpoint =
    input.activeCheckpoint?.checkpointId === undefined
      ? undefined
      : checkpointRef(input.activeCheckpoint);
  const promptSurfaceCheckpointId =
    input.promptSurfaceCheckpointId ?? input.activeCheckpoint?.checkpointId;
  const promptSurface = await preparePromptSurface({
    store: input.promptSurfaceStore,
    contextInput: input.contextInput,
    document,
    allowSectionClear: input.sourceResults.every((result) =>
      result.diagnostics.every((diagnostic) => diagnostic.severity === "INFO"),
    ),
    conversationMessages: selectedMessages,
    ...(promptSurfaceCheckpointId === undefined
      ? {}
      : { checkpointId: String(promptSurfaceCheckpointId) }),
    tools: input.contextInput.tools,
    ...(input.modelSettings === undefined ? {} : { modelSettings: input.modelSettings }),
    clock: input.clock,
    ...(input.promptSurfaceEpochIdFactory === undefined
      ? {}
      : { epochIdFactory: input.promptSurfaceEpochIdFactory }),
    tokenEstimator: input.tokenEstimator,
    compactionCommitted: input.compactionCount > 0,
    persist: input.persistPromptSurface !== false,
    replayOnly: input.replayOnlyPromptSurface === true,
    replaySoftBudgetBytes: promptSurfaceReplaySoftBudgetBytes({
      ...(input.policy.workingSet === undefined
        ? {}
        : { workingSetTargetTokens: input.policy.workingSet.targetTokens }),
      effectiveInputLimitTokens: input.policy.effectiveInputLimitTokens,
    }),
  });
  const provisional = input.receiptBuilder.build({
    identity: input.contextInput.identity,
    turn: input.contextInput.turn,
    input: input.contextInput.input,
    mode: input.contextInput.mode,
    model: input.contextInput.model,
    tools: input.contextInput.tools,
    policy: input.policy,
    sourceResults: input.sourceResults,
    plan,
    conversationMessages: selectedMessages,
    materializedMessages: [],
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(input.compactionReceipt === undefined ? {} : { compaction: input.compactionReceipt }),
    compactionCount: input.compactionCount,
    ...(input.lastCompactionAt === undefined ? {} : { lastCompactionAt: input.lastCompactionAt }),
    promptSurface: promptSurface.receipt,
  });
  const materializedMessages = await input.materializer.materialize({
    prepared: {
      conversationMessages: selectedMessages,
      document,
      plan,
      receipt: provisional.receipt,
      observationPolicy: input.policy.observationPolicy,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      contextFingerprint: provisional.contextFingerprint,
      promptSurface,
    },
    model: input.contextInput.model,
    signal: input.contextInput.signal,
    reprojectOpenToolObservations: input.contextInput.mode === "FORCED_RECOVERY",
  });
  throwIfAborted(input.contextInput.signal);
  const audit = input.receiptBuilder.build({
    identity: input.contextInput.identity,
    turn: input.contextInput.turn,
    input: input.contextInput.input,
    mode: input.contextInput.mode,
    model: input.contextInput.model,
    tools: input.contextInput.tools,
    policy: input.policy,
    sourceResults: input.sourceResults,
    plan,
    conversationMessages: selectedMessages,
    materializedMessages,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(input.compactionReceipt === undefined ? {} : { compaction: input.compactionReceipt }),
    compactionCount: input.compactionCount,
    ...(input.lastCompactionAt === undefined ? {} : { lastCompactionAt: input.lastCompactionAt }),
    promptSurface: promptSurface.receipt,
  });
  return Object.freeze({ plan, selectedMessages, materializedMessages, audit, promptSurface });
}

interface CompactionCompositionInput {
  readonly options: V2ContextEngineOptions;
  readonly input: ContextPrepareInput;
  readonly history: ContextCompactionCoverage["history"];
  readonly collected: readonly ContextSourceCollectionResult[];
  readonly planner: ContextPlanner;
  readonly rehydrator: ContextRehydratorPort;
  readonly documentBuilder: ContextDocumentBuilder;
  readonly receiptBuilder: ContextReceiptBuilder;
  readonly compactionPlanner: ReturnType<typeof createContextCompactionPlanner>;
  readonly incrementalCompactionResolver: ContextIncrementalCompactionResolver;
  readonly checkpointBudgetResolver: ContextCheckpointBudgetResolver;
  readonly compactionGainEvaluator: ContextCompactionGainEvaluator;
  readonly summarizer: ContextSummarizerPort;
  readonly summaryValidator: SemanticSummaryValidator;
  readonly checkpointBuilder: DeterministicCheckpointBuilder;
  readonly checkpointEnricher: ContextCheckpointEnricher;
  readonly latestState: IncrementalCheckpointState;
  readonly recoveryPlan: ContextRecoveryPlan;
  readonly sourceCriticality: Readonly<Record<string, "REQUIRED" | "OPTIONAL">>;
  readonly atomicGroupByItemId: Readonly<Record<string, string>>;
}

interface CompactionComposition {
  readonly dependencies: ContextCompactionDependencies;
  readonly tentativeRebuild: (
    input: ContextCompactionRebuildInputWithIdentity,
  ) => Promise<ContextCompactionRebuildResult>;
}

function createCompactionComposition(input: CompactionCompositionInput): CompactionComposition {
  const tentativeRebuild = async (
    rebuildInput: ContextCompactionRebuildInputWithIdentity,
  ): Promise<ContextCompactionRebuildResult> => {
    throwIfAborted(input.input.signal);
    const candidateCheckpoint: ActiveCheckpointProjection = {
      checkpointId: rebuildInput.checkpointId,
      structuredCheckpoint: rebuildInput.input.checkpoint,
      sourceRange: rebuildInput.input.sourceRange,
      degraded: rebuildInput.degraded,
    };
    const candidateCoverage = createContextCompactionCoverageForRange({
      history: input.history,
      sourceRange: rebuildInput.input.sourceRange,
    });
    const candidateSources = withActiveCheckpointProjection(
      removeCoveredConversationMessages(input.collected, candidateCoverage.coveredMessageIds),
      candidateCheckpoint,
    );
    const authorities = await input.options.authorityProvider.snapshot({
      identity: input.input.identity,
      signal: input.input.signal,
    });
    const projection = await buildPreparedProjectionWithoutCompaction({
      contextInput: input.input,
      policy: rebuildInput.input.policy,
      sourceResults: candidateSources,
      activeCoverage: candidateCoverage,
      activeCheckpoint: candidateCheckpoint,
      authorities,
      planner: input.planner,
      sourcePriorities: sourcePriorityMap(input.options.sourceRegistry),
      rehydrator: input.rehydrator,
      documentBuilder: input.documentBuilder,
      materializer: input.options.materializer,
      receiptBuilder: input.receiptBuilder,
      promptSurfaceStore: input.options.promptSurfaceStore,
      ...(input.options.modelSettings === undefined
        ? {}
        : { modelSettings: input.options.modelSettings }),
      ...(input.options.promptSurfaceEpochIdFactory === undefined
        ? {}
        : { promptSurfaceEpochIdFactory: input.options.promptSurfaceEpochIdFactory }),
      tokenEstimator: input.options.tokenEstimator ?? createUtf8HeuristicTokenEstimator(),
      clock: input.options.clock,
      persistPromptSurface: false,
      recoveryPlan: input.recoveryPlan,
      sourceCriticality: input.sourceCriticality,
      atomicGroupByItemId: input.atomicGroupByItemId,
      compactionCount: 0,
    });
    return {
      estimatedInputTokens: projection.audit.report.estimatedInputTokens,
      retainedMessageIds: projection.selectedMessages.map((message) => message.message.id),
    };
  };

  const tentativeRebuilder = createContextCompactionRebuilder({
    build: async (rebuildInput) =>
      tentativeRebuild({
        checkpointId: createContextCheckpointId(requireCheckpointId(input.options)),
        degraded: true,
        input: rebuildInput,
      }),
  });
  const commit: ContextCompactionCommitPort = input.options.compactionCommit ?? {
    async commit() {
      throw new ContextExhaustedError();
    },
  };
  const factsProvider =
    input.options.deterministicFactsProvider ??
    ({
      async collect() {
        throw new ContextExhaustedError();
      },
    } satisfies DeterministicCompactionFactsProvider);
  const dependencies: ContextCompactionDependencies = {
    planner: input.compactionPlanner,
    incrementalResolver: input.incrementalCompactionResolver,
    checkpointBudget: input.checkpointBudgetResolver,
    gainEvaluator: input.compactionGainEvaluator,
    summarizer: input.summarizer,
    summaryValidator: input.summaryValidator,
    factsProvider,
    deterministicFallback: input.checkpointBuilder,
    enricher: input.checkpointEnricher,
    rehydrator: input.rehydrator,
    tentativeRebuilder,
    commit,
    clock: input.options.clock,
    checkpointIdFactory: {
      create: () => createContextCheckpointId(requireCheckpointId(input.options)),
    },
  };
  return Object.freeze({ dependencies: Object.freeze(dependencies), tentativeRebuild });
}

function requireCheckpointId(options: V2ContextEngineOptions): string {
  const factory = options.checkpointIdFactory;
  if (factory === undefined) throw new ContextExhaustedError();
  const id = factory.create();
  if (id.trim().length === 0) throw new ContextExhaustedError();
  return id;
}

function checkpointRef(
  record: ActiveCheckpointProjection | ContextCheckpointRecordV2,
): ContextCheckpointRef {
  if (
    record.checkpointId === undefined ||
    record.sourceRange === undefined ||
    record.degraded === undefined
  ) {
    throw new TypeError("Active Context Checkpoint projection is missing its V2 identity.");
  }
  return Object.freeze({
    checkpointId: record.checkpointId,
    schemaVersion: 2,
    sourceRange: record.sourceRange,
    degraded: record.degraded,
  });
}

function activeCheckpointProjection(record: ContextCheckpointRecordV2): ActiveCheckpointProjection {
  return Object.freeze({
    checkpointId: record.checkpointId,
    structuredCheckpoint: record.structuredCheckpoint,
    sourceRange: record.sourceRange,
    degraded: record.degraded,
  });
}

function checkpointReference(
  record: ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1 | undefined,
): { readonly checkpoint?: ContextCheckpointRef } {
  return record?.schemaVersion === 2 ? { checkpoint: checkpointRef(record) } : {};
}

function sourcePriorityMap(registry: ContextSourceRegistry): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      registry.list().map((registration) => [registration.id, registration.priority]),
    ),
  );
}

function contextHistoryAtomicGroups(
  history: ContextCompactionCoverage["history"],
): Readonly<Record<string, string>> {
  const groups: Record<string, string> = {};
  for (const unit of history.units) {
    for (const message of unit.messages) {
      groups[`agent.conversation:${String(message.messageId)}`] = unit.atomicGroupId;
    }
  }
  return Object.freeze(groups);
}

function selectedConversationMessages(plan: ContextPlan): readonly StoredAgentMessage[] {
  const seen = new Set<string>();
  return Object.freeze(
    plan.selectedItems
      .flatMap((item) => (item.payload.kind === "AGENT_MESSAGE" ? [item.payload.message] : []))
      .filter((stored) => {
        if (seen.has(stored.message.id)) return false;
        seen.add(stored.message.id);
        return true;
      }),
  );
}

/**
 * A later valid snapshot anchor does not prove that the planner retained earlier history.
 * Cache replay is eligible only when every uncovered model-visible durable message remains
 * in the current projection; otherwise the summary runs without a reusable prefix.
 */
interface PromptProjectionMessage {
  readonly message: {
    readonly id: string;
    readonly audience: { readonly model: boolean };
  };
}

export function promptProjectionPreservesUncoveredModelMessages(input: {
  readonly conversationMessages: readonly PromptProjectionMessage[];
  readonly selectedMessages: readonly PromptProjectionMessage[];
  readonly coveredMessageIds: ReadonlySet<string>;
}): boolean {
  const uncoveredModelMessageIds = (messages: readonly PromptProjectionMessage[]) =>
    messages
      .filter(
        (stored) =>
          stored.message.audience.model && !input.coveredMessageIds.has(String(stored.message.id)),
      )
      .map((stored) => String(stored.message.id));
  const expectedIds = uncoveredModelMessageIds(input.conversationMessages);
  const selectedIds = uncoveredModelMessageIds(input.selectedMessages);
  if (expectedIds.length !== selectedIds.length) return false;
  const selected = new Set(selectedIds);
  return (
    selected.size === selectedIds.length &&
    expectedIds.every((messageId) => selected.has(messageId))
  );
}

function removeCoveredConversationMessages(
  results: readonly ContextSourceCollectionResult[],
  coveredMessageIds: ReadonlySet<string>,
): readonly ContextSourceResult[] {
  // Canonical coverage replaces the former inline predicate:
  // stored.message.runId === range.runId &&
  // stored.sequence >= range.firstSequence && stored.sequence <= range.lastSequence.
  return Object.freeze(
    results.map((result) => {
      if (result.providerId !== AGENT_CONTEXT_SOURCE_IDS.conversation) return result;
      const items = result.items.filter((item) => {
        if (item.payload.kind !== "AGENT_MESSAGE") return true;
        const message = item.payload.message;
        return !coveredMessageIds.has(String(message.message.id));
      });
      return Object.freeze({ ...result, items: Object.freeze(items) });
    }),
  );
}

function checkpointFromIncrementalState(
  state: IncrementalCheckpointState,
): ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1 | undefined {
  return state.kind === "NONE" ? undefined : state.checkpoint;
}

function withActiveCheckpoint(
  results: readonly ContextSourceResult[],
  checkpoint: ContextCheckpointRecordV2,
): readonly ContextSourceResult[] {
  return withActiveCheckpointProjection(results, activeCheckpointProjection(checkpoint));
}

function withActiveCheckpointProjection(
  results: readonly ContextSourceResult[],
  checkpoint: ActiveCheckpointProjection,
): readonly ContextSourceResult[] {
  const checkpointResult = createSourceResult(
    AGENT_CONTEXT_SOURCE_IDS.checkpoint,
    "checkpoint-v1",
    [
      {
        id: createContextItemId(`agent.checkpoint:${checkpoint.checkpointId}`),
        type: "agent.checkpoint",
        source: {
          providerId: AGENT_CONTEXT_SOURCE_IDS.checkpoint,
          sourceRef: `checkpoint:${checkpoint.checkpointId}`,
          version: "checkpoint-v2",
        },
        scope: "RUN",
        retention: "REHYDRATABLE",
        priorityClass: "HIGH",
        tokenEstimate: estimateContextTokens(checkpoint.structuredCheckpoint),
        cacheStability: "STABLE",
        freshness: "CURRENT",
        sensitivity: "INTERNAL",
        whyLoaded: "durable checkpoint snapshot",
        payload: { kind: "CHECKPOINT", checkpoint: checkpoint.structuredCheckpoint },
      },
    ],
  );
  const replaced = results.some(
    (result) => result.providerId === AGENT_CONTEXT_SOURCE_IDS.checkpoint,
  );
  return Object.freeze(
    replaced
      ? results.map((result) =>
          result.providerId === AGENT_CONTEXT_SOURCE_IDS.checkpoint ? checkpointResult : result,
        )
      : [...results, checkpointResult],
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Context preparation was cancelled.");
  error.name = "AbortError";
  throw error;
}

interface PromptSurfacePreparationInput {
  readonly store: PromptSurfaceStorePort;
  readonly contextInput: ContextPrepareInput;
  readonly document: import("../document/context-document.js").ContextDocument;
  /** A warning/error means missing Sections cannot be interpreted as leaving the target view. */
  readonly allowSectionClear: boolean;
  readonly conversationMessages: readonly StoredAgentMessage[];
  readonly checkpointId?: string;
  readonly tools: ContextPrepareInput["tools"];
  readonly modelSettings?: AIModelSettings;
  readonly epochIdFactory?: { create(): string };
  readonly tokenEstimator: ContextTokenEstimatorPort;
  readonly clock: { now(): TimestampMs };
  readonly compactionCommitted: boolean;
  readonly persist: boolean;
  readonly replayOnly: boolean;
  /**
   * The replay cost this epoch may reach before an early rollover is worth it, in UTF-8 bytes.
   *
   * Derived from the frozen Context policy, so the decision and the request budget come from one
   * place. Absent means "hard bounds only", which is what a host without a working set gets.
   */
  readonly replaySoftBudgetBytes?: number;
}

interface PromptSurfacePreparationResult extends PreparedPromptSurface {
  /** True only when the existing epoch matches and the complete request can be replayed. */
  readonly replayEligible: boolean;
}

async function preparePromptSurface(
  input: PromptSurfacePreparationInput,
): Promise<PromptSurfacePreparationResult> {
  const identity = promptSurfaceIdentity(input);
  if (input.replayOnly) return preparePromptSurfaceReplay(input);
  // A preflight is not a licence to estimate a different projection: it reads the durable epoch and
  // projects exactly the decision the commit will make.
  if (!input.persist) return projectPromptSurface(input, identity);

  let current: PromptSurfaceEpoch | undefined;
  try {
    current = await input.store.getCurrent(input.contextInput.identity.runId);
  } catch (error) {
    throw new PromptSurfaceIntegrityError("Prompt Surface epoch metadata could not be read.", {
      cause: error,
    });
  }

  let resetReason = resetReasonFor(current, identity, input);
  let surface: PromptSurfaceEpochWithSnapshots | undefined;
  if (current !== undefined && resetReason === undefined) {
    try {
      surface = await input.store.readEpoch(current.runId, current.epochId);
      if (surface === undefined) throw new Error("missing surface");
      assertPromptSurfaceEpochWithSnapshots(surface);
    } catch (error) {
      throw new PromptSurfaceIntegrityError("Persisted Prompt Surface failed integrity checks.", {
        cause: error,
      });
    }
    if (
      !promptSurfaceAnchorsAreAvailable(
        input.conversationMessages,
        promptSurfaceAnchors(surface),
      ) ||
      !promptSurfaceAnchorsAreOrdered(input.conversationMessages, surface)
    ) {
      resetReason = "RECOVERY_INCOMPATIBLE";
      surface = undefined;
    }
  }

  if (resetReason !== undefined) {
    if (current !== undefined && !input.allowSectionClear) {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface cannot reset from an incomplete Context view.",
      );
    }
    if (current !== undefined && input.contextInput.turn.sequence < current.createdStepSequence) {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface reset would move behind the current durable Step.",
      );
    }
    const epoch = createPromptSurfaceEpoch({
      runId: input.contextInput.identity.runId,
      epochId: createPromptSurfaceEpochId(input.epochIdFactory?.create() ?? randomUUID()),
      modelRef: input.contextInput.model.ref,
      formatVersion: 3,
      stableHeadFingerprint: identity.stableHeadFingerprint,
      toolSchemaFingerprint: identity.toolSchemaFingerprint,
      cacheSettingsFingerprint: identity.cacheSettingsFingerprint,
      resetReason,
      createdStepSequence: input.contextInput.turn.sequence,
      createdAt: input.clock.now(),
    });
    try {
      await input.store.createEpoch(epoch);
      surface = { ...epoch, snapshots: [], records: [], sectionStates: [] };
    } catch (error) {
      const concurrent = await readCurrentSurface(input.store, epoch.runId);
      if (concurrent !== undefined && samePromptSurfaceIdentity(epoch, concurrent)) {
        surface = concurrent;
      } else {
        throw new PromptSurfaceIntegrityError("Prompt Surface epoch could not be committed.", {
          cause: error,
        });
      }
    }
  }

  if (surface === undefined) {
    throw new PromptSurfaceIntegrityError("Prompt Surface preparation has no complete epoch.");
  }

  if (surface.formatVersion !== 3) {
    throw new PromptSurfaceIntegrityError(
      "V2 Prompt Surface must be reset before a new Step executes.",
    );
  }
  return prepareV3PromptSurface(input, surface);
}

function preparePreviewSurface(
  input: PromptSurfacePreparationInput,
  identity: ReturnType<typeof promptSurfaceIdentity>,
): PromptSurfacePreparationResult {
  const runId = input.contextInput.identity.runId;
  const previewKey = fingerprint(
    stableJson({
      runId,
      step: input.contextInput.turn.sequence,
      identity,
    }),
  ).slice("sha256:".length);
  const epoch = createPromptSurfaceEpoch({
    runId,
    formatVersion: 3,
    epochId: `preview-${previewKey}`,
    modelRef: input.contextInput.model.ref,
    stableHeadFingerprint: identity.stableHeadFingerprint,
    toolSchemaFingerprint: identity.toolSchemaFingerprint,
    cacheSettingsFingerprint: identity.cacheSettingsFingerprint,
    resetReason: "COMPACTION_COMMITTED",
    createdStepSequence: input.contextInput.turn.sequence,
    createdAt: input.clock.now(),
  });
  const states = createPromptSurfaceSectionStates(input.document);
  const anchor = latestCompletePromptSurfaceAnchor(input.conversationMessages);
  const decisionFingerprint = sectionDecisionFingerprint(states, anchor);
  const baseline = diffPromptSurfaceSections([], states, true);
  const record = createPromptSurfaceRecord({
    runId: epoch.runId,
    epochId: epoch.epochId,
    ordinal: 1,
    anchor,
    sourceStepSequence: input.contextInput.turn.sequence,
    kind: baseline.kind,
    updates: baseline.updates,
    decisionFingerprint,
    createdAt: input.clock.now(),
  });
  const sectionStates = states;
  const surface: PromptSurfaceEpochWithSnapshots = {
    ...epoch,
    snapshots: [],
    records: [record],
    sectionStates,
  };
  return preparedSurface(surface, input, false);
}

function prepareV3PromptSurface(
  input: PromptSurfacePreparationInput,
  surface: PromptSurfaceEpochWithSnapshots,
): Promise<PromptSurfacePreparationResult> {
  return commitPromptSurfaceDecision(input, surface, 0);
}

/**
 * How many times one Step may re-decide after a concurrent writer moved the epoch.
 *
 * Mirrors the rollover bound: one re-read is enough to absorb a lost race, and a second conflict
 * means another writer is actively moving this Run's projection, which is a conflict to report
 * rather than a spin to win.
 */
const MAX_SURFACE_DECISION_ATTEMPTS = 2;

/** What this Step must do to the durable epoch, and the exact projection that would result. */
interface PromptSurfaceDecision {
  /** The decision already exists durably for this Step; nothing is written and nothing is new. */
  readonly kind: "EXISTING";
  readonly committed: PromptSurfaceEpochWithSnapshots;
}

interface PromptSurfaceNewDecision {
  readonly kind: "APPEND" | "ROLLOVER";
  readonly candidate: PromptSurfaceRecord;
  /** The complete Section view this Step leaves in effect. */
  readonly targetStates: readonly PromptSurfaceSectionState[];
  /**
   * The projection the next model request would be rendered from if this decision were committed.
   *
   * For an `APPEND` it is the durable log plus this Step's candidate; for a `ROLLOVER` it is the new
   * epoch with its baseline. Both are the *same bytes* the committed epoch would later render,
   * because a record's content is a pure function of its kind and Section updates.
   */
  readonly projected: PromptSurfaceEpochWithSnapshots;
  readonly expectedCurrentEpoch: PromptSurfaceEpoch;
  readonly expectedRecordOrdinal: number;
}

type PromptSurfaceAnyDecision = PromptSurfaceDecision | PromptSurfaceNewDecision;

/**
 * Decide this Step's surface transition without writing anything.
 *
 * ```text
 * one function → APPEND | ROLLOVER | EXISTING    (+ the projection each would produce)
 *        ↓                    ↓
 *   preflight             commit
 * ```
 *
 * Both callers read the same durable epoch, the same complete Section view and the same anchor, so
 * the estimated input and the estimate at send time differ only by the Step's own candidate — which
 * is precisely the thing the old preview path substituted away, replacing 127 historical deltas
 * with one synthetic baseline and reporting a projection the model was never sent.
 */
function decidePromptSurface(input: {
  readonly surface: PromptSurfaceEpochWithSnapshots;
  readonly contextInput: ContextPrepareInput;
  readonly document: import("../document/context-document.js").ContextDocument;
  readonly allowSectionClear: boolean;
  readonly conversationMessages: readonly StoredAgentMessage[];
  readonly clock: { now(): TimestampMs };
  readonly replaySoftBudgetBytes?: number;
}): PromptSurfaceAnyDecision {
  const surface = input.surface;
  if (surface.records === undefined || surface.sectionStates === undefined) {
    throw new PromptSurfaceIntegrityError(
      "V3 Prompt Surface is missing its durable Section state.",
    );
  }
  if (surface.formatVersion !== 3) {
    throw new PromptSurfaceIntegrityError("V3 preparation received a legacy Prompt Surface.");
  }
  const stepSequence = input.contextInput.turn.sequence;
  const records = surface.records;
  const existingIndex = records.findIndex((record) => record.sourceStepSequence === stepSequence);
  if (existingIndex >= 0 && existingIndex !== records.length - 1) {
    throw new PromptSurfaceIntegrityError("Prompt Surface retry is not the latest durable Step.");
  }
  if (records.some((record) => record.sourceStepSequence > stepSequence)) {
    throw new PromptSurfaceIntegrityError(
      "Prompt Surface Step order is incompatible with recovery.",
    );
  }
  if (stepSequence < surface.createdStepSequence) {
    throw new PromptSurfaceIntegrityError("Prompt Surface Step predates the current Epoch.");
  }

  const priorRecords = existingIndex >= 0 ? records.slice(0, existingIndex) : records;
  const priorStates = replayPromptSurfaceSectionStates(priorRecords);
  const currentStates = createPromptSurfaceSectionStates(input.document);
  const anchor = latestCompletePromptSurfaceAnchor(input.conversationMessages);
  const priorAnchor = priorRecords.at(-1)?.anchor;
  if (
    priorAnchor !== undefined &&
    comparePromptSurfaceAnchorOrder(input.conversationMessages, anchor, priorAnchor) < 0
  ) {
    throw new PromptSurfaceIntegrityError("Prompt Surface anchor would move backwards.");
  }
  const diff = diffPromptSurfaceSections(
    priorStates,
    currentStates,
    priorRecords.length === 0,
    input.allowSectionClear,
  );
  const targetStates = applyPromptSurfaceSectionUpdates(priorStates, diff.kind, diff.updates);
  const candidate = createPromptSurfaceRecord({
    runId: surface.runId,
    epochId: surface.epochId,
    ordinal: existingIndex >= 0 ? records[existingIndex]!.ordinal : records.length + 1,
    anchor,
    sourceStepSequence: stepSequence,
    kind: diff.kind,
    updates: diff.updates,
    decisionFingerprint: sectionDecisionFingerprint(targetStates, anchor),
    createdAt: input.clock.now(),
  });

  if (existingIndex >= 0) {
    if (records[existingIndex]!.contentHash !== candidate.contentHash) {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface Step retry differs from its durable Section decision.",
      );
    }
    return { kind: "EXISTING", committed: surface };
  }

  const capacity = decidePromptSurfaceCapacity({
    epoch: surface,
    candidate,
    targetSectionStates: targetStates,
    ...(input.replaySoftBudgetBytes === undefined
      ? {}
      : { replaySoftBudgetBytes: input.replaySoftBudgetBytes }),
  });
  if (capacity.kind === "BASELINE_TOO_LARGE") {
    throw promptSurfaceBaselineTooLarge(capacity.dimension, capacity.observed, capacity.limit);
  }
  const expectedCurrentEpoch = promptSurfaceEpochIdentity(surface);
  const expectedRecordOrdinal = records.length;
  if (capacity.kind === "APPEND") {
    const projected: PromptSurfaceEpochWithSnapshots = Object.freeze({
      ...surface,
      records: Object.freeze([...records, candidate]),
      sectionStates: targetStates,
    });
    return {
      kind: "APPEND",
      candidate,
      targetStates,
      projected,
      expectedCurrentEpoch,
      expectedRecordOrdinal,
    };
  }

  const operationId = promptSurfaceRolloverOperationId({
    epoch: surface,
    recordOrdinal: expectedRecordOrdinal,
    decisionFingerprint: lastDurableDecisionFingerprint(surface),
    stepSequence,
    anchor,
    targetSectionStates: targetStates,
  });
  const nextEpoch = createPromptSurfaceEpoch({
    formatVersion: 3,
    runId: surface.runId,
    epochId: `rollover-${operationId}`,
    modelRef: surface.modelRef,
    stableHeadFingerprint: surface.stableHeadFingerprint,
    toolSchemaFingerprint: surface.toolSchemaFingerprint,
    cacheSettingsFingerprint: surface.cacheSettingsFingerprint,
    resetReason: "CAPACITY_ROLLOVER",
    createdStepSequence: stepSequence,
    createdAt: candidate.createdAt,
  });
  const baseline = createPromptSurfaceRecord({
    runId: surface.runId,
    epochId: nextEpoch.epochId,
    ordinal: 1,
    anchor,
    sourceStepSequence: stepSequence,
    kind: "BASELINE",
    updates: diffPromptSurfaceSections([], targetStates, true).updates,
    decisionFingerprint: candidate.decisionFingerprint,
    createdAt: candidate.createdAt,
  });
  const projected: PromptSurfaceEpochWithSnapshots = Object.freeze({
    ...nextEpoch,
    snapshots: Object.freeze([]),
    records: Object.freeze([baseline]),
    sectionStates: targetStates,
  });
  return {
    kind: "ROLLOVER",
    candidate,
    targetStates,
    projected,
    expectedCurrentEpoch,
    expectedRecordOrdinal,
  };
}

/** The CAS token for the source epoch's last decision; `null` only when it has no decisions. */
function lastDurableDecisionFingerprint(
  surface: PromptSurfaceEpochWithSnapshots,
): string | null {
  return surface.records?.at(-1)?.decisionFingerprint ?? null;
}

/**
 * Commit one decision, re-deciding at most once if a concurrent writer moved the epoch.
 *
 * A conflict is not a corruption and must not be retried without bound: the refreshed epoch is read
 * once, the Step is decided again against it, and a second conflict surfaces. The committed epoch is
 * always read back and verified, so the projection the caller estimates is the projection the model
 * is sent.
 */
async function commitPromptSurfaceDecision(
  input: PromptSurfacePreparationInput,
  surface: PromptSurfaceEpochWithSnapshots,
  attempt: number,
): Promise<PromptSurfacePreparationResult> {
  const decision = decidePromptSurface({
    surface,
    contextInput: input.contextInput,
    document: input.document,
    allowSectionClear: input.allowSectionClear,
    conversationMessages: input.conversationMessages,
    clock: input.clock,
    ...(input.replaySoftBudgetBytes === undefined
      ? {}
      : { replaySoftBudgetBytes: input.replaySoftBudgetBytes }),
  });
  if (decision.kind === "EXISTING") {
    return preparedSurface(decision.committed, input, true);
  }
  try {
    return decision.kind === "APPEND"
      ? await appendPreparedSurface(input, decision)
      : await rolloverPreparedSurface(input, surface, decision);
  } catch (error) {
    if (attempt + 1 < MAX_SURFACE_DECISION_ATTEMPTS && isSurfaceAppendConflict(error)) {
      const refreshed = await input.store.readEpoch(surface.runId, surface.epochId);
      if (refreshed === undefined) {
        throw new PromptSurfaceIntegrityError(
          "Prompt Surface epoch disappeared while re-deciding its Step.",
          { cause: error },
        );
      }
      assertPromptSurfaceEpochWithSnapshots(refreshed);
      return commitPromptSurfaceDecision(input, refreshed, attempt + 1);
    }
    throw error;
  }
}

/**
 * Recognize the store's compare-and-swap rejection without depending on a Storage class.
 *
 * `PromptSurfaceStorePort` deliberately exposes no error type for appends — a conflict is a normal
 * outcome of two writers, not part of the port's contract. The name check keeps the kernel free of
 * a Storage dependency; the alternative, widening the port, would make every host implement a
 * conflict type it does not produce.
 */
function isSurfaceAppendConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { readonly name?: unknown }).name;
  return name === "StorageConflictError" || name === "PromptSurfaceRolloverConflictError";
}

/**
 * The read-only projection of the same decision the commit path would make.
 *
 * This is what a pressure preflight must estimate. It writes no epoch, no record, no checkpoint and
 * no event, and it runs no model turn: it reads the durable epoch and computes the candidate exactly
 * as the commit would, so `estimatedInputTokens` describes the messages the provider will receive.
 *
 * A Run with no durable epoch, an identity change or an unavailable anchor would reset the epoch on
 * commit; the projection for that case is the same complete-baseline view `preparePreviewSurface`
 * already builds, because a fresh epoch's first record *is* the complete current Section view.
 */
async function projectPromptSurface(
  input: PromptSurfacePreparationInput,
  identity: ReturnType<typeof promptSurfaceIdentity>,
): Promise<PromptSurfacePreparationResult> {
  let current: PromptSurfaceEpoch | undefined;
  try {
    current = await input.store.getCurrent(input.contextInput.identity.runId);
  } catch (error) {
    throw new PromptSurfaceIntegrityError("Prompt Surface epoch metadata could not be read.", {
      cause: error,
    });
  }
  if (current === undefined) return preparePreviewSurface(input, identity);
  const currentIdentity = promptSurfaceIdentity(input, current.formatVersion);
  if (resetReasonFor(current, currentIdentity, input) !== undefined) {
    return preparePreviewSurface(input, identity);
  }
  let surface: PromptSurfaceEpochWithSnapshots;
  try {
    const loaded = await input.store.readEpoch(current.runId, current.epochId);
    if (loaded === undefined) throw new Error("missing surface");
    assertPromptSurfaceEpochWithSnapshots(loaded);
    surface = loaded;
  } catch (error) {
    throw new PromptSurfaceIntegrityError("Persisted Prompt Surface failed integrity checks.", {
      cause: error,
    });
  }
  if (
    !promptSurfaceAnchorsAreAvailable(input.conversationMessages, promptSurfaceAnchors(surface)) ||
    !promptSurfaceAnchorsAreOrdered(input.conversationMessages, surface)
  ) {
    return preparePreviewSurface(input, identity);
  }
  const decision = projectedDecision(input, surface);
  if (decision === undefined) return preparePreviewSurface(input, identity);
  return preparedSurface(
    decision.kind === "EXISTING" ? decision.committed : decision.projected,
    input,
    true,
  );
}

/**
 * The decision this Step would make against the durable epoch, or `undefined` when it cannot be
 * produced without deciding something the commit has not decided yet.
 *
 * ```text
 * commit  → integrity failure is a refusal to write        (it must throw)
 * preflight → integrity failure is a projection to replace (it must not throw)
 * ```
 *
 * A same-Step retry whose authoritative state changed between the two attempts is a real case: the
 * commit path resolves it by resetting the epoch for a compaction, or refuses the write otherwise.
 * Neither of those is a measurement outcome, so a read-only preflight that hit one estimates the
 * complete-baseline view instead — exactly what this path produced before the preflight became
 * decision-based — and the report's fingerprint comparison still exposes the divergence.
 */
function projectedDecision(
  input: PromptSurfacePreparationInput,
  surface: PromptSurfaceEpochWithSnapshots,
): PromptSurfaceAnyDecision | undefined {
  try {
    return decidePromptSurface({
      surface,
      contextInput: input.contextInput,
      document: input.document,
      allowSectionClear: input.allowSectionClear,
      conversationMessages: input.conversationMessages,
      clock: input.clock,
      ...(input.replaySoftBudgetBytes === undefined
        ? {}
        : { replaySoftBudgetBytes: input.replaySoftBudgetBytes }),
    });
  } catch (error) {
    if (error instanceof PromptSurfaceIntegrityError) return undefined;
    throw error;
  }
}

/**
 * Append one decision to the epoch that still has room for it.
 *
 * The committed epoch is read back and re-verified: an append that the store accepted but that
 * cannot be reproduced byte-for-byte is treated as corruption, not as success.
 */
function appendPreparedSurface(
  input: PromptSurfacePreparationInput,
  decision: PromptSurfaceNewDecision,
): Promise<PromptSurfacePreparationResult> {
  const candidate = decision.candidate;
  const stepSequence = candidate.sourceStepSequence;
  return input.store
    .appendRecord(candidate, decision.expectedCurrentEpoch, decision.expectedRecordOrdinal)
    .then(async () => {
      const committed = await input.store.readEpoch(candidate.runId, candidate.epochId);
      if (committed === undefined) {
        throw new PromptSurfaceIntegrityError(
          "Committed Prompt Surface V3 record could not be read.",
        );
      }
      assertPromptSurfaceEpochWithSnapshots(committed);
      const stored = committed.records?.find(
        (record) => record.sourceStepSequence === stepSequence,
      );
      if (stored === undefined || stored.contentHash !== candidate.contentHash) {
        throw new PromptSurfaceIntegrityError(
          "Committed Prompt Surface decision differs from its request.",
        );
      }
      if (
        !promptSurfaceAnchorsAreAvailable(
          input.conversationMessages,
          promptSurfaceAnchors(committed),
        )
      ) {
        throw new PromptSurfaceIntegrityError("Committed Prompt Surface anchor is unavailable.");
      }
      return preparedSurface(committed, input, true);
    });
}

/**
 * Continue this Step in a new epoch whose baseline is the complete Section view.
 *
 * The old epoch and every durable message remain; the next model request is simply projected
 * against a smaller, equivalent log. No model inference, summary or Tool call is involved, so the
 * cost of crossing this boundary is one projection rebuild.
 */
async function rolloverPreparedSurface(
  input: PromptSurfacePreparationInput,
  surface: PromptSurfaceEpochWithSnapshots,
  decision: PromptSurfaceNewDecision,
): Promise<PromptSurfacePreparationResult> {
  const rolled = await rolloverPromptSurface({
    store: input.store,
    epoch: surface,
    stepSequence: decision.candidate.sourceStepSequence,
    anchor: decision.candidate.anchor,
    targetSectionStates: decision.targetStates,
    decisionFingerprint: decision.candidate.decisionFingerprint,
    createdAt: decision.candidate.createdAt,
  });
  return confirmRolledSurface(input, rolled, decision.candidate);
}

async function confirmRolledSurface(
  input: PromptSurfacePreparationInput,
  rolled: PromptSurfaceRolloverOutcome,
  candidate: PromptSurfaceRecord,
): Promise<PromptSurfacePreparationResult> {
  const committed = await input.store.readEpoch(rolled.epoch.runId, rolled.epoch.epochId);
  if (committed === undefined) {
    throw new PromptSurfaceIntegrityError("Committed Prompt Surface rollover could not be read.");
  }
  assertPromptSurfaceEpochWithSnapshots(committed);
  const stored = committed.records?.find(
    (record) => record.sourceStepSequence === candidate.sourceStepSequence,
  );
  // The committed decision is the epoch's baseline, not the delta this Step would have appended:
  // it must still fingerprint the same target view and anchor the caller decided on.
  if (
    stored === undefined ||
    stored.kind !== "BASELINE" ||
    stored.ordinal !== 1 ||
    stored.decisionFingerprint !== candidate.decisionFingerprint
  ) {
    throw new PromptSurfaceIntegrityError(
      "Committed Prompt Surface rollover differs from its request.",
    );
  }
  if (
    !promptSurfaceAnchorsAreAvailable(input.conversationMessages, promptSurfaceAnchors(committed))
  ) {
    throw new PromptSurfaceIntegrityError("Committed Prompt Surface anchor is unavailable.");
  }
  return preparedSurface(committed, input, true);
}

function replayPromptSurfaceSectionStates(
  records: readonly PromptSurfaceRecord[],
): readonly PromptSurfaceSectionState[] {
  let states: readonly PromptSurfaceSectionState[] = Object.freeze([]);
  for (const record of records) {
    states = applyPromptSurfaceSectionUpdates(states, record.kind, record.updates);
  }
  return states;
}

/** Reconstruct the request surface without creating epochs or appending snapshots. */
async function preparePromptSurfaceReplay(
  input: PromptSurfacePreparationInput,
): Promise<PromptSurfacePreparationResult> {
  let current: PromptSurfaceEpoch | undefined;
  try {
    current = await input.store.getCurrent(input.contextInput.identity.runId);
  } catch (error) {
    throw new PromptSurfaceIntegrityError("Prompt Surface epoch metadata could not be read.", {
      cause: error,
    });
  }
  if (current === undefined) {
    return preparePreviewSurface(input, promptSurfaceIdentity(input));
  }
  const identity = promptSurfaceIdentity(input, current.formatVersion);
  if (!promptSurfaceReplayIdentityMatches({ current, model: input.contextInput.model, identity })) {
    return preparePreviewSurface(input, promptSurfaceIdentity(input));
  }

  let surface: PromptSurfaceEpochWithSnapshots;
  try {
    const loaded = await input.store.readEpoch(current.runId, current.epochId);
    if (loaded === undefined) throw new Error("missing surface");
    assertPromptSurfaceEpochWithSnapshots(loaded);
    surface = loaded;
  } catch (error) {
    throw new PromptSurfaceIntegrityError("Persisted Prompt Surface failed integrity checks.", {
      cause: error,
    });
  }
  if (input.contextInput.turn.sequence < surface.createdStepSequence) {
    throw new PromptSurfaceIntegrityError("Prompt Surface replay Step predates its durable Epoch.");
  }

  const targetSequence = input.contextInput.turn.sequence;
  if (surface.formatVersion === 3) {
    const records = surface.records;
    if (records === undefined || surface.sectionStates === undefined) {
      throw new PromptSurfaceIntegrityError("V3 replay is missing durable Section state.");
    }
    let targetIndex = -1;
    for (let index = 0; index < records.length; index += 1) {
      if (records[index]!.sourceStepSequence <= targetSequence) targetIndex = index;
      else break;
    }
    if (targetIndex < 0) {
      return preparePreviewSurface(input, promptSurfaceIdentity(input));
    }
    const replayedRecords = Object.freeze(records.slice(0, targetIndex + 1));
    const replayed: PromptSurfaceEpochWithSnapshots = Object.freeze({
      ...surface,
      records: replayedRecords,
      sectionStates: replayPromptSurfaceSectionStates(replayedRecords),
    });
    assertPromptSurfaceEpochWithSnapshots(replayed);
    if (
      !promptSurfaceAnchorsAreAvailable(
        input.conversationMessages,
        promptSurfaceAnchors(replayed),
      ) ||
      !promptSurfaceAnchorsAreOrdered(input.conversationMessages, replayed)
    ) {
      throw new PromptSurfaceIntegrityError(
        "V3 replay anchor is unavailable in the durable conversation.",
      );
    }
    return preparedSurface(replayed, input, true);
  }

  const replayedSnapshots = Object.freeze(
    surface.snapshots.filter((snapshot) => snapshot.sourceStepSequence <= targetSequence),
  );
  if (
    !promptSurfaceAnchorsAreAvailable(
      input.conversationMessages,
      replayedSnapshots.map(({ anchor }) => anchor),
    ) ||
    !promptSurfaceAnchorsAreOrdered(input.conversationMessages, {
      ...surface,
      snapshots: replayedSnapshots,
    })
  ) {
    throw new PromptSurfaceIntegrityError(
      "V2 replay anchor is unavailable in the durable conversation.",
    );
  }
  const replayed: PromptSurfaceEpochWithSnapshots = Object.freeze({
    ...surface,
    snapshots: replayedSnapshots,
  });
  assertPromptSurfaceEpochWithSnapshots(replayed);
  return preparedSurface(replayed, input, true);
}

interface PromptSurfaceIdentity {
  readonly stableHeadFingerprint: string;
  readonly toolSchemaFingerprint: string;
  readonly cacheSettingsFingerprint: string;
}

function promptSurfaceIdentity(
  input: PromptSurfacePreparationInput,
  formatVersion: 2 | 3 = 3,
): PromptSurfaceIdentity {
  return {
    stableHeadFingerprint: promptSurfaceStableHeadFingerprint({
      stableHead: renderStableContextHead(input.document, formatVersion),
      ...(input.checkpointId === undefined ? {} : { checkpointId: input.checkpointId }),
    }),
    toolSchemaFingerprint: fingerprint(stableJson(input.tools)),
    cacheSettingsFingerprint: fingerprint(
      stableJson({
        api: input.contextInput.model.api,
        promptCaching: input.contextInput.model.capabilities.promptCaching,
        settings: input.modelSettings ?? null,
      }),
    ),
  };
}

/** Bind the reusable stable head to the durable checkpoint revision it accompanies. */
export function promptSurfaceStableHeadFingerprint(input: {
  readonly stableHead: string;
  readonly checkpointId?: string;
}): string {
  return fingerprint(
    stableJson({
      stableHead: input.stableHead,
      checkpointId: input.checkpointId ?? null,
    }),
  );
}

/** Internal predicate shared by replay selection and focused identity tests. */
export function promptSurfaceReplayIdentityMatches(input: {
  readonly current: {
    readonly modelRef: { readonly provider: string; readonly model: string };
    readonly stableHeadFingerprint: string;
    readonly toolSchemaFingerprint: string;
    readonly cacheSettingsFingerprint: string;
  };
  readonly model: ContextPrepareInput["model"];
  readonly identity: PromptSurfaceIdentity;
}): boolean {
  return (
    input.current.modelRef.provider === input.model.ref.provider &&
    input.current.modelRef.model === input.model.ref.model &&
    input.current.stableHeadFingerprint === input.identity.stableHeadFingerprint &&
    input.current.toolSchemaFingerprint === input.identity.toolSchemaFingerprint &&
    input.current.cacheSettingsFingerprint === input.identity.cacheSettingsFingerprint
  );
}

function createContextSummaryReplayPrefix(input: {
  readonly model: ContextPrepareInput["model"];
  readonly tools: ContextPrepareInput["tools"];
  readonly promptSurface: PromptSurfacePreparationResult;
  readonly messages: readonly AIMessage[];
}): ContextSummaryReplayPrefix {
  return Object.freeze({
    modelRef: Object.freeze({ ...input.model.ref }),
    api: input.model.api,
    surfaceFingerprint: input.promptSurface.receipt.prefixFingerprint,
    messages: Object.freeze([...input.messages]),
    tools: Object.freeze([...input.tools]),
  });
}

function resetReasonFor(
  current: PromptSurfaceEpoch | undefined,
  identity: ReturnType<typeof promptSurfaceIdentity>,
  input: PromptSurfacePreparationInput,
): PromptSurfaceResetReason | undefined {
  if (current === undefined) {
    return input.compactionCommitted ? "COMPACTION_COMMITTED" : "INITIAL";
  }
  if (
    input.compactionCommitted &&
    !(
      current.createdStepSequence === input.contextInput.turn.sequence &&
      current.resetReason === "COMPACTION_COMMITTED"
    )
  ) {
    return "COMPACTION_COMMITTED";
  }
  if (current.formatVersion !== 3) {
    return "RECOVERY_INCOMPATIBLE";
  }
  if (
    current.modelRef.provider !== input.contextInput.model.ref.provider ||
    current.modelRef.model !== input.contextInput.model.ref.model
  ) {
    return "MODEL_CHANGED";
  }
  if (current.toolSchemaFingerprint !== identity.toolSchemaFingerprint) {
    return "TOOL_SCHEMA_CHANGED";
  }
  if (current.stableHeadFingerprint !== identity.stableHeadFingerprint) {
    return "STABLE_HEAD_CHANGED";
  }
  if (current.cacheSettingsFingerprint !== identity.cacheSettingsFingerprint) {
    return "CACHE_SETTINGS_CHANGED";
  }
  return undefined;
}

async function readCurrentSurface(
  store: PromptSurfaceStorePort,
  runId: ContextPrepareInput["identity"]["runId"],
  epochId?: PromptSurfaceEpoch["epochId"],
): Promise<PromptSurfaceEpochWithSnapshots | undefined> {
  try {
    if (epochId !== undefined) return await store.readEpoch(runId, epochId);
    const current = await store.getCurrent(runId);
    return current === undefined ? undefined : await store.readEpoch(runId, current.epochId);
  } catch (error) {
    throw new PromptSurfaceIntegrityError("Persisted Prompt Surface could not be verified.", {
      cause: error,
    });
  }
}

function samePromptSurfaceIdentity(left: PromptSurfaceEpoch, right: PromptSurfaceEpoch): boolean {
  return (
    left.runId === right.runId &&
    left.formatVersion === right.formatVersion &&
    left.createdStepSequence === right.createdStepSequence &&
    left.resetReason === right.resetReason &&
    left.modelRef.provider === right.modelRef.provider &&
    left.modelRef.model === right.modelRef.model &&
    left.stableHeadFingerprint === right.stableHeadFingerprint &&
    left.toolSchemaFingerprint === right.toolSchemaFingerprint &&
    left.cacheSettingsFingerprint === right.cacheSettingsFingerprint
  );
}

function promptSurfaceAnchors(
  surface: PromptSurfaceEpochWithSnapshots,
): readonly PromptSurfaceAnchor[] {
  return surface.formatVersion === 3
    ? (surface.records ?? []).map((record) => record.anchor)
    : surface.snapshots.map((snapshot) => snapshot.anchor);
}

function promptSurfaceAnchorsAreOrdered(
  messages: readonly StoredAgentMessage[],
  surface: PromptSurfaceEpochWithSnapshots,
): boolean {
  const anchors = promptSurfaceAnchors(surface);
  for (let index = 1; index < anchors.length; index += 1) {
    if (comparePromptSurfaceAnchorOrder(messages, anchors[index]!, anchors[index - 1]!) < 0) {
      return false;
    }
  }
  return true;
}

function sectionDecisionFingerprint(
  states: readonly PromptSurfaceSectionState[],
  anchor: PromptSurfaceAnchor,
): string {
  return createHash("sha256")
    .update(
      stableJson({
        states: states.map((state) => ({
          stateKey: state.stateKey,
          contentHash: state.contentHash,
        })),
        anchor,
      }),
      "utf8",
    )
    .digest("hex");
}

function preparedSurface(
  surface: PromptSurfaceEpochWithSnapshots,
  input: PromptSurfacePreparationInput,
  replayEligible = true,
): PromptSurfacePreparationResult {
  assertPromptSurfaceEpochWithSnapshots(surface);
  const stableHead = renderStableContextHead(input.document, surface.formatVersion);
  const stableHeadTokens = estimatePromptSurfaceTokens(
    input.tokenEstimator.estimateText(stableHead, input.contextInput.model),
    "stable head",
  );
  const snapshotTokens =
    surface.formatVersion === 3
      ? (surface.records ?? []).reduce((sum, record) => {
          if (record.kind === "NOOP") return sum;
          const content = renderPromptSurfaceRecord(record.kind, record.updates);
          return (
            sum +
            estimatePromptSurfaceTokens(
              input.tokenEstimator.estimateText(content, input.contextInput.model),
              "runtime context record",
            )
          );
        }, 0)
      : surface.snapshots.reduce(
          (sum, snapshot) =>
            sum +
            estimatePromptSurfaceTokens(
              input.tokenEstimator.estimateText(snapshot.content, input.contextInput.model),
              "snapshot",
            ),
          0,
        );
  const expectedReusablePrefixTokens = estimatePromptSurfaceTokens(
    stableHeadTokens + snapshotTokens,
    "reusable prefix",
  );
  const prefixFingerprint = fingerprint(
    stableJson({
      anchorIdentityVersion: PROMPT_SURFACE_ANCHOR_VERSION,
      epochId: surface.epochId,
      formatVersion: surface.formatVersion,
      stableHeadFingerprint: surface.stableHeadFingerprint,
      toolSchemaFingerprint: surface.toolSchemaFingerprint,
      cacheSettingsFingerprint: surface.cacheSettingsFingerprint,
      runtimeRecords:
        surface.formatVersion === 3
          ? (surface.records ?? [])
              .filter((record) => record.kind !== "NOOP")
              .map((record) => ({
                ordinal: record.ordinal,
                kind: record.kind,
                anchor: record.anchor,
                contentHash: record.contentHash,
              }))
          : surface.snapshots.map((snapshot) => ({
              ordinal: snapshot.ordinal,
              anchor: snapshot.anchor,
              contentHash: snapshot.contentHash,
            })),
    }),
  );
  return Object.freeze({
    epoch: surface,
    replayEligible,
    receipt: Object.freeze({
      epochId: surface.epochId,
      prefixFingerprint,
      stableHeadTokens,
      snapshotTokens,
      expectedReusablePrefixTokens,
      resetReason: surface.resetReason,
    }),
  });
}

/**
 * A content-exact fingerprint of one materialized projection.
 *
 * Roles and contents only: metadata that never reaches the provider must not make two identical
 * requests look different, and two different requests must never look identical. The hash is over
 * the text the model would read, which is the only definition of "the same projection" that cannot
 * be satisfied by a producer that happens to serialize its own state the same way twice.
 */
function projectionContentFingerprint(messages: readonly AIMessage[]): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash.update(message.role, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      "utf8",
    );
    hash.update("\u0000", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function estimatePromptSurfaceTokens(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Prompt Surface ${label} token estimate is invalid.`);
  }
  return value;
}

function fingerprint(value: string): string {
  const hash = createHash("sha256").update(value, "utf8").digest("hex");
  return createPromptSurfaceFingerprint(`sha256:${hash}`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
