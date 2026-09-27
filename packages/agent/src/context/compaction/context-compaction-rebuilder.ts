import type { ModelDescriptor } from "@caelush/ai";

import type { AgentConversationSnapshot } from "../../messages/conversation/conversation-snapshot.js";
import type { AgentMessageId } from "../../messages/types/ids.js";
import type { StructuredCheckpoint } from "../checkpoint/structured-checkpoint.js";
import type { ContextPolicy } from "../policy/context-policy.js";
import type { ContextMessageRange } from "./context-compaction-contracts.js";

/** The frozen, provider-neutral input for a tentative compaction rebuild. */
export interface ContextCompactionRebuildInput {
  readonly conversation: AgentConversationSnapshot;
  readonly checkpoint: StructuredCheckpoint;
  readonly sourceRange: ContextMessageRange;
  readonly policy: ContextPolicy;
  readonly model: ModelDescriptor;
}

/** The result of the same production build semantics used by final Context materialization. */
export interface ContextCompactionRebuildResult {
  readonly estimatedInputTokens: number;
  readonly retainedMessageIds: readonly AgentMessageId[];
}

export interface ContextCompactionRebuilder {
  rebuild(input: ContextCompactionRebuildInput): Promise<ContextCompactionRebuildResult>;
}

/**
 * The factory dependency is deliberately a private implementation seam. Hosts supply the
 * current source/authority closure and the Agent-owned production build path; the frozen public
 * input never grows host identity, tools, storage, or receipt dependencies.
 */
export interface ContextCompactionRebuilderOptions {
  build(input: ContextCompactionRebuildInput): Promise<ContextCompactionRebuildResult>;
}

export function createContextCompactionRebuilder(
  options: ContextCompactionRebuilderOptions,
): ContextCompactionRebuilder {
  return Object.freeze({
    async rebuild(input: ContextCompactionRebuildInput): Promise<ContextCompactionRebuildResult> {
      const result = await options.build(input);
      if (!Number.isSafeInteger(result.estimatedInputTokens) || result.estimatedInputTokens < 0) {
        throw new TypeError("Context compaction rebuild token estimate is invalid.");
      }
      if (!Array.isArray(result.retainedMessageIds)) {
        throw new TypeError("Context compaction rebuild retained IDs are invalid.");
      }
      return Object.freeze({
        estimatedInputTokens: result.estimatedInputTokens,
        retainedMessageIds: Object.freeze([...result.retainedMessageIds]),
      });
    },
  });
}
