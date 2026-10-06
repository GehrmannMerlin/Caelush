import type { ToolObservationPolicySnapshot } from "../../loop/types.js";
import type { ContextCheckpointRef } from "../compaction/context-compaction-contracts.js";
import type { StoredAgentMessage } from "../../messages/index.js";
import type { ContextDocument } from "../document/context-document.js";
import type { ContextItem } from "../item/context-item.js";
import type { ContextPlan } from "../policy/context-policy.js";
import type { ContextFingerprint } from "./context-fingerprint.js";

import type { ContextBuildReceipt } from "../receipts/context-build-receipt.js";
import type { ContextPromptSurfaceReceipt } from "../receipts/context-build-receipt.js";
import type { PromptSurfaceEpochWithSnapshots } from "../surface/prompt-surface.js";

/** Internal complete surface plus its safe receipt projection for one materialization. */
export interface PreparedPromptSurface {
  readonly epoch: PromptSurfaceEpochWithSnapshots;
  readonly receipt: ContextPromptSurfaceReceipt;
}

export interface PreparedAgentContext {
  readonly conversationMessages: readonly StoredAgentMessage[];
  readonly document: ContextDocument;
  readonly plan: ContextPlan;
  readonly receipt: ContextBuildReceipt;
  readonly observationPolicy: ToolObservationPolicySnapshot;
  readonly checkpoint?: ContextCheckpointRef;
  readonly contextFingerprint: ContextFingerprint;
  readonly promptSurface?: PreparedPromptSurface;
}

export type { ContextItem };
export type { ContextDocument } from "../document/context-document.js";
export type { ContextBuildReceipt } from "../receipts/context-build-receipt.js";
