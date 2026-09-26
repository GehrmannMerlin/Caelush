import type { ModelDescriptor, ModelRef } from "@caelush/ai";
import type { RunId, TimestampMs } from "@caelush/protocol";

import type { AgentExecutionIdentity } from "../../loop/types.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { AgentMessageId, ConversationTurnId } from "../../messages/types/ids.js";
import type { ContextHistoryIndex } from "../history/semantic-history-unit.js";
import type { ContextPolicy } from "../policy/context-policy.js";
import type { ContextAuthoritySnapshot } from "../rehydration/context-authority-contracts.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";

export type ContextCompactionReason =
  "PROACTIVE_PRESSURE" | "SELECTION_PRESSURE" | "FORCED_PROVIDER_OVERFLOW";

export const CONTEXT_COMPACTION_REASONS = [
  "PROACTIVE_PRESSURE",
  "SELECTION_PRESSURE",
  "FORCED_PROVIDER_OVERFLOW",
] as const satisfies readonly ContextCompactionReason[];

export interface ContextMessageRange {
  readonly runId: RunId;
  readonly conversationTurnId: ConversationTurnId;
  readonly firstMessageId: AgentMessageId;
  readonly lastMessageId: AgentMessageId;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export function createContextMessageRange(input: ContextMessageRange): ContextMessageRange {
  if (!input.runId || !input.conversationTurnId || !input.firstMessageId || !input.lastMessageId) {
    throw new TypeError("ContextMessageRange identities must not be empty.");
  }
  if (
    !Number.isSafeInteger(input.firstSequence) ||
    !Number.isSafeInteger(input.lastSequence) ||
    input.firstSequence < 1 ||
    input.lastSequence < input.firstSequence
  ) {
    throw new TypeError("ContextMessageRange sequences must be ordered positive integers.");
  }
  return Object.freeze({ ...input });
}

export interface ContextCompactionPlan {
  readonly reason: ContextCompactionReason;
  readonly sourceRange: ContextMessageRange;
  readonly selectedUnitIds: readonly string[];
  readonly retainedUnitIds: readonly string[];
  readonly estimatedTokensBefore: number;
  readonly selectedTokens: number;
  readonly targetRecentTailTokens: number;
}

export interface ContextCompactionPlanner {
  plan(input: {
    readonly history: ContextHistoryIndex;
    readonly policy: ContextPolicy;
    readonly reason: ContextCompactionReason;
  }): ContextCompactionPlan | null;
}

export type ContextSummaryPromptVersion = number & {
  readonly __contextSummaryPromptVersion: unique symbol;
};

export function createContextSummaryPromptVersion(value: number): ContextSummaryPromptVersion {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Context summary prompt version must be a positive safe integer.");
  }
  return value as ContextSummaryPromptVersion;
}

export interface ContextSummarizationInput {
  readonly identity: AgentExecutionIdentity;
  readonly reason: ContextCompactionReason;
  readonly previousCheckpoint?: StructuredCheckpoint;
  readonly sourceMessages: readonly StoredAgentMessage[];
  readonly sourceRange: ContextMessageRange;
  readonly authorities: ContextAuthoritySnapshot;
  readonly targetTokens: number;
  readonly model: ModelDescriptor;
}

export interface ContextSummarizationResult {
  readonly checkpoint: StructuredCheckpoint;
  readonly modelRef: ModelRef;
  readonly summaryPromptVersion: ContextSummaryPromptVersion;
  readonly sourceDigest: string;
  readonly checkpointDigest: string;
}

export interface ContextSummarizerPort {
  summarize(
    input: ContextSummarizationInput,
    options: { readonly signal: AbortSignal },
  ): Promise<ContextSummarizationResult>;
}

export type ContextCheckpointId = string & {
  readonly __contextCheckpointId: unique symbol;
};

export function createContextCheckpointId(value: string): ContextCheckpointId {
  if (value.trim().length === 0) throw new TypeError("Context checkpoint id must not be empty.");
  return value as ContextCheckpointId;
}

export interface ContextCheckpointRef {
  readonly checkpointId: ContextCheckpointId;
  readonly schemaVersion: 2;
  readonly sourceRange: ContextMessageRange;
  readonly degraded: boolean;
}

export interface ContextCheckpointRecordV2 {
  readonly checkpointId: ContextCheckpointId;
  readonly runId: RunId;
  readonly schemaVersion: 2;
  readonly previousCheckpointId?: ContextCheckpointId;
  readonly sourceRange: ContextMessageRange;
  readonly structuredCheckpoint: StructuredCheckpoint;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly modelRef: ModelRef;
  readonly summaryPromptVersion: ContextSummaryPromptVersion;
  readonly sourceDigest: string;
  readonly checkpointDigest: string;
  readonly degraded: boolean;
  readonly reason: ContextCompactionReason;
  readonly createdAt: TimestampMs;
}

export interface LegacyContextCheckpointRecordV1 {
  readonly checkpointId: string;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly previousCheckpointId?: string;
  readonly sourceSequenceFrom: number;
  readonly sourceSequenceTo: number;
  readonly structuredCheckpoint: StructuredCheckpoint;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly modelRef: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly createdAt: number;
}

export type ContextCheckpointCreateInputV2 = Omit<ContextCheckpointRecordV2, "schemaVersion">;

export interface ContextCheckpointRepositoryPort {
  create(input: ContextCheckpointCreateInputV2): Promise<ContextCheckpointRecordV2>;
  getLatestByRun(
    runId: RunId,
  ): Promise<ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1 | undefined>;
  getById(
    checkpointId: string,
  ): Promise<ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1 | undefined>;
  listByRun(
    runId: RunId,
  ): Promise<readonly (ContextCheckpointRecordV2 | LegacyContextCheckpointRecordV1)[]>;
}

export type { ContextHistoryIndex, ContextPolicy };
