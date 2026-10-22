import type { JsonObject, JsonValue } from "@caelush/ai";
import {
  AttachmentModelContentReferenceSchema,
  MAX_ATTACHMENT_MODEL_CONTENT_REFERENCES,
} from "@caelush/protocol";
import type { ObservationId } from "@caelush/protocol";
import type { AttachmentModelContentReference } from "@caelush/protocol";

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
 * The JSON-safe mirror of {@link ToolFeedbackProjectionPolicy}.
 *
 * ## Why a mirror exists
 *
 * A projection receipt travels inside `AgentMessageRecord.data`, whose type is `JsonObject`, and
 * `JsonObject` requires an index signature. A TypeScript `interface` does not acquire one implicitly, so
 * `ToolObservationPolicySnapshot` and the union above are structurally *not* assignable to `JsonObject`
 * even though every value they can hold is plainly JSON-safe.
 *
 * ```text
 * a TypeScript assignability quirk, not a domain difference
 * ```
 *
 * ## Why the mirror is here rather than on the snapshot
 *
 * Adding the index signature to `ToolObservationPolicySnapshot` would have been the smaller edit, but it
 * widens `keyof` on a frozen Phase 3 contract, and Phase 3A asserts that contract's key set and exact
 * type. The Message Domain is the layer that needs to make the JSON claim, so the claim is made here and
 * the Phase 3 type stays exactly as frozen.
 *
 * `snapshot` is a `JsonObject` rather than a mirror of the snapshot type: two number-valued token limits
 * already satisfy the index signature, so no second snapshot-shaped type is required.
 *
 * The mirror's own index signature is what makes it assignable to `JsonObject`. It is free here: the
 * mirror is a Phase 5B type with no frozen key set to preserve, which is exactly why the JSON claim
 * belongs on this side of the boundary rather than on the Phase 3 snapshot.
 */
export type ToolFeedbackProjectionPolicyJson =
  | {
      readonly kind: "SNAPSHOT";

      readonly snapshot: JsonObject;

      readonly [field: string]: JsonValue;
    }
  | {
      readonly kind: "LEGACY_UNKNOWN";

      readonly [field: string]: JsonValue;
    };

/**
 * The JSON-safe mirror of {@link ToolFeedbackProjectionReceipt}.
 *
 * The field names, the version and the fingerprint are identical; only the policy arm's type differs. A
 * receipt and its mirror are therefore the same value at runtime and the same shape on the wire — the
 * mirror states JSON-safety, it does not restate the contract.
 */
export interface ToolFeedbackProjectionReceiptJson {
  readonly policy: ToolFeedbackProjectionPolicyJson;

  readonly fingerprint: string;

  readonly version: 1;

  readonly [field: string]: JsonValue;
}

/**
 * Project a policy into its JSON-safe mirror.
 *
 * The snapshot is copied field by field rather than spread, so the mirror carries exactly the two frozen
 * limits and nothing a caller happened to attach to its own object.
 */
export function toToolFeedbackProjectionPolicyJson(
  policy: ToolFeedbackProjectionPolicy,
): ToolFeedbackProjectionPolicyJson {
  if (policy.kind === "LEGACY_UNKNOWN") return Object.freeze({ kind: "LEGACY_UNKNOWN" });
  return Object.freeze({
    kind: "SNAPSHOT",
    snapshot: Object.freeze({
      maxSingleObservationTokens: policy.snapshot.maxSingleObservationTokens,
      maxObservationBatchTokens: policy.snapshot.maxObservationBatchTokens,
    }),
  });
}

