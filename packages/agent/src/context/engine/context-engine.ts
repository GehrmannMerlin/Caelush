import type { AIMessage } from "@caelush/ai";
import type { EventId, TimestampMs } from "@caelush/protocol";

import type { RunEventNotifierPort } from "../../events/notifier-port.js";
import type { DurableRunEventDraft } from "../../events/durable-run-event-draft.js";
import type { PreparedModelContext } from "../../loop/types.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { ContextPrepareInput, ContextEnginePort } from "../contracts/context-engine.js";
import {
  createContextCheckpointId,
  type ContextCompactionPlan,
  type ContextCompactionReason,
  type ContextCheckpointRecordV2,
  type ContextCheckpointRepositoryPort,
  type LegacyContextCheckpointRecordV1,
} from "../compaction/context-compaction-contracts.js";
import { createContextCompactionPlanner } from "../compaction/context-compaction-planner.js";
import { createContextPressureEvaluator } from "../compaction/context-pressure-evaluator.js";
import type { ContextCompactionCommitPort } from "../ports/context-compaction-commit-port.js";
import type { ContextSummarizationRunner } from "../compaction/context-summary.js";
import {
  createContextCheckpointEnricher,
  type ContextCheckpointEnricher,
} from "../compaction/checkpoint-enricher.js";
import { createContextCompactionDigestBuilder } from "../compaction/context-compaction-digest.js";
import {
  createContextCompactionRebuilder,
  type ContextCompactionRebuildResult,
} from "../compaction/context-compaction-rebuilder.js";
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
  ContextCheckpointBudgetUnavailableError,
  type ContextCheckpointBudget,
  type ContextCheckpointBudgetResolver,
} from "../compaction/checkpoint-budget.js";
import {
  createContextCompactionGainEvaluator,
  isMeaningfulContextCompactionGain,
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
  readonly forcedPolicy?: ContextPolicyOptions;
  readonly tokenEstimator?: ContextTokenEstimatorPort;
  readonly requestOverheadEstimator?: ContextRequestOverheadEstimatorPort;
  readonly historyIndexer?: ContextHistoryIndexer;
  readonly planner?: ContextPlanner;
  readonly compactionPlanner?: ReturnType<typeof createContextCompactionPlanner>;
  readonly summarizationRunner?: ContextSummarizationRunner;
  readonly deterministicFactsProvider?: DeterministicCompactionFactsProvider;
  readonly checkpointBuilder?: DeterministicCheckpointBuilder;
  readonly checkpointEnricher?: ContextCheckpointEnricher;
  readonly incrementalCheckpointResolver?: IncrementalCheckpointResolver;
  readonly incrementalCompactionResolver?: ContextIncrementalCompactionResolver;
  readonly checkpointBudgetResolver?: ContextCheckpointBudgetResolver;
  readonly compactionGainEvaluator?: ContextCompactionGainEvaluator;
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
  const pressureEvaluator = createContextPressureEvaluator();
  const rehydrator = options.rehydrator ?? createContextRehydrator();
  const documentBuilder = options.documentBuilder ?? createContextDocumentBuilder();
  const summarizationRunner = options.summarizationRunner;
  const deterministicFactsProvider = options.deterministicFactsProvider;
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
  const compactionDigestBuilder = createContextCompactionDigestBuilder();

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
        ...(input.mode === "FORCED_RECOVERY"
          ? { options: { ...options.policy, ...options.forcedPolicy } }
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
      const shouldCompact = pressure.shouldCompact;
      if (shouldCompact) {
        const reason: ContextCompactionReason =
          pressure.trigger === "FORCED_PROVIDER_OVERFLOW"
            ? "FORCED_PROVIDER_OVERFLOW"
            : pressure.trigger === "SELECTION_PRESSURE"
              ? "SELECTION_PRESSURE"
              : "PROACTIVE_PRESSURE";
        const compactionPlan = compactionPlanner.plan({
          history: activeCoverage.history,
          policy,
          reason,
        });
        if (compactionPlan !== null) {
          let checkpointBudget: ContextCheckpointBudget | undefined;
          try {
            checkpointBudget = checkpointBudgetResolver.resolve({
              policy,
              plan: compactionPlan,
            });
          } catch (error) {
            if (!(error instanceof ContextCheckpointBudgetUnavailableError)) throw error;
          }
          if (checkpointBudget !== undefined) {
            const gain = compactionGainEvaluator.evaluate({
              plan: compactionPlan,
              checkpointBudget,
            });
            if (isMeaningfulContextCompactionGain(gain)) {
              if (summarizationRunner === undefined) throw new ContextExhaustedError();
              const incremental = incrementalCompactionResolver.resolve({
                plan: compactionPlan,
                latest: latestState,
                conversation: input.conversation,
              });
              const summary = await summarizationRunner.summarize(
                {
                  identity: input.identity,
                  reason,
                  ...(activeCoverage.previousCheckpoint === undefined
                    ? {}
                    : { previousCheckpoint: activeCoverage.previousCheckpoint }),
                  sourceMessages: incremental.newSourceMessages,
                  sourceRange: incremental.cumulativeSourceRange,
                  cut: compactionPlan.cut,
                  targetTokens: checkpointBudget.targetTokens,
                  model: input.model,
                },
                { signal: input.signal },
              );
              throwIfAborted(input.signal);
              if (deterministicFactsProvider === undefined) throw new ContextExhaustedError();
              const facts = await deterministicFactsProvider.collect({
                identity: input.identity,
                sourceRange: incremental.cumulativeSourceRange,
                signal: input.signal,
              });
              throwIfAborted(input.signal);
              const structuredCheckpoint =
                summary.kind === "ACCEPTED"
                  ? checkpointEnricher.enrich({
                      semantic: summary.result.semantic,
                      facts,
                      sourceRange: incremental.cumulativeSourceRange,
                    })
                  : checkpointBuilder.build({
                      goal: input.identity.goal,
                      sourceRange: incremental.cumulativeSourceRange,
                      facts,
                      ...(activeCoverage.previousCheckpoint === undefined
                        ? {}
                        : { previousCheckpoint: activeCoverage.previousCheckpoint }),
                    });
              const summaryModelRef =
                summary.kind === "ACCEPTED" ? summary.result.modelRef : summary.modelRef;
              const summaryPromptVersion =
                summary.kind === "ACCEPTED"
                  ? summary.result.summaryPromptVersion
                  : summary.summaryPromptVersion;
              const sourceDigest =
                summary.kind === "ACCEPTED" ? summary.result.sourceDigest : summary.sourceDigest;
              const candidateCheckpointId = createContextCheckpointId(requireCheckpointId(options));
              const durableSourceDigest = compactionDigestBuilder.source({
                semanticSourceDigest: sourceDigest,
                ...(incremental.previousCheckpoint === undefined
                  ? {}
                  : { previousCheckpoint: incremental.previousCheckpoint }),
                newSourceMessages: incremental.newSourceMessages,
                newSourceRange: incremental.newSourceRange,
                cumulativeSourceRange: incremental.cumulativeSourceRange,
              });
              const checkpointDigest = compactionDigestBuilder.checkpoint({
                structuredCheckpoint,
                sourceRange: incremental.cumulativeSourceRange,
              });
              const tentativeAuthorities = await options.authorityProvider.snapshot({
                identity: input.identity,
                signal: input.signal,
              });
              throwIfAborted(input.signal);
              const candidateCheckpoint: ActiveCheckpointProjection = {
                checkpointId: candidateCheckpointId,
                structuredCheckpoint,
                sourceRange: incremental.cumulativeSourceRange,
                degraded: summary.degraded,
              };
              const candidateCoverage = createContextCompactionCoverageForRange({
                history,
                sourceRange: incremental.cumulativeSourceRange,
              });
              const candidateSources = withActiveCheckpointProjection(
                removeCoveredConversationMessages(collected, candidateCoverage.coveredMessageIds),
                candidateCheckpoint,
              );
              const rebuilder = createContextCompactionRebuilder({
                async build(rebuildInput) {
                  const projection = await buildPreparedProjectionWithoutCompaction({
                    contextInput: input,
                    policy: rebuildInput.policy,
                    sourceResults: candidateSources,
                    activeCoverage: candidateCoverage,
                    activeCheckpoint: candidateCheckpoint,
                    authorities: tentativeAuthorities,
                    planner,
                    sourcePriorities: sourcePriorityMap(options.sourceRegistry),
                    rehydrator,
                    documentBuilder,
                    materializer: options.materializer,
                    receiptBuilder,
                    compactionCount: 0,
                  });
                  return {
                    estimatedInputTokens: projection.audit.report.estimatedInputTokens,
                    retainedMessageIds: projection.selectedMessages.map(
                      (message) => message.message.id,
                    ),
                  } satisfies ContextCompactionRebuildResult;
                },
              });
              const rebuild = await rebuilder.rebuild({
                conversation: input.conversation,
                checkpoint: structuredCheckpoint,
                sourceRange: incremental.cumulativeSourceRange,
                policy,
                model: input.model,
              });
              throwIfAborted(input.signal);
              if (rebuild.estimatedInputTokens <= policy.effectiveInputLimitTokens) {
                const checkpointInput = {
                  checkpointId: candidateCheckpointId,
                  runId: input.identity.runId,
                  ...(incremental.previousCheckpoint === undefined
                    ? {}
                    : { previousCheckpointId: incremental.previousCheckpoint.checkpointId }),
                  sourceRange: incremental.cumulativeSourceRange,
                  structuredCheckpoint,
                  tokensBefore: compactionPlan.estimatedTokensBefore,
                  tokensAfter: rebuild.estimatedInputTokens,
                  modelRef: summaryModelRef,
                  summaryPromptVersion,
                  sourceDigest: durableSourceDigest,
                  checkpointDigest,
                  degraded: summary.degraded,
                  reason,
                  createdAt: options.clock.now(),
                } as const;
                const committed = await commitCompaction(options, {
                  checkpoint: checkpointInput,
                  input,
                  reason,
                  compactionPlan,
                  degraded: summary.degraded,
                });
                activeCheckpoint = committed.checkpoint;
                activeCoverage = createContextCompactionCoverage({
                  history,
                  latestCheckpoint: committed.checkpoint,
                });
                activeSources = withActiveCheckpoint(
                  removeCoveredConversationMessages(collected, activeCoverage.coveredMessageIds),
                  committed.checkpoint,
                );
                compactionCount = 1;
                compactionReceipt = {
                  reason,
                  checkpoint: checkpointRef(committed.checkpoint),
                  tokensBefore: compactionPlan.estimatedTokensBefore,
                  tokensAfter: committed.checkpoint.tokensAfter,
                  degraded: summary.degraded,
                };
              }
            }
          }
        }
      }

      const authorities = await options.authorityProvider.snapshot({
        identity: input.identity,
        signal: input.signal,
      });
      throwIfAborted(input.signal);
      const finalProjection = await buildPreparedProjectionWithoutCompaction({
        contextInput: input,
        policy,
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
        ...(compactionReceipt === undefined ? {} : { compactionReceipt }),
        compactionCount,
        ...(compactionCount === 0 ? {} : { lastCompactionAt: options.clock.now() }),
      });
      if (finalProjection.audit.report.estimatedInputTokens > policy.effectiveInputLimitTokens) {
        throw new ContextExhaustedError();
      }
      await options.usageStore.upsert(
        input.mode === "FORCED_RECOVERY"
          ? {
              ...finalProjection.audit.usage,
              lastRecoveryStages: ["REPROJECT_OPEN_OBSERVATIONS_EMERGENCY"],
            }
          : finalProjection.audit.usage,
      );
      throwIfAborted(input.signal);
      return Object.freeze({
        messages: finalProjection.materializedMessages,
        report: finalProjection.audit.report,
        observationPolicy: policy.observationPolicy,
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
  readonly compactionReceipt?: ContextCompactionReceipt;
  readonly compactionCount: number;
  readonly lastCompactionAt?: TimestampMs;
}): Promise<ContextBuildProjection> {
  throwIfAborted(input.contextInput.signal);
  const plan = input.planner.plan({
    items: input.sourceResults.flatMap((result) => result.items),
    policy: input.policy,
    history: input.activeCoverage.history,
    currentTurnId: input.contextInput.conversation.currentTurnId,
    sourcePriorities: input.sourcePriorities,
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

async function commitCompaction(
  options: V2ContextEngineOptions,
  input: {
    readonly checkpoint: Parameters<ContextCompactionCommitPort["commit"]>[0]["checkpoint"];
    readonly input: ContextPrepareInput;
    readonly reason: ContextCompactionReason;
    readonly compactionPlan: ContextCompactionPlan;
    readonly degraded: boolean;
  },
): Promise<{
  readonly checkpoint: ContextCheckpointRecordV2;
  readonly events: readonly import("@caelush/protocol").DurableRunEvent[];
}> {
  if (options.compactionCommit === undefined || options.compactionEvents === undefined) {
    throw new ContextExhaustedError();
  }
  const eventIdFactory = options.eventIdFactory;
  if (eventIdFactory === undefined) throw new ContextExhaustedError();
  const committed = await options.compactionCommit.commit({
    checkpoint: input.checkpoint,
    events: [
      options.compactionEvents.completed({
        identity: input.input.identity,
        turn: input.input.turn,
        checkpoint: input.checkpoint,
        reason: input.reason,
        tokensBefore: input.compactionPlan.estimatedTokensBefore,
        tokensAfter: input.checkpoint.tokensAfter,
        degraded: input.degraded,
        eventId: eventIdFactory.create(),
        timestamp: options.clock.now(),
      }),
    ],
  });
  if (committed.events.length > 0) options.notifier?.notifyCommitted(committed.events);
  return committed;
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
