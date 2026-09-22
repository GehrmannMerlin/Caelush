import type { ObservationId } from "@caelush/protocol";

import type { ToolObservationPolicySnapshot } from "../../loop/types.js";
import type { AgentMessageBase } from "./message-base.js";
import type { ToolResultObservationRef } from "./tool-result-observation.js";
import { assertToolResultObservationRef } from "./tool-result-observation.js";

/**
 * The projection policy a Tool Result was projected under.
 *
 * Phase 5B's Interface Freeze Errata replaced a mandatory snapshot with this union, because a
 * snapshot was never recorded per message.
 *
 * ```text
 * SNAPSHOT          the real policy was known when this Tool Result was created, and is recorded
 * LEGACY_UNKNOWN    the historical row preserved what the model saw but not the policy, so the
 *                   policy is not recoverable today
 * ```
 *
 * ## Why the historical policy is genuinely unknowable
 *
 * `ToolObservationPolicySnapshot` is durably recorded **once per Run continuation**, never per
 * message: it is attached to the `WAITING_TOOL_RESULTS` checkpoint when a Tool boundary opens, and
 * `agent_run_continuations` is keyed `runId PRIMARY KEY` — one row per Run. When the results commit,
 * the continuation advances and that checkpoint is replaced. For any settled historical Tool row the
 * policy that governed it is gone, and the surviving value describes the *newest* Tool boundary.
 *
 * ```text
 * LEGACY_UNKNOWN is NOT  a default
 * LEGACY_UNKNOWN is NOT  the current policy
 * LEGACY_UNKNOWN is NOT  0 / 0
 * LEGACY_UNKNOWN is NOT  the latest or nearest checkpoint
 * ```
 *
 * ## `LEGACY_UNKNOWN` is migration-only
 *
 * `AgentMessageFactory.createToolResult()` **refuses** it. A normal producer must not be able to
 * create an unknown policy by accident, so only a migration — which is describing a row that really
 * has no recorded policy — may write it. The refusal is structural rather than advisory.
 *
 * ## Why this does not weaken anything the model sees
 *
 * The AI projector uses `projectedContent` verbatim and never consults the policy. Historical model
 * replay is therefore identical whether the policy is known or not, which is exactly why recording
 * the unknown *honestly* is safe: it changes no model-visible byte, and it stops the migration from
 * inventing a bound that was never in force.
 */
export type ToolFeedbackProjectionPolicy =
  | {
      readonly kind: "SNAPSHOT";

      readonly snapshot: ToolObservationPolicySnapshot;
    }
  | {
      readonly kind: "LEGACY_UNKNOWN";
    };

/** Every projection-policy kind, in canonical order. */
export const TOOL_FEEDBACK_PROJECTION_POLICY_KINDS = [
  "SNAPSHOT",
  "LEGACY_UNKNOWN",
] as const satisfies readonly ToolFeedbackProjectionPolicy["kind"][];

/** Build the known-policy arm. */
export function toolFeedbackPolicySnapshot(
  snapshot: ToolObservationPolicySnapshot,
): ToolFeedbackProjectionPolicy {
  return Object.freeze({
    kind: "SNAPSHOT",
    snapshot: Object.freeze({ ...snapshot }),
  });
}

/**
 * The migration-only unknown arm.
 *
 * A shared frozen value, because the value carries no data. It is constructed here rather than by a
 * caller so that writing it is a visible, named act.
 */
export const LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY: ToolFeedbackProjectionPolicy = Object.freeze({
  kind: "LEGACY_UNKNOWN",
});

/** Assert a well-formed projection policy. */
export function assertToolFeedbackProjectionPolicy(
  value: unknown,
): asserts value is ToolFeedbackProjectionPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tool feedback projection policy must be an object.");
  }
  const candidate = value as { readonly kind?: unknown; readonly snapshot?: unknown };
  switch (candidate.kind) {
    case "SNAPSHOT": {
      const snapshot = candidate.snapshot;
      if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
        throw new TypeError("A tool feedback policy snapshot must be an object.");
      }
      const limits = snapshot as Record<string, unknown>;
      for (const field of ["maxSingleObservationTokens", "maxObservationBatchTokens"] as const) {
        const limit = limits[field];
        if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
          throw new TypeError(
            `A tool feedback policy snapshot ${field} must be a positive safe integer.`,
          );
        }
      }
      return;
    }
    case "LEGACY_UNKNOWN":
      return;
    default:
      throw new TypeError("Tool feedback projection policy kind is unknown.");
  }
}

