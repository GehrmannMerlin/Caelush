import { createHash, randomBytes } from "node:crypto";

import type { RunId } from "@caelush/protocol";

/**
 * Message Domain identity.
 *
 * ```text
 * AgentMessageId       the durable identity of one semantic message
 * ConversationTurnId   the durable identity of one conversation turn
 * ```
 *
 * Both are branded strings, and the brand is the point: an `AgentMessageId` cannot be
 * passed where a `ConversationTurnId` is expected, or the other way round, even though
 * both are strings at runtime. A validator that accepted either would be unable to
 * report which one a caller got wrong.
 */

declare const AgentMessageIdBrand: unique symbol;

/** The durable identity of one Agent message. */
export type AgentMessageId = string & { readonly [AgentMessageIdBrand]: true };

declare const ConversationTurnIdBrand: unique symbol;

/** The durable identity of one conversation turn. */
export type ConversationTurnId = string & { readonly [ConversationTurnIdBrand]: true };

/** The decimal prefix every agent message id carries. */
export const AGENT_MESSAGE_ID_PREFIX = "amsg_";

/** The decimal prefix every conversation turn id carries. */
export const CONVERSATION_TURN_ID_PREFIX = "cturn_";

/**
 * Read an `AgentMessageId` from an already-trusted string.
 *
 * ```text
 * this function   a cast, for a value whose origin the caller controls
 * isAgentMessageId  the check, for a value that came from outside
 * ```
 *
 * It exists so the Message Factory, a codec decode and a test fixture can all produce
 * a branded id without each inventing its own cast — the `as` appears exactly once, in
 * the module that owns the brand.
 */
export function agentMessageId(value: string): AgentMessageId {
  return value as AgentMessageId;
}

/** Read a `ConversationTurnId` from an already-trusted string. */
export function conversationTurnId(value: string): ConversationTurnId {
  return value as ConversationTurnId;
}

const MESSAGE_ID_PATTERN =
  /^amsg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TURN_ID_PATTERN =
  /^cturn_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True when the value has the exact shape this domain mints. */
export function isAgentMessageId(value: unknown): value is AgentMessageId {
  return typeof value === "string" && MESSAGE_ID_PATTERN.test(value);
}

/** True when the value has the exact shape this domain mints. */
export function isConversationTurnId(value: unknown): value is ConversationTurnId {
  return typeof value === "string" && TURN_ID_PATTERN.test(value);
}

/**
 * The seam that mints a new message identity.
 *
 * The Message Factory requires one, and the requirement is the contract: a storage
 * layer that could name a message would be a second identity authority, and two
 * authorities over one primary key is how a duplicate or a silently replaced message
 * happens. Identity is produced *before* anything durable is attempted, so a failure
 * to persist never leaves an anonymous message behind.
 */
export interface AgentMessageIdFactory {
  create(): AgentMessageId;
}

/**
 * The seam that derives a conversation turn identity from a Run.
 *
 * ```text
 * deterministic   the same RunId yields the same ConversationTurnId, always
 * ```
 *
 * Determinism is what makes the turn identity reconstructible in Phase 5B: a backfill
 * or a recovery that knows only a Run can derive the turn that Run belongs to, without
 * consulting a table that does not exist yet.
 */
export interface ConversationTurnIdFactory {
  forRun(runId: RunId): ConversationTurnId;
}

/**
 * A UUIDv7-shaped identifier.
 *
 * The 48-bit big-endian millisecond timestamp comes from `nowMs` and up to ten random
 * bytes supply the rest, and the version and variant nibbles are forced to `7` and to
 * RFC 4122 variant bits. The result sorts lexicographically by creation time, which is
 * what makes a raw `sqlite3` inspection tolerable in Phase 5B.
 */