/** Project a receipt into its JSON-safe mirror, for the durable record payload. */
export function toToolFeedbackProjectionReceiptJson(
  receipt: ToolFeedbackProjectionReceipt,
): ToolFeedbackProjectionReceiptJson {
  return Object.freeze({
    policy: toToolFeedbackProjectionPolicyJson(receipt.policy),
    fingerprint: receipt.fingerprint,
    version: receipt.version,
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
 * One schema problem a rejected call reported, reduced to the facts a pattern can use.
 *
 * These are the same bounded, schema-derived names the model-facing renderer quotes; they are
 * stored so a *classification* can be reproduced after a restart without re-parsing the historical
 * feedback text. No argument value, no patch body and no host path can appear here.
 */
export interface ToolPreparationFailureIssue {
  /** The declared constraint that failed, for example `required` or `additionalProperties`. */
  readonly keyword: string;
  /** Normalized instance path such as `options.mode`, when the failure had one. */
  readonly path?: string;
  /** The declared property name that is missing or unsupported, when there is one. */
  readonly property?: string;
}

/**
 * The durable fact that a Tool call never became executable.
 *
 * ```text
 * PREPARATION_REJECTED      the arguments were a JSON object but the declared schema refused them
 * MODEL_ARGUMENT_PARSING    the arguments never formed a JSON object the Tool could be called with
 * ```
 *
 * This is deliberately narrower than `ToolFailureFeedback`. It exists because the resource layer
 * must recognise "the same parameter mistake again, with different argument text" without reading
 * the model-facing sentence, and because a rejection is *not* an execution outcome: there is no
 * observation, no side effect and no replay authorisation behind it. Approval refusals, synthetic
 * replan results and real execution failures are different facts and never become this one.
 *
 * The two kinds are kept apart because the model's recovery differs: a schema rejection means the
 * shape was understood and one field was wrong, while a parsing rejection means nothing was
 * understood at all. They can still reach the same correction ladder — that is a decision made by
 * the consumer, not a reason to merge the facts.
 *
 * `classifierVersion` pins the meaning of the pattern key derived from these fields, so a later
 * change to the classification cannot silently reinterpret history. Each kind carries the version
 * its own fields were defined with.
 */
export type ToolPreparationFailureFact =
  | {
      readonly kind: "PREPARATION_REJECTED";
      readonly code: string;
      readonly issues: readonly ToolPreparationFailureIssue[];
      readonly disposition: "SAFE_FAILURE";
      readonly classifierVersion: 1;
    }
  | {
      readonly kind: "MODEL_ARGUMENT_PARSING";
      readonly code: string;
      readonly issues: readonly ToolPreparationFailureIssue[];
      readonly disposition: "SAFE_FAILURE";
      readonly classifierVersion: 2;
    };

/** Bounds on one preparation-failure fact, enforced at construction and at decode. */
export const TOOL_PREPARATION_FAILURE_LIMITS = Object.freeze({
  maxIssues: 8,
  maxFactUtf8Bytes: 2_048,
  maxCodeBytes: 64,
  maxKeywordBytes: 32,
  maxPathBytes: 128,
  maxPropertyBytes: 64,
});

/** Assert one stored preparation-failure fact is well-formed and bounded. */
export function assertToolPreparationFailureFact(
  value: unknown,
): asserts value is ToolPreparationFailureFact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tool preparation failure fact must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const expected = ["kind", "code", "issues", "disposition", "classifierVersion"];
  const actual = Object.keys(candidate).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== [...expected].sort()[index])
  ) {
    throw new TypeError("Tool preparation failure fact has an unsupported shape.");
  }
  if (
    candidate["kind"] !== "PREPARATION_REJECTED" &&
    candidate["kind"] !== "MODEL_ARGUMENT_PARSING"
  ) {
    throw new TypeError("Tool preparation failure kind is unsupported.");
  }
  if (candidate["disposition"] !== "SAFE_FAILURE") {
    throw new TypeError("Tool preparation failure disposition is unsupported.");
  }
  const expectedClassifierVersion = candidate["kind"] === "PREPARATION_REJECTED" ? 1 : 2;
  if (candidate["classifierVersion"] !== expectedClassifierVersion) {
    throw new TypeError("Tool preparation failure classifier version is unsupported.");
  }
  const code = candidate["code"];
  if (
    typeof code !== "string" ||
    code.length === 0 ||
    Buffer.byteLength(code, "utf8") > TOOL_PREPARATION_FAILURE_LIMITS.maxCodeBytes
  ) {
    throw new TypeError("Tool preparation failure code is invalid.");
  }
  const issues = candidate["issues"];
  if (
    !Array.isArray(issues) ||
    issues.length > TOOL_PREPARATION_FAILURE_LIMITS.maxIssues
  ) {
    throw new TypeError("Tool preparation failure issues exceed the bounded limit.");
  }
  for (const issue of issues) assertToolPreparationFailureIssue(issue);
  if (
    Buffer.byteLength(JSON.stringify(candidate), "utf8") >
    TOOL_PREPARATION_FAILURE_LIMITS.maxFactUtf8Bytes
  ) {
    throw new TypeError("Tool preparation failure fact exceeds its byte limit.");
  }
}

