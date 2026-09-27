import type { AIMessage } from "@caelush/ai";
import type { EventId, TimestampMs } from "@caelush/protocol";

import type { RunEventNotifierPort } from "../../events/notifier-port.js";
import type { DurableRunEventDraft } from "../../events/durable-run-event-draft.js";
import type { PreparedModelContext } from "../../loop/types.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { ContextPrepareInput, ContextEnginePort } from "../contracts/context-engine.js";
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
  ContextSummarizerPort,
} from "../compaction/context-compaction-contracts.js";
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
}

async function buildPreparedProjectionWithoutCompaction(input: {
  readonly contextInput: ContextPrepareInput;
  readonly policy: import("../policy/context-policy.js").ContextPolicy;
  readonly sourceResults: readonly ContextSourceResult[];
  readonly activeCoverage: ContextCompactionCoverage;
  readonly activeCheckpoint?: ActiveCheckpointProjection;
  readonly authorities: ContextAuthoritySnapshot;
  readonly planner: ContextPlanner;
  readonly sourcePriorities: Readonly<Record<string, number>>;
  readonly rehydrator: ContextRehydratorPort;
  readonly documentBuilder: ContextDocumentBuilder;
  readonly materializer: ContextMaterializer;
  readonly receiptBuilder: ContextReceiptBuilder;
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
  });
  return Object.freeze({ plan, selectedMessages, materializedMessages, audit });
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
