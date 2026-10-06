import { createHash, randomUUID } from "node:crypto";

import type { AIMessage, AIModelSettings } from "@caelush/ai";
import type { EventId, TimestampMs } from "@caelush/protocol";

import type { RunEventNotifierPort } from "../../events/notifier-port.js";
import type { DurableRunEventDraft } from "../../events/durable-run-event-draft.js";
import type { PreparedModelContext } from "../../loop/types.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { ContextPrepareInput, ContextEnginePort } from "../contracts/context-engine.js";
import type { PreparedPromptSurface } from "../contracts/prepared-agent-context.js";
import {
  assertPromptSurfaceEpochWithSnapshots,
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceFingerprint,
  createPromptSurfaceSnapshot,
  PromptSurfaceIntegrityError,
} from "../surface/prompt-surface.js";
import type {
  PromptSurfaceEpoch,
  PromptSurfaceEpochWithSnapshots,
  PromptSurfaceResetReason,
} from "../surface/prompt-surface.js";
import type { PromptSurfaceStorePort } from "../surface/prompt-surface-store.js";
import {
  latestCompletePromptSurfaceAnchor,
  promptSurfaceAnchorsAreAvailable,
} from "../surface/prompt-surface-anchors.js";
import {
  CLEARED_RUNTIME_CONTEXT_SNAPSHOT,
  renderRuntimeContextSnapshot,
  renderStableContextHead,
} from "../surface/prompt-surface-renderer.js";
import {
  createContextCheckpointId,
  type ContextCompactionReason,
  type ContextCheckpointRecordV2,
  type ContextCheckpointRepositoryPort,
  type LegacyContextCheckpointRecordV1,
} from "../compaction/context-compaction-contracts.js";
import { createContextCompactionPlanner } from "../compaction/context-compaction-planner.js";
import { createContextPressureEvaluator } from "../compaction/context-pressure-evaluator.js";
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
  type ContextPlan,
  type ContextPolicyOptions,
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
import type { AgentExecutionIdentity, AgentTurnRef } from "../../loop/types.js";
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
    readonly turn: AgentTurnRef;
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
        stepId: input.turn.stepId,
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
      const policy = createContextPolicy({
        model: input.model,
        tools: input.tools,
        requestOverhead,
        ...(input.mode === "FORCED_RECOVERY" && options.forcedObservationPolicy !== undefined
          ? {
              options: {
                ...options.policy,
                ...options.forcedObservationPolicy,
              },
            }
          : options.policy === undefined
            ? {}
            : { options: options.policy }),
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
      const initialPlan = planner.plan({
        items: sourceResults.flatMap((result) => result.items),
        policy,
        history: coverage.history,
        currentTurnId: input.conversation.currentTurnId,
        sourcePriorities: sourcePriorityMap(options.sourceRegistry),
      });
      let activeCheckpoint = latestCheckpoint;
      let activeCoverage = coverage;
      let activeSources = sourceResults;
      let compactionReceipt: ContextCompactionReceipt | undefined;
      let compactionCount = 0;
      const pressure = pressureEvaluator.evaluate({
        estimatedInputTokens:
          initialPlan.budget.selectedTokens + policy.requestOverhead.totalTokens,
        mandatoryTokens: initialPlan.budget.mandatoryTokens + policy.requestOverhead.totalTokens,
        effectiveInputLimitTokens: policy.effectiveInputLimitTokens,
        proactiveCompactionTokens: policy.proactiveCompactionTokens,
        emergencyCompactionTokens: policy.emergencyCompactionTokens,
        targetRecentTailTokens: policy.targetRecentTailTokens,
        minRecentTailTokens: policy.minRecentTailTokens,
        mode: input.mode,
        hasCompressibleHistory: activeCoverage.history.units.some(
          (unit) => unit.status === "CLOSED" && unit.compactionEligible,
        ),
      });
      const sourceCriticality = contextSourceCriticality(options.sourceRegistry.list());
      const atomicGroupByItemId = contextHistoryAtomicGroups(history);
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
        const replayAuthorities = await options.authorityProvider.snapshot({
          identity: input.identity,
          signal: input.signal,
        });
        throwIfAborted(input.signal);
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
          authorities: replayAuthorities,
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
          createEvents: ({ request, plan, checkpoint, degraded }) =>
            options.compactionEvents === undefined || options.eventIdFactory === undefined
              ? []
              : [
                  options.compactionEvents.completed({
                    identity: request.identity,
                    turn: input.turn,
                    checkpoint,
                    reason: request.reason,
                    tokensBefore: plan.estimatedTokensBefore,
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
        const outcome = await coordinator.compact({
          identity: input.identity,
          conversation: input.conversation,
          history: activeCoverage.history,
          policy: withRecoveryTailPolicy(policy, recoveryPlan),
          model: input.model,
          ...(replayPrefix === undefined
            ? {}
            : {
                replayPrefix,
                replayPrefixFingerprint: createContextSummaryReplayPrefixFingerprint(replayPrefix),
              }),
          reason,
          signal: input.signal,
        });
        if (outcome.kind === "COMPACTED") {
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
      const authorities = await options.authorityProvider.snapshot({
        identity: input.identity,
        signal: input.signal,
      });
      throwIfAborted(input.signal);
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
        throw new ContextExhaustedError();
      }
      await options.usageStore.upsert(
        recoveryStages.length === 0
          ? finalProjection.audit.usage
          : { ...finalProjection.audit.usage, lastRecoveryStages: recoveryStages },
      );
      throwIfAborted(input.signal);
      return Object.freeze({
        messages: finalProjection.materializedMessages,
        report: finalProjection.audit.report,
        observationPolicy: finalPolicy.observationPolicy,
        ...checkpointReference(activeCheckpoint),
        contextFingerprint: finalProjection.audit.contextFingerprint,
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
      })
      .sort((left, right) => left.sequence - right.sequence),
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
}

interface PromptSurfacePreparationResult extends PreparedPromptSurface {
  /** True only when the existing epoch matches and the complete request can be replayed. */
  readonly replayEligible: boolean;
}

async function preparePromptSurface(
  input: PromptSurfacePreparationInput,
): Promise<PromptSurfacePreparationResult> {
  const identity = promptSurfaceIdentity(input);
  if (input.replayOnly) return preparePromptSurfaceReplay(input, identity);
  if (!input.persist) return preparePreviewSurface(input, identity);

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
        surface.snapshots.map((snapshot) => snapshot.anchorMessageSequence),
      )
    ) {
      resetReason = "RECOVERY_INCOMPATIBLE";
      surface = undefined;
    }
  }

  if (resetReason !== undefined) {
    if (current !== undefined && input.contextInput.turn.sequence < current.createdStepSequence) {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface reset would move behind the current durable Step.",
      );
    }
    const epoch = createPromptSurfaceEpoch({
      runId: input.contextInput.identity.runId,
      epochId: createPromptSurfaceEpochId(input.epochIdFactory?.create() ?? randomUUID()),
      modelRef: input.contextInput.model.ref,
      stableHeadFingerprint: identity.stableHeadFingerprint,
      toolSchemaFingerprint: identity.toolSchemaFingerprint,
      cacheSettingsFingerprint: identity.cacheSettingsFingerprint,
      resetReason,
      createdStepSequence: input.contextInput.turn.sequence,
      createdAt: input.clock.now(),
    });
    try {
      await input.store.createEpoch(epoch);
      surface = { ...epoch, snapshots: [] };
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

  const currentStepSnapshot = surface.snapshots.find(
    (snapshot) => snapshot.sourceStepSequence === input.contextInput.turn.sequence,
  );
  if (currentStepSnapshot !== undefined) {
    if (surface.snapshots.at(-1)?.sourceStepSequence !== input.contextInput.turn.sequence) {
      throw new PromptSurfaceIntegrityError("Prompt Surface retry is not the latest durable Step.");
    }
    return preparedSurface(surface, input);
  }
  if (
    surface.snapshots.some(
      (snapshot) => snapshot.sourceStepSequence > input.contextInput.turn.sequence,
    ) ||
    input.contextInput.turn.sequence < surface.createdStepSequence
  ) {
    throw new PromptSurfaceIntegrityError(
      "Prompt Surface Step order is incompatible with recovery.",
    );
  }

  const lastSnapshot = surface.snapshots.at(-1);
  let content = renderRuntimeContextSnapshot(input.document);
  if (content === undefined) {
    if (lastSnapshot === undefined || isClearedSnapshot(lastSnapshot.content)) {
      return preparedSurface(surface, input);
    }
    content = CLEARED_RUNTIME_CONTEXT_SNAPSHOT;
  } else if (lastSnapshot?.content === content) {
    return preparedSurface(surface, input);
  }

  const anchorMessageSequence = latestCompletePromptSurfaceAnchor(input.conversationMessages);
  if (lastSnapshot !== undefined && anchorMessageSequence < lastSnapshot.anchorMessageSequence) {
    throw new PromptSurfaceIntegrityError("Prompt Surface anchor would move backwards.");
  }
  const snapshot = createPromptSurfaceSnapshot({
    runId: surface.runId,
    epochId: surface.epochId,
    ordinal: surface.snapshots.length + 1,
    anchorMessageSequence,
    sourceStepSequence: input.contextInput.turn.sequence,
    kind: "RUNTIME_CONTEXT_SNAPSHOT",
    content,
    createdAt: input.clock.now(),
  });
  const appendEpochId = surface.epochId;
  try {
    await input.store.appendSnapshot(snapshot, promptSurfaceEpochOnly(surface));
    surface = await readCurrentSurface(input.store, snapshot.runId, appendEpochId);
  } catch (error) {
    const concurrent = await readCurrentSurface(input.store, snapshot.runId, appendEpochId);
    const replay = concurrent?.snapshots.find(
      (candidate) => candidate.sourceStepSequence === snapshot.sourceStepSequence,
    );
    if (
      concurrent === undefined ||
      replay === undefined ||
      replay.anchorMessageSequence !== snapshot.anchorMessageSequence ||
      replay.contentHash !== snapshot.contentHash
    ) {
      throw new PromptSurfaceIntegrityError("Prompt Surface snapshot could not be committed.", {
        cause: error,
      });
    }
    surface = concurrent;
  }
  if (surface === undefined) {
    throw new PromptSurfaceIntegrityError("Prompt Surface snapshot commit returned no surface.");
  }
  try {
    assertPromptSurfaceEpochWithSnapshots(surface);
  } catch (error) {
    throw new PromptSurfaceIntegrityError("Committed Prompt Surface failed integrity checks.", {
      cause: error,
    });
  }
  return preparedSurface(surface, input);
}

function preparePreviewSurface(
  input: PromptSurfacePreparationInput,
  identity: ReturnType<typeof promptSurfaceIdentity>,
): PromptSurfacePreparationResult {
  const epoch = createPromptSurfaceEpoch({
    runId: input.contextInput.identity.runId,
    epochId: `preview-${input.contextInput.turn.sequence}-${randomUUID()}`,
    modelRef: input.contextInput.model.ref,
    stableHeadFingerprint: identity.stableHeadFingerprint,
    toolSchemaFingerprint: identity.toolSchemaFingerprint,
    cacheSettingsFingerprint: identity.cacheSettingsFingerprint,
    resetReason: "COMPACTION_COMMITTED",
    createdStepSequence: input.contextInput.turn.sequence,
    createdAt: input.clock.now(),
  });
  const content = renderRuntimeContextSnapshot(input.document);
  const snapshots =
    content === undefined
      ? []
      : [
          createPromptSurfaceSnapshot({
            runId: epoch.runId,
            epochId: epoch.epochId,
            ordinal: 1,
            anchorMessageSequence: latestCompletePromptSurfaceAnchor(input.conversationMessages),
            sourceStepSequence: input.contextInput.turn.sequence,
            kind: "RUNTIME_CONTEXT_SNAPSHOT",
            content,
            createdAt: input.clock.now(),
          }),
        ];
  return preparedSurface({ ...epoch, snapshots }, input, false);
}

/** Reconstruct the request surface without creating epochs or appending snapshots. */
async function preparePromptSurfaceReplay(
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
  if (
    current === undefined ||
    !promptSurfaceReplayIdentityMatches({
      current,
      model: input.contextInput.model,
      identity,
    })
  ) {
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
    !promptSurfaceAnchorsAreAvailable(
      input.conversationMessages,
      surface.snapshots.map((snapshot) => snapshot.anchorMessageSequence),
    )
  ) {
    return preparePreviewSurface(input, identity);
  }

  const currentStepSnapshot = surface.snapshots.find(
    (snapshot) => snapshot.sourceStepSequence === input.contextInput.turn.sequence,
  );
  if (currentStepSnapshot !== undefined) {
    if (surface.snapshots.at(-1)?.sourceStepSequence !== input.contextInput.turn.sequence) {
      throw new PromptSurfaceIntegrityError("Prompt Surface retry is not the latest durable Step.");
    }
    return preparedSurface(surface, input, true);
  }
  if (
    surface.snapshots.some(
      (snapshot) => snapshot.sourceStepSequence > input.contextInput.turn.sequence,
    ) ||
    input.contextInput.turn.sequence < surface.createdStepSequence
  ) {
    throw new PromptSurfaceIntegrityError(
      "Prompt Surface Step order is incompatible with recovery.",
    );
  }

  const lastSnapshot = surface.snapshots.at(-1);
  let content = renderRuntimeContextSnapshot(input.document);
  if (content === undefined) {
    if (lastSnapshot === undefined || isClearedSnapshot(lastSnapshot.content)) {
      return preparedSurface(surface, input, true);
    }
    content = CLEARED_RUNTIME_CONTEXT_SNAPSHOT;
  } else if (lastSnapshot?.content === content) {
    return preparedSurface(surface, input, true);
  }

  const anchorMessageSequence = latestCompletePromptSurfaceAnchor(input.conversationMessages);
  if (lastSnapshot !== undefined && anchorMessageSequence < lastSnapshot.anchorMessageSequence) {
    throw new PromptSurfaceIntegrityError("Prompt Surface anchor would move backwards.");
  }
  const snapshot = createPromptSurfaceSnapshot({
    runId: surface.runId,
    epochId: surface.epochId,
    ordinal: surface.snapshots.length + 1,
    anchorMessageSequence,
    sourceStepSequence: input.contextInput.turn.sequence,
    kind: "RUNTIME_CONTEXT_SNAPSHOT",
    content,
    createdAt: input.clock.now(),
  });
  surface = Object.freeze({
    ...surface,
    snapshots: Object.freeze([...surface.snapshots, snapshot]),
  });
  try {
    assertPromptSurfaceEpochWithSnapshots(surface);
  } catch (error) {
    throw new PromptSurfaceIntegrityError("Replay Prompt Surface failed integrity checks.", {
      cause: error,
    });
  }
  return preparedSurface(surface, input, true);
}

interface PromptSurfaceIdentity {
  readonly stableHeadFingerprint: string;
  readonly toolSchemaFingerprint: string;
  readonly cacheSettingsFingerprint: string;
}

function promptSurfaceIdentity(input: PromptSurfacePreparationInput): PromptSurfaceIdentity {
  return {
    stableHeadFingerprint: promptSurfaceStableHeadFingerprint({
      stableHead: renderStableContextHead(input.document),
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
    left.createdStepSequence === right.createdStepSequence &&
    left.resetReason === right.resetReason &&
    left.modelRef.provider === right.modelRef.provider &&
    left.modelRef.model === right.modelRef.model &&
    left.stableHeadFingerprint === right.stableHeadFingerprint &&
    left.toolSchemaFingerprint === right.toolSchemaFingerprint &&
    left.cacheSettingsFingerprint === right.cacheSettingsFingerprint
  );
}

function preparedSurface(
  surface: PromptSurfaceEpochWithSnapshots,
  input: PromptSurfacePreparationInput,
  replayEligible = true,
): PromptSurfacePreparationResult {
  assertPromptSurfaceEpochWithSnapshots(surface);
  const stableHead = renderStableContextHead(input.document);
  const stableHeadTokens = estimatePromptSurfaceTokens(
    input.tokenEstimator.estimateText(stableHead, input.contextInput.model),
    "stable head",
  );
  const snapshotTokens = surface.snapshots.reduce(
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
      stableHeadFingerprint: surface.stableHeadFingerprint,
      toolSchemaFingerprint: surface.toolSchemaFingerprint,
      cacheSettingsFingerprint: surface.cacheSettingsFingerprint,
      snapshots: surface.snapshots.map((snapshot) => ({
        ordinal: snapshot.ordinal,
        anchorMessageSequence: snapshot.anchorMessageSequence,
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

function promptSurfaceEpochOnly(surface: PromptSurfaceEpochWithSnapshots): PromptSurfaceEpoch {
  return {
    runId: surface.runId,
    epochId: surface.epochId,
    modelRef: surface.modelRef,
    stableHeadFingerprint: surface.stableHeadFingerprint,
    toolSchemaFingerprint: surface.toolSchemaFingerprint,
    cacheSettingsFingerprint: surface.cacheSettingsFingerprint,
    resetReason: surface.resetReason,
    createdStepSequence: surface.createdStepSequence,
    createdAt: surface.createdAt,
  };
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

function isClearedSnapshot(content: string): boolean {
  return content.startsWith('<runtime_context_snapshot state="CLEARED">');
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
