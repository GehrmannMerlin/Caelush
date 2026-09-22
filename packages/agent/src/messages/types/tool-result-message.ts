import type { ObservationId } from "@caelush/protocol";

import type { ToolObservationPolicySnapshot } from "../../loop/types.js";
import type { AgentMessageBase } from "./message-base.js";

/**
 * The policy a Tool observation was projected under, plus a fingerprint of the result.
 *
 * ```text
 * policy       the observation policy that was in force
 * fingerprint  a stable digest of the projected text
 * version      this receipt envelope's version; this contract defines exactly 1
 * ```
 *
 * ## Why the policy is snapshotted rather than referenced
 *
 * A Tool result is *historical* model-visible truth: it says what the model was shown at
 * the moment the Tool settled. If the receipt merely pointed at a live policy object, a
 * later policy change would silently rewrite history — a message the model saw as
 * truncated would start claiming it was shown in full. The snapshot is taken from
 * `ToolObservationPolicySnapshot`, the Phase 3 contract, and Phase 5A creates no second
 * policy type.
 *
 * ## Why there is a fingerprint
 *
 * `projectedContent` is the truth; the fingerprint makes it checkable. Phase 5B can prove
 * that a decoded message's content matches the receipt it was stored with, so a
 * truncation applied at read time by mistake fails loudly instead of quietly changing
 * what the model is told.
 */
export interface ToolFeedbackProjectionReceipt {
  readonly policy: ToolObservationPolicySnapshot;

  readonly fingerprint: string;

  readonly version: 1;
}

/** The only receipt envelope version this contract defines. */
export const TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION = 1 as const;

/**
 * The result of one Tool call, as the model saw it.
 *
 * ```text
 * toolCallId        which call it answers
 * toolName          which Tool answered
 * observationId     the durable ToolObservation this projects
 * isError           whether the Tool reported failure
 * projectedContent  the exact text the model was shown
 * projection        the policy receipt
 * ```
 *
 * ## Two truths, and which one this is
 *
 * ```text
 * ToolObservation          execution truth      what actually happened, with structured details
 * AgentToolResultMessage   historical model-visible truth   what the model was told
 * ```
 *
 * The second is *derived from* the first at settlement time and then frozen. It is not a
 * view over the first, and nothing may recompute it: a projection that re-read the
 * observation, re-truncated it or re-applied a redaction would produce a different text
 * from the one the model was actually shown, which is precisely the fact this message
 * exists to preserve.
 *
 * `observationId` is kept for audit and for the Tool protocol linkage. It is a pointer
 * of record, never an instruction to go and look something up.
 */
export interface AgentToolResultMessage extends AgentMessageBase {
  readonly type: "TOOL_RESULT";

  readonly toolCallId: string;

  readonly toolName: string;

  readonly observationId: ObservationId;

  readonly isError: boolean;

  readonly projectedContent: string;

  readonly projection: ToolFeedbackProjectionReceipt;
}

/** Create a frozen Tool result message. */
export function createAgentToolResultMessage(
  base: AgentMessageBase,
  input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly observationId: ObservationId;
    readonly isError: boolean;
    readonly projectedContent: string;
    readonly projection: ToolFeedbackProjectionReceipt;
  },
): AgentToolResultMessage {
  if (input.toolCallId.length === 0) {
    throw new TypeError("Agent tool result message toolCallId must be a non-empty string.");
  }
  if (input.toolName.length === 0) {
    throw new TypeError("Agent tool result message toolName must be a non-empty string.");
  }
  if (typeof input.isError !== "boolean") {
    throw new TypeError("Agent tool result message isError must be a boolean.");
  }
  if (typeof input.projectedContent !== "string") {
    throw new TypeError("Agent tool result message projectedContent must be a string.");
  }
  if (input.projection.version !== TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION) {
    throw new TypeError(
      `Agent tool result projection version must be ${String(TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION)}.`,
    );
  }
  return Object.freeze({
    ...base,
    type: "TOOL_RESULT" as const,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    observationId: input.observationId,
    isError: input.isError,
    projectedContent: input.projectedContent,
    projection: Object.freeze({
      policy: Object.freeze({ ...input.projection.policy }),
      fingerprint: input.projection.fingerprint,
      version: TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
    }),
  });
}
