import type { ModelRef } from "@caelush/ai";

import type { ContextPrepareMode } from "../contracts/context-engine.js";
import type { ContextFingerprint } from "../contracts/context-fingerprint.js";
import type { ContextCheckpointRef, ContextCompactionReason } from "../compaction/context-compaction-contracts.js";
import type {
  ContextBudgetSnapshot,
  ContextPressureState,
} from "../policy/context-policy.js";
import type { ContextItemId, ContextSourceId } from "../item/context-item.js";
import type { ContextBuildContribution } from "../../loop/types.js";

export type ContextContributionReport = ContextBuildContribution;

export interface ContextSourceReceipt {
  readonly providerId: ContextSourceId;
  readonly providerVersion: string;
  readonly selectedItemIds: readonly ContextItemId[];
  readonly droppedItemIds: readonly ContextItemId[];
  readonly deferredItemIds: readonly ContextItemId[];
}

export interface ContextCompactionReceipt {
  readonly reason: ContextCompactionReason;
  readonly checkpoint: ContextCheckpointRef;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly degraded: boolean;
}

export interface ContextBuildReceipt {
  readonly contextFingerprint: ContextFingerprint;
  readonly mode: ContextPrepareMode;
  readonly modelRef: ModelRef;
  readonly policyFingerprint: string;
  readonly sources: readonly ContextSourceReceipt[];
  readonly budget: ContextBudgetSnapshot;
  readonly pressure: ContextPressureState;
  readonly checkpoint?: ContextCheckpointRef;
  readonly compaction?: ContextCompactionReceipt;
  readonly toolSchemaTokens: number;
  readonly materializedTokens: number;
}
