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
import type { ContextCompactionCommitPort } from "../ports/context-compaction-commit-port.js";
import { prepareContextCompactionCandidates } from "../compaction/context-compaction-coverage.js";
import type { ContextSummarizationRunner } from "../compaction/context-summary.js";
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
  const rehydrator = options.rehydrator ?? createContextRehydrator();
  const documentBuilder = options.documentBuilder ?? createContextDocumentBuilder();
  const summarizationRunner = options.summarizationRunner;
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
        ...(input.mode === "FORCED_RECOVERY"
          ? { options: { ...options.policy, ...options.forcedPolicy } }
          : options.policy === undefined
            ? {}
            : { options: options.policy }),
      });
      throwIfAborted(input.signal);

      const latestCheckpoint = await options.checkpointRepository.getLatestByRun(
        input.identity.runId,
      );
      throwIfAborted(input.signal);
      const sourceInput = {
        ...input,
        policy,
      };
      const collected = await collectContextSources(options.sourceRegistry, sourceInput);
      const coverage = prepareContextCompactionCandidates({
        history: historyIndexer.index({ conversation: input.conversation, model: input.model }),
        ...(latestCheckpoint === undefined ? {} : { latestCheckpoint }),
      });
      const sourceResults = removeCoveredConversationMessages(collected, latestCheckpoint);
      const initialPlan = planner.plan({
        items: sourceResults.flatMap((result) => result.items),
        policy,
        history: coverage.history,
        currentTurnId: input.conversation.currentTurnId,
        sourcePriorities: sourcePriorityMap(options.sourceRegistry),
      });
      const authorities = await options.authorityProvider.snapshot({
        identity: input.identity,
        signal: input.signal,
      });
      throwIfAborted(input.signal);

      let activeCheckpoint = latestCheckpoint;
      let activeCoverage = coverage;
      let activeSources = sourceResults;
      let compactionReceipt;
      let compactionCount = 0;
      const shouldCompact =
        initialPlan.requiresCompaction ||
        initialPlan.pressure === "PROACTIVE" ||
        initialPlan.pressure === "EMERGENCY" ||
        activeCoverage.history.estimatedTokens > policy.targetRecentTailTokens ||
        input.mode === "FORCED_RECOVERY";
      if (shouldCompact) {
        const reason: ContextCompactionReason =
          input.mode === "FORCED_RECOVERY"
            ? "FORCED_PROVIDER_OVERFLOW"
            : initialPlan.requiresCompaction
              ? "SELECTION_PRESSURE"
              : "PROACTIVE_PRESSURE";
        const compactionPlan = compactionPlanner.plan({
          history: activeCoverage.history,
          policy,
          reason,
        });
        if (compactionPlan !== null) {
          if (summarizationRunner === undefined) throw new ContextExhaustedError();
          const sourceMessages = messagesInRange(input.conversation, compactionPlan);
          const summary = await summarizationRunner.summarize(
            {
              identity: input.identity,
              reason,
              ...(activeCoverage.previousCheckpoint === undefined
                ? {}
                : { previousCheckpoint: activeCoverage.previousCheckpoint }),
              sourceMessages,
              sourceRange: compactionPlan.sourceRange,
              authorities,
              targetTokens: compactionPlan.targetRecentTailTokens,
              model: input.model,
            },
            { signal: input.signal },
          );
          const checkpointInput = {
            checkpointId: createContextCheckpointId(requireCheckpointId(options)),
            runId: input.identity.runId,
            ...(activeCoverage.trustedPreviousCheckpointId === undefined
              ? {}
              : { previousCheckpointId: activeCoverage.trustedPreviousCheckpointId }),
            sourceRange: compactionPlan.sourceRange,
            structuredCheckpoint: summary.result.checkpoint,
            tokensBefore: compactionPlan.estimatedTokensBefore,
            tokensAfter: Math.max(
              0,
              compactionPlan.estimatedTokensBefore - compactionPlan.selectedTokens,
            ),
            modelRef: summary.result.modelRef,
            summaryPromptVersion: summary.result.summaryPromptVersion,
            sourceDigest: summary.result.sourceDigest,
            checkpointDigest: summary.result.checkpointDigest,
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
          activeCoverage = prepareContextCompactionCandidates({
            history: activeCoverage.history,
            latestCheckpoint: committed.checkpoint,
          });
          activeSources = withActiveCheckpoint(
            removeCoveredConversationMessages(activeSources, committed.checkpoint),
            committed.checkpoint,
          );
          compactionCount = 1;
          compactionReceipt = {
            reason,
            checkpoint: checkpointRef(committed.checkpoint),
            tokensBefore: compactionPlan.estimatedTokensBefore,
            tokensAfter: committed.checkpoint.tokensAfter,
            degraded: summary.degraded,
          } as const;
        }
      }

      const finalPlan = planner.plan({
        items: activeSources.flatMap((result) => result.items),
        policy,
        history: activeCoverage.history,
        currentTurnId: input.conversation.currentTurnId,
        sourcePriorities: sourcePriorityMap(options.sourceRegistry),
      });
      const rehydrated = await rehydrator.rehydrate({
        ...(activeCheckpoint === undefined
          ? {}
          : { checkpoint: activeCheckpoint.structuredCheckpoint }),
        authorities,
      });
      const document = documentBuilder.build({ plan: finalPlan, rehydrated });
      const selectedMessages = selectedConversationMessages(finalPlan);
      const provisional = receiptBuilder.build({
        identity: input.identity,
        turn: input.turn,
        input: input.input,
        mode: input.mode,
        model: input.model,
        tools: input.tools,
        policy,
        sourceResults: activeSources,
        plan: finalPlan,
        conversationMessages: selectedMessages,
        materializedMessages: [],
        ...checkpointReference(activeCheckpoint),
        ...(compactionReceipt === undefined ? {} : { compaction: compactionReceipt }),
        compactionCount,
        ...(compactionCount === 0 ? {} : { lastCompactionAt: options.clock.now() }),
      });
      const materialized = await options.materializer.materialize({
        prepared: {
          conversationMessages: selectedMessages,
          document,
          plan: finalPlan,
          receipt: provisional.receipt,
          observationPolicy: policy.observationPolicy,
          ...checkpointReference(activeCheckpoint),
          contextFingerprint: provisional.contextFingerprint,
        },
        model: input.model,
        signal: input.signal,
      });
      const audit = receiptBuilder.build({
        identity: input.identity,
        turn: input.turn,
        input: input.input,
        mode: input.mode,
        model: input.model,
        tools: input.tools,
        policy,
        sourceResults: activeSources,
        plan: finalPlan,
        conversationMessages: selectedMessages,
        materializedMessages: materialized,
        ...checkpointReference(activeCheckpoint),
        ...(compactionReceipt === undefined ? {} : { compaction: compactionReceipt }),
        compactionCount,
        ...(compactionCount === 0 ? {} : { lastCompactionAt: options.clock.now() }),
      });
      if (audit.report.estimatedInputTokens > policy.effectiveInputLimitTokens) {
        throw new ContextExhaustedError();
      }
      await options.usageStore.upsert(audit.usage);
      throwIfAborted(input.signal);
      return Object.freeze({
        messages: materialized,
        report: audit.report,
        observationPolicy: policy.observationPolicy,
        ...checkpointReference(activeCheckpoint),
        contextFingerprint: audit.contextFingerprint,
      });
    },
  });
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

