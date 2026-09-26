import type { AIMessage, AIToolSpec, ModelDescriptor } from "@caelush/ai";
import type { TimestampMs } from "@caelush/protocol";

import type {
  AgentExecutionIdentity,
  AgentTurnInput,
  AgentTurnRef,
  ContextBuildContribution,
  ContextBuildReport,
} from "../../loop/types.js";
import type { AgentConversationSnapshot } from "../../messages/conversation/conversation-snapshot.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { ContextPrepareMode } from "../contracts/context-engine.js";
import {
  buildContextFingerprint,
  type ContextFingerprint,
} from "../contracts/context-fingerprint.js";
import type { ContextPlan, ContextPolicy } from "../policy/context-policy.js";
import type { ContextSourceResult } from "../source/context-source.js";
import type {
  ContextCompactionReceipt,
  ContextBuildReceipt,
  ContextSourceReceipt,
} from "./context-build-receipt.js";
import type {
  ContextUsageSnapshot,
  ContextUsageSourceBreakdown,
} from "./context-usage.js";
import { createUtf8HeuristicTokenEstimator, type ContextTokenEstimatorPort } from "../token/context-token-estimator.js";
import type { ContextItemId } from "../item/context-item.js";

export interface ContextReceiptBuilderInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly input?: AgentTurnInput;
  readonly mode: ContextPrepareMode;
  readonly model: ModelDescriptor;
  readonly tools: readonly AIToolSpec[];
  readonly policy: ContextPolicy;
  readonly sourceResults: readonly ContextSourceResult[];
  readonly plan: ContextPlan;
  readonly conversation?: AgentConversationSnapshot;
  readonly conversationMessages: readonly StoredAgentMessage[];
  readonly materializedMessages: readonly AIMessage[];
  readonly checkpoint?: import("../compaction/context-compaction-contracts.js").ContextCheckpointRef;
  readonly compaction?: ContextCompactionReceipt;
  readonly compactionCount?: number;
  readonly lastCompactionAt?: TimestampMs;
}

export interface ContextReceiptBuilderResult {
  readonly receipt: ContextBuildReceipt;
  readonly report: ContextBuildReport;
  readonly usage: ContextUsageSnapshot;
  readonly contextFingerprint: ContextFingerprint;
}

export interface ContextReceiptBuilderOptions {
  readonly now?: () => TimestampMs;
  readonly tokenEstimator?: ContextTokenEstimatorPort;
}

export interface ContextReceiptBuilder {
  build(input: ContextReceiptBuilderInput): ContextReceiptBuilderResult;
}

export function createContextReceiptBuilder(
  options: ContextReceiptBuilderOptions = {},
): ContextReceiptBuilder {
  const tokenEstimator = options.tokenEstimator ?? createUtf8HeuristicTokenEstimator();
  const now = options.now ?? (() => Date.now() as TimestampMs);
  return Object.freeze({
    build(input: ContextReceiptBuilderInput): ContextReceiptBuilderResult {
      assertBuildFacts(input);
      const sourceReceipts = buildSourceReceipts(input.sourceResults, input.plan);
      const contextFingerprint = buildContextFingerprint({
        identity: input.identity,
        turn: input.turn,
        model: input.model,
        policy: input.policy,
        selectedItems: input.plan.selectedItems,
        conversationMessages: input.conversationMessages,
        tools: input.tools,
        ...(input.checkpoint === undefined
          ? {}
          : { checkpoint: { checkpointId: input.checkpoint.checkpointId } }),
        ...(input.input === undefined ? {} : { input: input.input }),
      });
      const materializedTokens = estimateMessages(
        input.materializedMessages,
        input.model,
        tokenEstimator,
      );
      const sources = [...sourceReceipts].sort((left, right) =>
        compareStrings(left.providerId, right.providerId),
      );
      const receipt: ContextBuildReceipt = Object.freeze({
        contextFingerprint,
        mode: input.mode,
        modelRef: Object.freeze({ ...input.model.ref }),
        policyFingerprint: policyFingerprint(input.policy),
        sources: Object.freeze(sources),
        budget: input.plan.budget,
        pressure: input.plan.pressure,
        ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
        ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
        toolSchemaTokens: input.policy.requestOverhead.toolSchemaTokens,
        materializedTokens,
      });
      const contributions = Object.freeze(
        sources.map((source) => contributionFor(source, input.sourceResults, input.plan)),
      );
      const report: ContextBuildReport = Object.freeze({
        estimatedInputTokens: materializedTokens,
        effectiveInputLimitTokens: input.policy.effectiveInputLimitTokens,
        remainingTokens: Math.max(0, input.policy.effectiveInputLimitTokens - materializedTokens),
        pressure: input.plan.pressure,
        compactionCount: input.compactionCount ?? 0,
        requestOverheadTokens: input.policy.requestOverhead.totalTokens,
        contributions,
      });
      const usage: ContextUsageSnapshot = Object.freeze({
        runId: input.identity.runId,
        modelRef: Object.freeze({ ...input.model.ref }),
        contextWindowTokens: input.policy.contextWindowTokens,
        effectiveInputLimitTokens: input.policy.effectiveInputLimitTokens,
        estimatedInputTokens: materializedTokens,
        remainingTokens: Math.max(0, input.policy.effectiveInputLimitTokens - materializedTokens),
        pressureState: input.plan.pressure,
        compactionCount: input.compactionCount ?? 0,
        ...(input.lastCompactionAt === undefined
          ? {}
          : { lastCompactionAt: input.lastCompactionAt }),
        breakdown: Object.freeze(
          sources.map((source) => breakdownFor(source, input.sourceResults, input.plan)),
        ),
        lastBuildStatus: "SUCCESS",
        contextFingerprint,
        updatedAt: now(),
      });
      return Object.freeze({ receipt, report, usage, contextFingerprint });
    },
  });
}

