import type { JsonObject } from "@caelush/ai";

import type { AgentMessage } from "../types/agent-message.js";
import type { AgentMessageRecord, AgentMessageSchemaVersion } from "../persistence/record.js";

/**
 * The durable encoder and decoder of one message type.
 *
 * ```text
 * type            the message type this codec owns
 * currentVersion  the schema version this codec writes
 * canDecode       whether it can read a stored version
 * encode          message → the type-specific `data` payload
 * decode          record → message
 * ```
 *
 * ## A codec is a persistence concern and nothing else
 *
 * ```text
 * it does not   call a model, read the runtime, touch a filesystem or a network
 * it does not   select context, project for the model, or render a transcript
 * it does not   mutate a Run, a Step or a Tool invocation
 * ```
 *
 * The separation is what makes a decode trustworthy. A decoder that consulted live state
 * would produce a message that depends on *when* it was read, and the whole point of a
 * versioned durable encoding is that the same bytes always mean the same thing.
 *
 * ## `encode` and `decode` are not symmetric in what they see
 *
 * `encode` takes a message and returns the type-specific payload only. `decode` takes a
 * whole record, because a message needs its envelope — identity, scope, turn, time,
 * source and audience — and that envelope is not in `data`. Splitting it the other way
 * would force either the envelope into `data` (two authorities over `runId`) or the
 * message to lose its scope on a round trip.
 */
export interface AgentMessageCodec<TMessage extends AgentMessage = AgentMessage> {
  readonly type: TMessage["type"];

  readonly currentVersion: AgentMessageSchemaVersion;

  canDecode(version: AgentMessageSchemaVersion): boolean;

  encode(message: TMessage): JsonObject;

  decode(record: AgentMessageRecord): TMessage;
}

/**
 * Why a record could not be decoded.
 *
 * ```text
 * CODEC_UNAVAILABLE           no codec is registered for this message type
 * UNSUPPORTED_SCHEMA_VERSION  a codec exists, but not for the stored version
 * IDENTITY_MISMATCH           the record's messageType is not this codec's type
 * INVALID_RECORD              the envelope or the payload is not well-formed
 * ```
 *
 * All four fail closed. In particular nothing here says "use the newest decoder": a
 * versioned encoding whose reader silently falls forward is not versioned at all.
 */
export type AgentMessageCodecErrorReason =
  "CODEC_UNAVAILABLE" | "UNSUPPORTED_SCHEMA_VERSION" | "IDENTITY_MISMATCH" | "INVALID_RECORD";

/** Every codec error reason, in canonical order. */
export const AGENT_MESSAGE_CODEC_ERROR_REASONS = [
  "CODEC_UNAVAILABLE",
  "UNSUPPORTED_SCHEMA_VERSION",
  "IDENTITY_MISMATCH",
  "INVALID_RECORD",
] as const satisfies readonly AgentMessageCodecErrorReason[];

/**
 * The refusal a codec raises.
 *
 * It carries the reason, the message type and the version — all of which are schema
 * metadata, never message content — and it never carries the record's payload. A decode
 * failure must not leak the Tool output or the user's text into an error path that might
 * be logged.
 */
export class AgentMessageCodecError extends Error {
  readonly reason: AgentMessageCodecErrorReason;
  readonly messageType: string;
  readonly schemaVersion?: AgentMessageSchemaVersion;

  constructor(
    reason: AgentMessageCodecErrorReason,
    messageType: string,
    schemaVersion?: AgentMessageSchemaVersion,
  ) {
    super(agentMessageCodecErrorMessage(reason, messageType, schemaVersion));
    this.name = "AgentMessageCodecError";
    this.reason = reason;
    this.messageType = messageType;
    if (schemaVersion !== undefined) this.schemaVersion = schemaVersion;
  }
}

/** The fixed, safe summary of one codec refusal. */
export function agentMessageCodecErrorMessage(
  reason: AgentMessageCodecErrorReason,
  messageType: string,
  schemaVersion?: AgentMessageSchemaVersion,
): string {
  const version = schemaVersion === undefined ? "unknown" : String(schemaVersion);
  switch (reason) {
    case "CODEC_UNAVAILABLE":
      return `No agent message codec is registered for type ${JSON.stringify(messageType)}.`;
    case "UNSUPPORTED_SCHEMA_VERSION":
      return `Agent message codec ${JSON.stringify(messageType)} cannot decode schema version ${version}.`;
    case "IDENTITY_MISMATCH":
      return `Agent message record messageType is not ${JSON.stringify(messageType)}.`;
    case "INVALID_RECORD":
      return `Agent message record for type ${JSON.stringify(messageType)} is invalid.`;
  }
}