function checkpointRef(record: ContextCheckpointRecordV2): ContextCheckpointRef {
  return Object.freeze({
    checkpointId: record.checkpointId,
    schemaVersion: 2,
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

function messagesInRange(
  conversation: ContextPrepareInput["conversation"],
  plan: ContextCompactionPlan,
): readonly StoredAgentMessage[] {
  const range = plan.sourceRange;
  const messages = conversation.turns.flatMap((turn) => turn.messages);
  return Object.freeze(
    messages
      .filter(
        (stored) =>
          stored.message.runId === range.runId &&
          stored.message.conversationTurnId === range.conversationTurnId &&
          stored.sequence >= range.firstSequence &&
          stored.sequence <= range.lastSequence,
      )
      .sort((left, right) => left.sequence - right.sequence),
  );
}

function removeCoveredConversationMessages(
  results: readonly ContextSourceCollectionResult[],
  checkpoint: ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1 | undefined,
): readonly ContextSourceResult[] {
  if (checkpoint === undefined) return Object.freeze([...results]);
  const runId = checkpoint.runId;
  const turnId =
    checkpoint.schemaVersion === 2 ? checkpoint.sourceRange.conversationTurnId : undefined;
  const from =
    checkpoint.schemaVersion === 2
      ? checkpoint.sourceRange.firstSequence
      : checkpoint.sourceSequenceFrom;
  const to =
    checkpoint.schemaVersion === 2
      ? checkpoint.sourceRange.lastSequence
      : checkpoint.sourceSequenceTo;
  return Object.freeze(
    results.map((result) => {
      if (result.providerId !== AGENT_CONTEXT_SOURCE_IDS.conversation) return result;
      const items = result.items.filter((item) => {
        if (item.payload.kind !== "AGENT_MESSAGE") return true;
        const message = item.payload.message;
        return !(
          message.message.runId === runId &&
          (turnId === undefined || message.message.conversationTurnId === turnId) &&
          message.sequence >= from &&
          message.sequence <= to
        );
      });
      return Object.freeze({ ...result, items: Object.freeze(items) });
    }),
  );
}

function withActiveCheckpoint(
  results: readonly ContextSourceResult[],
  checkpoint: ContextCheckpointRecordV2,
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
