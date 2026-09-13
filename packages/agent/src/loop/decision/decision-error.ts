import type { AIFinishReason } from "@caelush/ai";

/**
 * A model turn that the agent kernel refuses to act on.
 *
 * The classifier throws this rather than returning a decision, because every reason is
 * a *contract* violation of the turn: a truncated turn, a filtered turn, an
 * unrecognised finish reason, duplicated tool-call identity, or an empty response. None
 * of them may become a Tool request, and none of them may become a final candidate.
 *
 * `metadata` carries only safe structural facts. It never carries assistant text, tool
 * arguments, a provider body, a prompt or a credential.
 */
export type AgentModelOutputErrorReason =
  | "INVALID_TURN_RESULT"
  | "MODEL_IDENTITY_MISMATCH"
  | "OUTPUT_TRUNCATED"
  | "CONTENT_FILTERED"
  | "EMPTY_RESPONSE"
  | "MISSING_TOOL_CALLS"
  | "DUPLICATE_TOOL_CALL_ID"
  /**
   * The provider reported a finish reason the AI core could not interpret, so the turn
   * became `AIFinishReason.OTHER`.
   *
   * `OTHER` is never evidence that the model finished its answer: an unrecognised
   * provider reason could mean anything, including a truncated or aborted stream. It is
   * rejected rather than treated as a normal stop, and `OTHER → FINAL_CANDIDATE` is a
   * regression this reason exists to make impossible.
   */
  | "UNKNOWN_FINISH_REASON";

/** Safe structural metadata about a rejected turn. */
export interface AgentModelOutputMetadata {
  readonly callId?: string;
  readonly providerId?: string;
  readonly model?: import("@caelush/ai").ModelDescriptor["ref"];
  readonly finishReason?: AIFinishReason;
  readonly toolCallCount?: number;
}

/** The frozen rejection of one model turn. */
export class AgentModelOutputError extends Error {
  readonly reason: AgentModelOutputErrorReason;
  readonly metadata: AgentModelOutputMetadata;

  constructor(reason: AgentModelOutputErrorReason, metadata: AgentModelOutputMetadata = {}) {
    super(`Agent model output rejected: ${reason}.`);
    this.name = "AgentModelOutputError";
    this.reason = reason;
    this.metadata = metadata;
  }
}
