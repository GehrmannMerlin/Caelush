import { createHash } from "node:crypto";

import type { RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";
import {
  LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY,
  NO_TOOL_RESULT_OBSERVATION,
  TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
  createDeterministicConversationTurnIdFactory,
  deriveLegacyAgentMessageId,
  toToolFeedbackProjectionReceiptJson,
  toolResultObservation,
} from "@caelush/agent";
import type {
  AgentMessageAudience,
  AgentMessageRecord,
  AgentMessageSource,
  ToolResultObservationRef,
} from "@caelush/agent";

/**
 * The legacy `LLMMessage` → Message V2 record converter.
 *
 * ```text
 * Phase 5B   this module migrates existing rows
 * Phase 5F   exit — deleted with the legacy columns it reads
 * ```
 *
 * ## It does not parse the legacy language
 *
 * The former `@caelush/llm` package is retired. This migration-only module does not import it or expose
 * its schemas; the historical language is represented structurally and is reachable only while an
 * upgrade converts legacy rows to the final record envelope.
 *
 * So this module is handed an **already-parsed** message through {@link LegacyParsedMessage} — a
 * structural shape a parsed legacy message satisfies without this package naming the legacy schema.
 * Whoever composes the migration supplies the parser; Storage supplies the conversion. The legacy
 * language stays where it is defined and retires with the rows that use it.
 *
 * ## It converts rows, not messages
 *
 * ```text
 * this converter   legacy row + a parsed legacy message → a deterministic V2 AgentMessageRecord
 * it never         legacy row → AgentMessage → AIMessage
 * ```
 *
 * Producing a semantic message here would make Storage a decoding authority and would let a
 * compatibility concern leak into the Message Domain.
 *
 * ## What it never does
 *
 * ```text
 * never re-projected      the legacy content is history, not an input to a new projection
 * never truncated         a migration is not a Context projection
 * never fabricated        no observation, no policy and no provenance is invented
 * never promoted          LEGACY provenance stays LEGACY; no model, callId or usage is guessed
 * never re-identified     identity comes from (runId, sequence) alone
 * ```
 */

/** The clock-free turn derivation, built once. The same Run always yields the same turn. */
const deterministicTurnIds = createDeterministicConversationTurnIdFactory();

/**
 * The structural shape of a parsed legacy message.
 *
 * It is a **subset** of the former legacy message contract, restated without importing it, so a value
 * produced by the real legacy parser satisfies this type structurally. Typing it as a subset rather than
 * as `unknown` is what makes the migration's reads type-checked: this module reads `role`, `content`,
 * `toolCallId`, `toolName` and `isError`, and the type says exactly that.
 */
export type LegacyParsedMessage =
  | {
      readonly role: "system";
      readonly content: string;
    }
  | {
      readonly role: "user";
      readonly content: string;
    }
  | {
      readonly role: "assistant";
      readonly content: readonly (
        | { readonly type: "text"; readonly text: string }
        | {
            readonly type: "tool-call";
            readonly toolCallId: string;
            readonly toolName: string;
            readonly input: Readonly<Record<string, unknown>>;
          }
      )[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      readonly isError: boolean;
      readonly rawArtifactRef?: string;
    };

/** What one legacy row needs to become a V2 record, beyond the row itself. */
export interface LegacyMessageContext {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly role: string;
  readonly createdAt: TimestampMs;
  readonly sourceStepId?: StepId;
  /** The row's payload, already parsed by whoever composes the migration. */
  readonly message: LegacyParsedMessage;
  /**
   * The observation the legacy row's Tool call provably produced, when exactly one is provable.
   *
   * `undefined` means "no execution observation exists for this feedback", which is a legitimate
   * historical fact for a rejected or skipped call. It never means "the lookup failed" — an ambiguous
   * lookup is refused by the caller rather than reported as absence.
   */
  readonly observationId?: string;
}

/**
 * Why a legacy row could not be migrated.
 *
 * ```text
 * UNPARSEABLE_LEGACY_JSON  the row's payload is not a legacy message
 * UNKNOWN_LEGACY_ROLE      the row's role is not user, assistant or tool
 * SYSTEM_LEGACY_ROLE       the row is a system message, which the Message Domain cannot represent
 * ROLE_PAYLOAD_MISMATCH    the row's role column disagrees with its payload's own role
 * ```
 *
 * A closed set. Every arm fails the *row* rather than the run: a single unrepresentable row must not
 * abort a migration, and it must not be silently dropped either.
 */
export type LegacyMessageMigrationFailureReason =
  | "UNPARSEABLE_LEGACY_JSON"
  | "UNKNOWN_LEGACY_ROLE"
  | "SYSTEM_LEGACY_ROLE"
  | "ROLE_PAYLOAD_MISMATCH";

export class LegacyMessageMigrationError extends Error {
  readonly reason: LegacyMessageMigrationFailureReason;
  readonly sequence: number;

  constructor(reason: LegacyMessageMigrationFailureReason, sequence: number) {
    super(`Legacy agent message at sequence ${String(sequence)} cannot be migrated: ${reason}`);
    this.name = "LegacyMessageMigrationError";
    this.reason = reason;
    this.sequence = sequence;
  }
}

/**
 * What an injected legacy parser throws when a row's payload is not a legacy message.
 *
 * It exists so a caller can tell a *row-level* parse failure — one row with malformed payload, which the
 * migration records and steps over — from an *infrastructure* failure, which must abort. A parser that
 * threw a bare `Error` would make the two indistinguishable, and treating a malformed row as
 * infrastructure would abort a migration over one bad row.
 *
 * The message carries the reason and never the payload: a legacy row may hold user text or Tool output.
 */
export class LegacyMessageParseError extends Error {
  constructor() {
    super("A legacy agent message payload could not be parsed.");
    this.name = "LegacyMessageParseError";
  }
}

/**
 * Convert one legacy row into the V2 record it migrates to.
 *
 * ## The required facts it cannot invent
 *
 * `AgentToolResultMessage` needs an observation reference and a projection receipt. A legacy row records
 * the first only when a real observation is provable, and never records the second, so:
 *
 * ```text
 * observation   OBSERVATION { id }   when the caller proved exactly one observation
 *               NO_OBSERVATION       when none exists — a real, terminal historical fact
 * policy        LEGACY_UNKNOWN       always, because the per-row policy was never recorded
 * ```
 *
 * ## The facts it refuses to guess
 *
 * A legacy assistant row records neither a call id nor a model nor a finish reason nor a usage snapshot,
 * so it becomes `LEGACY_MODEL_TURN` and nothing is invented to upgrade it. A legacy user row becomes
 * `LEGACY / user` rather than `USER / GOAL`, because the durable row alone cannot prove the message was
 * the Run's goal.
 */
export function legacyRowToAgentMessageRecord(context: LegacyMessageContext): AgentMessageRecord {
  const parsed = context.message;
  if (parsed.role !== context.role) {
    // The row's indexed role column and its payload disagree. That is a durable integrity defect, and
    // resolving it either way would silently prefer one authority over the other.
    throw new LegacyMessageMigrationError("ROLE_PAYLOAD_MISMATCH", context.sequence);
  }

  const envelope = {
    messageId: deriveLegacyAgentMessageId(context.runId, context.sequence),
    runId: context.runId,
    sessionId: context.sessionId,
    sequence: context.sequence,
    conversationTurnId: deterministicTurnIds.forRun(context.runId),
    schemaVersion: 1,
    modelProjectionVersion: 1,
    ...(context.sourceStepId === undefined ? {} : { sourceStepId: context.sourceStepId }),
    createdAt: context.createdAt,
  } as const;

  switch (parsed.role) {
    case "system":
      // The Message Domain has no system arm by design: a system instruction is Context material
      // authored for one provider request, not something that happened in a conversation. A legacy
      // system row therefore has no faithful V2 representation and is refused rather than dropped.
      throw new LegacyMessageMigrationError("SYSTEM_LEGACY_ROLE", context.sequence);

    case "user":
      return {
        ...envelope,
        messageType: "USER",
        source: sourceFor("user"),
        audience: audienceFor("user"),
        data: { content: [{ type: "TEXT", text: parsed.content }] } as AgentMessageRecord["data"],
      };

    case "assistant":
      return {
        ...envelope,
        messageType: "ASSISTANT",
        source: sourceFor("assistant"),
        audience: audienceFor("assistant"),
        data: {
          // Part order, toolCallId, toolName and input are preserved exactly. A legacy assistant message
          // that narrated before it called a Tool must still narrate before it calls it.
          content: parsed.content.map((part) =>
            part.type === "text"
              ? { type: "TEXT", text: part.text }
              : {
                  type: "TOOL_CALL",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                },
          ),
          model: {
            kind: "LEGACY_MODEL_TURN",
            ...(context.sourceStepId === undefined ? {} : { sourceStepId: context.sourceStepId }),
          },
        } as AgentMessageRecord["data"],
      };

    case "tool":
      return {
        ...envelope,
        messageType: "TOOL_RESULT",
        source: sourceFor("tool"),
        audience: audienceFor("tool"),
        data: {
          toolCallId: parsed.toolCallId,
          toolName: parsed.toolName,
          observation: observationRefOf(context.observationId),
          isError: parsed.isError,
          // Byte-for-byte the content the model was shown. Re-projecting it would replace history with a
          // new projection of the same input, and truncating it would be a Context decision this module
          // has no authority to make.
          projectedContent: parsed.content,
          projection: toToolFeedbackProjectionReceiptJson({
            // A legacy row never recorded the per-row projection policy, so it is stated as unknown
            // rather than defaulted to today's limits or to the latest continuation checkpoint.
            policy: LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY,
            // A deterministic digest over the exact durable content and its error flag: the fields the
            // standard Tool Result projector emits. It covers no policy metadata, because it certifies
            // what the model was shown and an unknown historical policy does not change that.
            fingerprint: legacyProjectionFingerprint(parsed.content, parsed.isError),
            version: TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION,
          }),
        } as AgentMessageRecord["data"],
      };

    default:
      throw new LegacyMessageMigrationError("UNKNOWN_LEGACY_ROLE", context.sequence);
  }
}

/**
 * Convert a legacy row whose payload has not been parsed yet.
 *
 * A caller that already holds a parsed message uses {@link legacyRowToAgentMessageRecord}; this overload
 * exists so the parser stays a parameter rather than an import. **The parser is injected**, because
 * parsing the legacy language is exactly the dependency this package must not take.
 */
export function legacyRowWithParser(
  parse: (raw: string) => LegacyParsedMessage,
  context: Omit<LegacyMessageContext, "message"> & { readonly rawDataJson: string },
): AgentMessageRecord {
  return legacyRowToAgentMessageRecord({
    ...context,
    message: parse(context.rawDataJson),
  });
}

/**
 * The observation reference a migrated Tool row carries.
 *
 * ```text
 * a provable observation   OBSERVATION — the real execution truth, named
 * none exists              NO_OBSERVATION — a legitimate historical fact, not a failure
 * ```
 *
 * There is deliberately no third case. A caller that cannot decide does not pass `undefined`; it refuses
 * the row before calling here, because "ambiguous evidence" and "evidence of absence" are different
 * statements and the migration must not conflate them.
 */
function observationRefOf(observationId: string | undefined): ToolResultObservationRef {
  return observationId === undefined
    ? NO_TOOL_RESULT_OBSERVATION
    : toolResultObservation(observationId as never);
}

/**
 * The audience a migrated message carries.
 *
 * The Phase 5A per-kind defaults, restated because this module must not import the Message Factory: a
 * migration writes history, and the factory refuses legacy provenance by design.
 *
 * ```text
 * user · assistant   model · transcript · debug
 * tool               model · debug, and NOT transcript
 * ```
 */
function audienceFor(role: "user" | "assistant" | "tool"): AgentMessageAudience {
  return role === "tool"
    ? { model: true, transcript: false, debug: true }
    : { model: true, transcript: true, debug: true };
}

/**
 * The provenance a migrated message carries.
 *
 * `LEGACY`, always. The arm names the pre-V2 role it was stored under, which is the only provenance
 * claim the durable row supports.
 */
function sourceFor(role: "user" | "assistant" | "tool"): AgentMessageSource {
  return { kind: "LEGACY", legacyRole: role };
}

/**
 * A deterministic digest over the model-visible result a migrated Tool row reproduces.
 *
 * Re-running the migration over the same row must reproduce the same fingerprint; that is what makes the
 * whole backfill idempotent rather than merely repeatable. It covers the content and the error flag and
 * never the policy, because the fingerprint certifies what the model was shown.
 */
function legacyProjectionFingerprint(content: string, isError: boolean): string {
  return `legacy:${createHash("sha256")
    .update(JSON.stringify({ content, isError }), "utf8")
    .digest("hex")}`;
}