/**
 * The policy a Tool observation was projected under, plus a fingerprint of the result.
 *
 * ```text
 * policy       the projection policy, or an explicit statement that it is not recoverable
 * fingerprint  a stable digest of the projected text
 * version      this receipt envelope's version; this contract defines exactly 1
 * ```
 *
 * ## Why the policy is snapshotted rather than referenced
 *
 * A Tool result is *historical* model-visible truth: it says what the model was shown at the moment
 * the Tool settled. If the receipt merely pointed at a live policy object, a later policy change
 * would silently rewrite history — a message the model saw as truncated would start claiming it was
 * shown in full. The snapshot is taken from `ToolObservationPolicySnapshot`, the Phase 3 contract, and
 * Phase 5A creates no second policy type.
 *
 * ## Why there is a fingerprint
 *
 * `projectedContent` is the truth; the fingerprint makes it checkable. Phase 5B can prove that a
 * decoded message's content matches the receipt it was stored with, so a truncation applied at read
 * time by mistake fails loudly instead of quietly changing what the model is told.
 *
 * The fingerprint is a digest over the **model-visible projected result**, never over policy
 * metadata. A legacy row's fingerprint is computed from its exact historical content, so a migrated
 * row reproduces the same model-visible shape regardless of whether its policy is known.
 */
export interface ToolFeedbackProjectionReceipt {
  readonly policy: ToolFeedbackProjectionPolicy;

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
 * observation       whether a real execution observation exists behind it
 * isError           whether the Tool reported failure
 * projectedContent  the exact text the model was shown
 * projection        the policy receipt
 * ```
 *
 * ## Two truths, and which one this is
 *
 * ```text
 * ToolObservation          execution truth                        when one exists
 * AgentToolResultMessage   historical model-visible truth         always
 * ```
 *
 * For feedback that came from a real execution, both exist and the second is *derived from* the first
 * at settlement time and then frozen. For feedback that never executed — a rejected call, a skipped
 * trailing call, a synthetic replan result — only the second exists, and `observation` says so
 * explicitly rather than leaving a reader to infer it from an absence.
 *
 * Nothing may recompute `projectedContent`: a projection that re-read an observation, re-truncated it
 * or re-applied a redaction would produce a different text from the one the model was actually shown,
 * which is precisely the fact this message exists to preserve. `observation` is a pointer of record
 * for audit and Tool linkage; it is never an instruction to go and look something up.
 *
 * ## Tool linkage does not depend on observation existence
 *
 * A Tool Call is answered by a Tool Result that names its `toolCallId` and `toolName`. The
 * `ConversationValidator` and `ExecutionUnit` read those two fields, never `observation`, so a
 * `NO_OBSERVATION` result closes a Tool Call exactly as an observed one does.
 */
export interface AgentToolResultMessage extends AgentMessageBase {
  readonly type: "TOOL_RESULT";

  readonly toolCallId: string;

  readonly toolName: string;

  readonly observation: ToolResultObservationRef;

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
    readonly observation: ToolResultObservationRef;
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
  assertToolResultObservationRef(input.observation);
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
  assertToolFeedbackProjectionPolicy(input.projection.policy);
  return Object.freeze({
    ...base,
    type: "TOOL_RESULT" as const,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    observation: Object.freeze({ ...input.observation }) as ToolResultObservationRef,
    isError: input.isError,
    projectedContent: input.projectedContent,
    projection: Object.freeze({
      policy: input.projection.policy,
      fingerprint: input.projection.fingerprint,
      version: TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
    }),
  });
}

/** The `ObservationId` of a result, or `undefined` when it has no execution behind it. */
export function toolResultObservationId(
  message: AgentToolResultMessage,
): ObservationId | undefined {
  return message.observation.kind === "OBSERVATION" ? message.observation.observationId : undefined;
}