function buildSourceReceipts(
  results: readonly ContextSourceResult[],
  plan: ContextPlan,
): readonly ContextSourceReceipt[] {
  const seen = new Set<string>();
  return results.map((result) => {
    if (seen.has(result.providerId)) throw new TypeError("Duplicate Context source receipt provider.");
    seen.add(result.providerId);
    const itemIds = new Set(result.items.map((item) => item.id));
    const decisions = plan.decisions.filter((decision) => itemIds.has(decision.itemId));
    if (decisions.length !== itemIds.size) {
      throw new TypeError("Context plan does not reconcile a source result.");
    }
    const selectedItemIds: ContextItemId[] = [];
    const droppedItemIds: ContextItemId[] = [];
    const deferredItemIds: ContextItemId[] = [];
    for (const decision of decisions) {
      if (decision.disposition === "SELECTED") selectedItemIds.push(decision.itemId);
      else if (decision.disposition === "DROPPED") droppedItemIds.push(decision.itemId);
      else if (decision.disposition === "DEFERRED") deferredItemIds.push(decision.itemId);
      else throw new TypeError("Context receipt cannot reconcile a compacted item disposition.");
    }
    return Object.freeze({
      providerId: result.providerId,
      providerVersion: result.providerVersion,
      selectedItemIds: Object.freeze(selectedItemIds),
      droppedItemIds: Object.freeze(droppedItemIds),
      deferredItemIds: Object.freeze(deferredItemIds),
    });
  });
}

function contributionFor(
  source: ContextSourceReceipt,
  results: readonly ContextSourceResult[],
  plan: ContextPlan,
): ContextBuildContribution {
  const result = results.find((candidate) => candidate.providerId === source.providerId);
  if (result === undefined) throw new TypeError("Context source receipt has no source result.");
  const selected = new Set(source.selectedItemIds);
  return Object.freeze({
    providerId: source.providerId,
    tokenEstimate: result.items
      .filter((item) => selected.has(item.id))
      .reduce((sum, item) => sum + item.tokenEstimate, 0),
    itemCount: result.items.length,
    droppedItems: source.droppedItemIds.length,
    truncatedItems: 0,
  });
}

function breakdownFor(
  source: ContextSourceReceipt,
  results: readonly ContextSourceResult[],
  plan: ContextPlan,
): ContextUsageSourceBreakdown {
  const contribution = contributionFor(source, results, plan);
  return Object.freeze({
    sourceId: contribution.providerId,
    tokens: contribution.tokenEstimate,
    itemCount: source.selectedItemIds.length,
  });
}

function policyFingerprint(policy: ContextPolicy): string {
  return buildContextFingerprint({
    identity: { runId: "run:policy" as never, sessionId: "session:policy" as never, goal: "policy" },
    turn: { stepId: "step:policy" as never, sequence: 1 },
    model: {
      ref: { provider: "policy", model: "policy" },
      api: "policy",
      limits: { contextWindowTokens: policy.contextWindowTokens, maxOutputTokens: policy.maxOutputTokens },
      capabilities: {} as never,
      source: "CONFIGURATION",
    },
    policy,
    selectedItems: [],
    conversationMessages: [],
    tools: [],
    rendererVersion: "policy",
    materializerVersion: "policy",
  });
}

function estimateMessages(
  messages: readonly AIMessage[],
  model: ModelDescriptor,
  estimator: ContextTokenEstimatorPort,
): number {
  const text = stableJson(messages);
  const estimate = estimator.estimateText(text, model);
  if (!Number.isSafeInteger(estimate) || estimate < 0) throw new TypeError("Materialized token estimate is invalid.");
  return estimate;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertBuildFacts(input: ContextReceiptBuilderInput): void {
  if (input.plan.budget.requestOverheadTokens !== input.policy.requestOverhead.totalTokens) {
    throw new TypeError("Context plan request overhead does not match policy.");
  }
  if (input.compaction !== undefined) {
    if (input.checkpoint === undefined || input.compaction.checkpoint.checkpointId !== input.checkpoint.checkpointId) {
      throw new TypeError("Context compaction and checkpoint references do not match.");
    }
  }
  if (!Number.isSafeInteger(input.compactionCount ?? 0) || (input.compactionCount ?? 0) < 0) {
    throw new TypeError("Context compaction count is invalid.");
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
