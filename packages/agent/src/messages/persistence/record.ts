import type { JsonObject } from "@caelush/ai";
import type { RunId, SessionId, StepId, TimestampMs } from "@caelush/protocol";

import type { AgentMessageAudience } from "../types/audience.js";
import type { AgentMessage } from "../types/agent-message.js";
import type { AgentMessageId, ConversationTurnId } from "../types/ids.js";
import type { AgentMessageSource } from "../types/source.js";

/**
 * Durable message *contracts*.
 *
 * ```text
 * Phase 5A   the shapes and their invariants            ← this file
 * Phase 5B   the SQLite schema, the migration, the store implementation
 * ```
 *
 * Nothing here touches a database. There is no client, no SQL, no table name and no
 * migration, and `@caelush/agent` still declares no SQLite dependency. The four shapes
 * below are the whole of what Phase 5B has to satisfy, and they are fixed now so the
 * storage round implements a contract rather than inventing one.
 */

/**
 * The version of a message's *durable encoding*.
 *
 * A positive safe integer, because it indexes a codec: a version of `0`, `-1` or `1.5`
 * cannot select one, and a version beyond `Number.MAX_SAFE_INTEGER` cannot be compared
 * reliably. The type is a plain `number` — the freeze says so — so the invariant is
 * enforced by {@link assertAgentMessageSchemaVersion} at every boundary rather than by
 * the type.
 */
export type AgentMessageSchemaVersion = number;

/**
 * The version of the *model projection* a message was stored under.
 *
 * Distinct from the schema version and deliberately so: re-encoding a message's durable
 * bytes and changing what the model is shown are different events. Phase 5A's projection
 * registry selects a projector by this value, which is why it must be recorded rather
 * than recomputed — a message the model saw under projector v1 must still be projected by
 * v1 after the repository ships a v2.
 */
export type AgentMessageProjectionVersion = number;

/** Assert the durable-encoding version invariant. */
export function assertAgentMessageSchemaVersion(
  value: unknown,
): asserts value is AgentMessageSchemaVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("Agent message schema version must be a positive safe integer.");
  }
}

/** Assert the projection-version invariant. */
export function assertAgentMessageProjectionVersion(
  value: unknown,
): asserts value is AgentMessageProjectionVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("Agent message projection version must be a positive safe integer.");
  }
}

/**
 * One message as it is durably recorded.
 *
 * ```text
 * envelope   messageId, runId, sessionId, sequence, turn, type, versions, time, source, audience
 * data       the message-type-specific payload
 * ```
 *
 * ## The envelope is the authority, and `data` must not restate it
 *
 * `runId`, `sessionId`, `conversationTurnId`, `source`, `audience`, `createdAt` and
 * `sequence` appear exactly once — here. A codec that also wrote `runId` into `data`
 * would create two copies of one fact that can disagree, and the disagreement would
 * surface as a message whose envelope says one Run and whose payload says another. So
 * `data` carries only what is specific to the message type:
 *
 * ```text
 * USER         content
 * ASSISTANT    content, model, providerState?
 * TOOL_RESULT  toolCallId, toolName, observation, isError, projectedContent, projection
 * ```
 *
 * ## `sequence` lives here, and only here
 *
 * It is the store's ordering, not the message's property. It is a positive safe integer
 * assigned by whoever writes the row, which is why {@link AgentMessageRecordDraft} has no
 * such field: a draft is what a caller hands over *before* the store numbered it.
 */
export interface AgentMessageRecord {
  readonly messageId: AgentMessageId;

  readonly runId: RunId;

  readonly sessionId: SessionId;

  readonly sequence: number;

  readonly conversationTurnId: ConversationTurnId;

  readonly messageType: string;

  readonly schemaVersion: AgentMessageSchemaVersion;

  readonly modelProjectionVersion?: AgentMessageProjectionVersion;

  readonly sourceStepId?: StepId;

  readonly createdAt: TimestampMs;

  readonly source: AgentMessageSource;

  readonly audience: AgentMessageAudience;

  readonly data: JsonObject;
}

/**
 * A record the store has numbered.
 *
 * The decode result: the semantic message plus the storage facts that are not part of it.
 * Phase 5A defines it and never constructs one from a real store, because no store exists
 * yet.
 */
export interface StoredAgentMessage<TMessage extends AgentMessage = AgentMessage> {
  readonly sequence: number;

