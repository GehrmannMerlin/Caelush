import type { ContextCheckpointRef, ToolObservationPolicySnapshot } from "../../loop/types.js";
import type { StoredAgentMessage } from "../../messages/index.js";
import type { ContextDocument } from "../document/context-document.js";
import type { ContextItem } from "../item/context-item.js";
import type { ContextPlan } from "../policy/context-policy.js";
import type { ContextFingerprint } from "./context-fingerprint.js";

/** Opaque foundation placeholder; receipt construction/persistence starts in Phase 7E. */
export type ContextBuildReceipt = Readonly<Record<string, unknown>>;

export interface PreparedAgentContext {
  readonly conversationMessages: readonly StoredAgentMessage[];
  readonly document: ContextDocument;
  readonly plan: ContextPlan;
  readonly receipt: ContextBuildReceipt;
  readonly observationPolicy: ToolObservationPolicySnapshot;
  readonly checkpoint?: ContextCheckpointRef;
  readonly contextFingerprint: ContextFingerprint;
}

export type { ContextItem };
export type { ContextDocument } from "../document/context-document.js";
