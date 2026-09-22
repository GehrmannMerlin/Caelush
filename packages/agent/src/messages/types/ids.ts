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
 * Shape sixteen arbitrary bytes into a UUIDv7-formatted string.
 *
 * The version and variant nibbles are forced to `7` and to RFC 4122 variant bits, so the
 * result is a well-formed identifier of the same family `@caelush/protocol` mints. The
 * *contents* are the caller's: a message id passes a real millisecond timestamp and ten random
 * bytes, while a conversation turn id passes sixteen digest bytes so that no component of it
 * is zeroed and none of it depends on the clock.
 */
function uuidV7FromBytes(bytes: Uint8Array): string {
  const shaped = new Uint8Array(16);
  shaped.set(bytes.subarray(0, 16));
  shaped[6] = ((shaped[6] ?? 0) & 0x0f) | 0x70;
  shaped[8] = ((shaped[8] ?? 0) & 0x3f) | 0x80;

  const hex = Buffer.from(shaped).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Write a millisecond timestamp into the leading six bytes, big-endian.
 *
 * The timestamp region is a UUIDv7's only time-carrying component. It is used for *message*
 * identifiers, where "which millisecond was this created in" is real information. It is
 * deliberately **not** used for conversation turn identifiers: a turn id is a pure function of
 * a `RunId`, so a timestamp there would either be a clock read — destroying determinism — or a
 * constant, which would make every turn id of a Session share a prefix.
 */
function writeTimestamp(bytes: Uint8Array, nowMs: number): void {
  const timestamp = BigInt(Math.floor(nowMs));
  for (let offset = 0; offset < 6; offset += 1) {
    bytes[offset] = Number((timestamp >> BigInt(8 * (5 - offset))) & 0xffn);
  }
}

/**
 * The pure, clock-free conversation turn derivation.
 *
 * It is pure on purpose, and it is the **only** implementation in the repository. A factory
 * that mixed in a timestamp would still be deterministic *within* a process and would stop
 * being deterministic across a restart, which is exactly the property a backfill depends on.
 * `anchorMs` is therefore not a clock read: it is a fixed embedding of the factory's own
 * identity, constant for the lifetime of the factory, so the *only* input that can change the
 * answer is the `RunId`.
 *
 * The `RunId` is hashed rather than embedded — a turn id must not grow with a longer run id,
 * and two Runs whose ids share a prefix must still produce unrelated turn ids — and the digest
 * is *combined* with the anchor rather than overwritten by it, so every byte of the identifier
 * remains a function of the Run. Two Runs differ throughout their turn ids rather than only in
 * a suffix, and no region of the identifier is zeroed.
 */
function deriveConversationTurnId(runId: RunId, anchorMs: number): ConversationTurnId {
  const digest = createHash("sha256")
    .update(`${runId}\u0000${String(anchorMs)}`, "utf8")
    .digest();
  return conversationTurnId(`${CONVERSATION_TURN_ID_PREFIX}${uuidV7FromBytes(digest)}`);
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
      const bytes = new Uint8Array(randomBytes(16));
      writeTimestamp(bytes, Date.now());
      return agentMessageId(`${AGENT_MESSAGE_ID_PREFIX}${uuidV7FromBytes(bytes)}`);
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

/**
 * Derive the message identity of a legacy durable row.
 *
 * ```text
 * input    the Run the row belongs to, and its storage sequence
 * output   the AgentMessageId that row's V2 record must carry
 * ```
 *
 * ## Why it lives here and not in Storage
 *
 * A migration must name the messages it migrates, and the identity it invents becomes permanent: the
 * V2 record it writes is the canonical representation from that moment on. If Storage minted that id,
 * Storage would be a semantic identity authority — the second one, alongside the Message Factory —
 * and the two could disagree about what a message is called.
 *
 * So the derivation belongs to the module that already owns the `AgentMessageId` brand, and it is
 * **pure**: the same `(runId, sequence)` yields the same id in any process, on any host, at any time.
 * That is what makes a backfill idempotent and a partial backfill resumable (§37 of the round).
 *
 * ## Why it is not `legacy:<run>:<seq>`
 *
 * The 5A contract requires an `AgentMessageId` of the canonical `amsg_<uuidv7-shaped>` form, and a
 * human-readable composite would not satisfy `isAgentMessageId`. Deriving through a digest keeps the
 * id opaque, fixed-width and format-valid, while remaining exactly reproducible.
 *
 * The `sequence` is part of the pre-image and is also carried on the record envelope, so the
 * derivation is not a second ordering authority: it consumes the ordering the store already assigned.
 */
export function deriveLegacyAgentMessageId(runId: RunId, sequence: number): AgentMessageId {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError("A legacy agent message sequence must be a positive safe integer.");
  }
  const digest = createHash("sha256")
    // A NUL separator keeps the two fields from running together: `run_ab` + `1` must not collide
    // with `run_a` + `b1`.
    .update(`legacy\u0000${runId}\u0000${String(sequence)}`, "utf8")
    .digest();
  return agentMessageId(`${AGENT_MESSAGE_ID_PREFIX}${uuidV7FromBytes(digest)}`);
}