function assertToolPreparationFailureIssue(
  value: unknown,
): asserts value is ToolPreparationFailureIssue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tool preparation failure issue must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["keyword", "path", "property"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new TypeError("Tool preparation failure issue has an unsupported field.");
  }
  assertBoundedSafeName(
    candidate["keyword"],
    "Tool preparation failure keyword",
    TOOL_PREPARATION_FAILURE_LIMITS.maxKeywordBytes,
  );
  if (candidate["path"] !== undefined) {
    assertBoundedSafeName(
      candidate["path"],
      "Tool preparation failure path",
      TOOL_PREPARATION_FAILURE_LIMITS.maxPathBytes,
    );
  }
  if (candidate["property"] !== undefined) {
    assertBoundedSafeName(
      candidate["property"],
      "Tool preparation failure property",
      TOOL_PREPARATION_FAILURE_LIMITS.maxPropertyBytes,
    );
  }
}

function assertBoundedSafeName(value: unknown, label: string, maxBytes: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
}

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

  /** Stable references to images the model may receive when Core prepares this Tool result. */
  readonly attachmentReferences: readonly AttachmentModelContentReference[];

  readonly projection: ToolFeedbackProjectionReceipt;

  /**
   * Present only when the call was refused before execution by its declared schema.
   *
   * It is absent for a real observation, for a skipped trailing call and for a synthetic replan
   * result, so "the model was told the arguments were wrong" and "something ran and failed" stay
   * distinguishable facts rather than one inferred from text.
   */
  readonly preparationFailure?: ToolPreparationFailureFact;
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
    readonly attachmentReferences?: readonly AttachmentModelContentReference[] | undefined;
    readonly projection: ToolFeedbackProjectionReceipt;
    readonly preparationFailure?: ToolPreparationFailureFact | undefined;
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
  const attachmentReferences = input.attachmentReferences ?? [];
  if (
    !Array.isArray(attachmentReferences) ||
    attachmentReferences.length > MAX_ATTACHMENT_MODEL_CONTENT_REFERENCES
  ) {
    throw new TypeError("Agent tool result attachment references exceed the bounded limit.");
  }
  if (input.projection.version !== TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION) {
    throw new TypeError(
      `Agent tool result projection version must be ${String(TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION)}.`,
    );
  }
  assertToolFeedbackProjectionPolicy(input.projection.policy);
  if (input.preparationFailure !== undefined) {
    assertToolPreparationFailureFact(input.preparationFailure);
    if (input.observation.kind !== "NO_OBSERVATION") {
      throw new TypeError(
        "A Tool result with an execution observation cannot carry a preparation failure.",
      );
    }
  }
  return Object.freeze({
    ...base,
    type: "TOOL_RESULT" as const,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    observation: Object.freeze({ ...input.observation }) as ToolResultObservationRef,
    isError: input.isError,
    projectedContent: input.projectedContent,
    attachmentReferences: Object.freeze(
      attachmentReferences.map((reference) =>
        Object.freeze(AttachmentModelContentReferenceSchema.parse(reference)),
      ),
    ),
    projection: Object.freeze({
      policy: input.projection.policy,
      fingerprint: input.projection.fingerprint,
      version: TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
    }),
    ...(input.preparationFailure === undefined
      ? {}
      : {
          // The kind and its classifier version are copied together and never re-derived: the two
          // facts mean different things, and rewriting one into the other would change the pattern
          // identity a restart recomputes from this row.
          preparationFailure: Object.freeze(
            input.preparationFailure.kind === "MODEL_ARGUMENT_PARSING"
              ? {
                  kind: "MODEL_ARGUMENT_PARSING" as const,
                  code: input.preparationFailure.code,
                  issues: Object.freeze(
                    input.preparationFailure.issues.map((issue) => Object.freeze({ ...issue })),
                  ),
                  disposition: "SAFE_FAILURE" as const,
                  classifierVersion: 2 as const,
                }
              : {
                  kind: "PREPARATION_REJECTED" as const,
                  code: input.preparationFailure.code,
                  issues: Object.freeze(
                    input.preparationFailure.issues.map((issue) => Object.freeze({ ...issue })),
                  ),
                  disposition: "SAFE_FAILURE" as const,
                  classifierVersion: 1 as const,
                },
          ),
        }),
  });
}

/** The `ObservationId` of a result, or `undefined` when it has no execution behind it. */
export function toolResultObservationId(
  message: AgentToolResultMessage,
): ObservationId | undefined {
  return message.observation.kind === "OBSERVATION" ? message.observation.observationId : undefined;
}