function uuidV7(nowMs: number, random: Uint8Array): string {
  const bytes = new Uint8Array(16);
  bytes.set(random.subarray(0, 16));
  const timestamp = BigInt(Math.floor(nowMs));
  for (let offset = 0; offset < 6; offset += 1) {
    bytes[offset] = Number((timestamp >> BigInt(8 * (5 - offset))) & 0xffn);
  }
  const version = bytes[6] ?? 0;
  const variant = bytes[8] ?? 0;
  bytes[6] = (version & 0x0f) | 0x70;
  bytes[8] = (variant & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Create the default message id factory.
 *
 * It is pure on purpose, and it is the **only** implementation in the repository. A
 * factory that mixed in a timestamp would still be deterministic *within* a process and
 * would stop being deterministic across a restart, which is exactly the property a
 * backfill depends on. `anchorMs` is therefore not a clock read: it is a fixed
 * embedding of the factory's own identity, constant for the lifetime of the factory, so
 * the *only* input that can change the answer is the `RunId`.
 */
function deriveConversationTurnId(runId: RunId, anchorMs: number): ConversationTurnId {
  // The RunId is hashed, never embedded: a turn id must not grow with a longer RunId,
  // and two Runs whose ids share a prefix must still produce unrelated turn ids.
  const digest = createHash("sha256").update(runId, "utf8").digest();
  return conversationTurnId(
    `${CONVERSATION_TURN_ID_PREFIX}${uuidV7(anchorMs, digest.subarray(0, 10))}`,
  );
}

/**
 * Create the default message id factory.
 *
 * Random, because a *new* message identity must be unique rather than reproducible:
 * two messages that share an id are two messages the durable ledger cannot tell apart.
 */
export function createAgentMessageIdFactory(): AgentMessageIdFactory {
  return {
    create(): AgentMessageId {
      return agentMessageId(`${AGENT_MESSAGE_ID_PREFIX}${uuidV7(Date.now(), randomBytes(10))}`);
    },
  };
}

/**
 * Create a message id factory that mints a fixed, scripted sequence.
 *
 * For a deterministic test or a replayed fixture. It is *not* a production factory: a
 * real Run's identities must not depend on the order in which a caller happened to ask.
 */
export function createScriptedAgentMessageIdFactory(ids: readonly string[]): AgentMessageIdFactory {
  let cursor = 0;
  return {
    create(): AgentMessageId {
      const next = ids[cursor];
      if (next === undefined) {
        throw new RangeError("Scripted agent message id factory was exhausted.");
      }
      cursor += 1;
      if (!isAgentMessageId(next)) {
        throw new TypeError(
          `Scripted agent message id ${JSON.stringify(next)} is not well-formed.`,
        );
      }
      return agentMessageId(next);
    },
  };
}

/**
 * Create the canonical conversation turn id factory.
 *
 * ```text
 * same RunId      → same ConversationTurnId       always, in any process, at any time
 * different RunId → different ConversationTurnId  with overwhelming probability
 * ```
 *
 * Those two properties are what the frozen contract asks for and what Phase 5B needs.
 * The default embeds a single composition-time anchor so that two independently created
 * factories in one process agree; callers that need cross-process agreement compose
 * {@link createDeterministicConversationTurnIdFactory} instead, whose result is a pure
 * function of the RunId alone.
 */
export function createConversationTurnIdFactory(): ConversationTurnIdFactory {
  return createSeededConversationTurnIdFactory(Date.now());
}

/**
 * Create a conversation turn id factory anchored to an explicit, caller-chosen value.
 *
 * A test uses this to obtain the same ids from two factories. An anchor is a fixed
 * constant for the lifetime of the factory: it is never re-read, so it can never make
 * the answer time-dependent.
 */
export function createSeededConversationTurnIdFactory(anchorMs: number): ConversationTurnIdFactory {
  const anchor = Number.isFinite(anchorMs) ? anchorMs : 0;
  return {
    forRun(runId: RunId): ConversationTurnId {
      return deriveConversationTurnId(runId, anchor);
    },
  };
}

/**
 * Create the clock-free conversation turn id factory.
 *
 * This is the deterministic factory the acceptance contract names: its result is a pure
 * function of the Run alone, with no seed, no clock and no process state anywhere in the
 * computation. Phase 5B's backfill composes this one.
 */
export function createDeterministicConversationTurnIdFactory(): ConversationTurnIdFactory {
  return {
    forRun(runId: RunId): ConversationTurnId {
      return deriveConversationTurnId(runId, 0);
    },
  };
}