  readonly schemaVersion: AgentMessageSchemaVersion;

  readonly modelProjectionVersion?: AgentMessageProjectionVersion;

  readonly message: TMessage;
}

/**
 * A message plus its encoding versions and its encoded payload, before storage.
 *
 * ```text
 * no sequence   the store assigns it
 * ```
 *
 * ## Why it carries `data`
 *
 * This is what `AgentMessageCodecRegistry.encode()` returns, and Phase 5B's Interface Freeze Errata
 * added `data` because the storage round cannot otherwise obtain the bytes it must persist.
 *
 * ```text
 * the codec computes the payload and the registry validates it is JSON-safe
 * the repository must write exactly those bytes as AgentMessageRecord.data
 * re-encoding at the repository would re-choose the version this draft already carries
 * ```
 *
 * `data` is required for the same reason: a draft that cannot supply its payload cannot be appended.
 * Nothing else about the shape changes — `message` is still the semantic message, and the two versions
 * keep their meaning.
 *
 * ## Why there is still no `sequence`
 *
 * A caller cannot choose its own position in the ledger, and two callers encoding the same message
 * cannot disagree about where it goes.
 */
export interface AgentMessageDraft<TMessage extends AgentMessage = AgentMessage> {
  readonly message: TMessage;

  /** The codec's encoded payload: exactly what `AgentMessageRecord.data` must contain. */
  readonly data: JsonObject;

  readonly schemaVersion: AgentMessageSchemaVersion;

  readonly modelProjectionVersion?: AgentMessageProjectionVersion;
}

/**
 * A durable record before storage.
 *
 * ```text
 * no runId      Store.append(runId, records) binds the Run outside the record
 * no sequence   the store assigns it
 * ```
 *
 * The Run is bound by the append call rather than restated per record, because a batch
 * appended to one Run is one write: repeating the Run in every record would let a caller
 * construct a batch that claims to span two Runs, and the store would then have to decide
 * which one it meant.
 */
export interface AgentMessageRecordDraft {
  readonly messageId: AgentMessageId;

  readonly sessionId: SessionId;

  readonly conversationTurnId: ConversationTurnId;

  readonly messageType: string;

  readonly schemaVersion: AgentMessageSchemaVersion;

  readonly modelProjectionVersion?: AgentMessageProjectionVersion;

  readonly sourceStepId?: StepId;

  readonly createdAt: TimestampMs;

  readonly source: AgentMessageSource;

  readonly audience: AgentMessageAudience;

  readonly data: JsonObject;
}

/** Assert the store-assigned ordering invariant. */
export function assertAgentMessageSequence(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("Agent message sequence must be a positive safe integer.");
  }
}

/* ------------------------------------------------------------------- opaque records */

/** Why a durable record could not be turned into a message. */
export type OpaqueAgentMessageReason = "CODEC_UNAVAILABLE" | "UNSUPPORTED_SCHEMA_VERSION";

/** Every opaque reason, in canonical order. */
export const OPAQUE_AGENT_MESSAGE_REASONS = [
  "CODEC_UNAVAILABLE",
  "UNSUPPORTED_SCHEMA_VERSION",
] as const satisfies readonly OpaqueAgentMessageReason[];

/**
 * A record this build cannot decode, preserved rather than discarded.
 *
 * ```text
 * CODEC_UNAVAILABLE          no codec is registered for this message type at all
 * UNSUPPORTED_SCHEMA_VERSION a codec exists, but not for the version the row carries
 * ```
 *
 * ## Fail closed, but do not destroy
 *
 * A build that meets a row written by a newer build has two wrong options and one right
 * one. Decoding it as though it were the current version would silently reinterpret data
 * — the exact failure a version field exists to prevent. Dropping it would lose a
 * conversation the user had. So the record is surfaced *as an opaque record*: the caller
 * learns that something is there, learns why it could not be read, and the bytes stay
 * where they are.
 *
 * `registry.decode()` itself throws, because its frozen return type is `AgentMessage` and
 * it must not invent one. A caller that wants preservation catches the typed codec error
 * and pairs the untouched record with this reason; Phase 5B owns the policy that decides
 * what the store then does with it.
 */
export interface OpaqueAgentMessageRecord {
  readonly record: AgentMessageRecord;

  readonly reason: OpaqueAgentMessageReason;
}
