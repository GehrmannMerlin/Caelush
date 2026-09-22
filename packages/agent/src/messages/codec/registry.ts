import type { AgentMessage } from "../types/agent-message.js";
import type {
  AgentMessageDraft,
  AgentMessageRecord,
  AgentMessageProjectionVersion,
  AgentMessageSchemaVersion,
} from "../persistence/record.js";
import type { AgentMessageCodec } from "./codec.js";
import { AgentMessageCodecError } from "./codec.js";
import { assertJsonSafePayload } from "./standard-codecs.js";

/**
 * Resolve the *current* model-projection version of one message type.
 *
 * ```text
 * type    → the version a projector registry would use for a new message
 * ```
 *
 * This is the type of the private resolver the registry is constructed with, and it is
 * the answer to the one real contract tension in Phase 5A. See
 * {@link createAgentMessageCodecRegistry} for why it exists and why it is injected rather
 * than defaulted.
 */
export type AgentMessageProjectionVersionResolver = (
  type: string,
) => AgentMessageProjectionVersion | undefined;

/**
 * The codec registry refused an operation it cannot perform correctly.
 *
 * ```text
 * UNKNOWN_MESSAGE_TYPE                nothing is registered for this type
 * DUPLICATE_CODEC                     two codecs claim one type and version
 * INVALID_VERSION                     a version is not a positive safe integer
 * PROJECTION_VERSION_UNAVAILABLE      a model-visible message has no projector version
 * INVALID_ENCODED_PAYLOAD             a codec returned something that is not JSON-safe
 * ```
 *
 * Every one of these fails closed. In particular `PROJECTION_VERSION_UNAVAILABLE` exists
 * so that the encoding path can never write an `audience.model = true` message without
 * recording the projector version that produced its model view. An absent version is not
 * "use the latest": a later projector would then silently change what a historical
 * message means, which is the failure the version field was introduced to prevent.
 */
export type AgentMessageCodecRegistryErrorReason =
  | "UNKNOWN_MESSAGE_TYPE"
  | "DUPLICATE_CODEC"
  | "INVALID_VERSION"
  | "PROJECTION_VERSION_UNAVAILABLE"
  | "INVALID_ENCODED_PAYLOAD";

/** The refusal a codec registry raises. */
export class AgentMessageCodecRegistryError extends Error {
  readonly reason: AgentMessageCodecRegistryErrorReason;
  readonly messageType: string;

  constructor(reason: AgentMessageCodecRegistryErrorReason, messageType: string) {
    super(agentMessageCodecRegistryErrorMessage(reason, messageType));
    this.name = "AgentMessageCodecRegistryError";
    this.reason = reason;
    this.messageType = messageType;
  }
}

/** The fixed, safe summary of one registry refusal. */
export function agentMessageCodecRegistryErrorMessage(
  reason: AgentMessageCodecRegistryErrorReason,
  messageType: string,
): string {
  const type = JSON.stringify(messageType);
  switch (reason) {
    case "UNKNOWN_MESSAGE_TYPE":
      return `No agent message codec is registered for type ${type}.`;
    case "DUPLICATE_CODEC":
      return `An agent message codec is already registered for type ${type} at that version.`;
    case "INVALID_VERSION":
      return `Agent message codec ${type} declares an invalid schema version.`;
    case "PROJECTION_VERSION_UNAVAILABLE":
      return `No model projection version is available for model-visible agent message type ${type}.`;
    case "INVALID_ENCODED_PAYLOAD":
      return `Agent message codec ${type} produced a payload that is not a JSON object.`;
  }
}

/**
 * The versioned codec registry.
 *
 * ```text
 * has(type, version)      is there a codec for exactly this pair?
 * get(type, version)      the codec, or undefined
 * encode(message)         message → a versioned draft
 * decode(record)          record → message, using the version the record carries
 * ```
 *
 * ## Encoding chooses the current version, decoding obeys the stored one
 *
 * ```text
 * encode   schemaVersion          = codec.currentVersion
 * decode   schemaVersion          = record.schemaVersion, and a codec that cannot read
 *                                   it refuses rather than falling forward
 * ```
 *
 * That asymmetry is the whole point of a versioned encoding. A writer may only ever
 * produce the newest form; a reader must reproduce what was actually written.
 *
 * ## Unknown types fail closed
 *
 * `get()` may return `undefined`, and `decode()` never guesses. There is no "decode with
 * the latest codec of a similar type" path and no default version: a record this build
 * cannot read is a record this build must not reinterpret. The frozen return type of
 * `decode()` is `AgentMessage`, so it raises a typed {@link AgentMessageCodecError}
 * carrying `CODEC_UNAVAILABLE` or `UNSUPPORTED_SCHEMA_VERSION`; a persistence caller
 * pairs the untouched record with that reason to build an
 * `OpaqueAgentMessageRecord` rather than destroying it.
 */
export interface AgentMessageCodecRegistry {
  has(type: string, version: AgentMessageSchemaVersion): boolean;

  get(type: string, version: AgentMessageSchemaVersion): AgentMessageCodec | undefined;

  encode(message: AgentMessage): AgentMessageDraft;

  decode(record: AgentMessageRecord): AgentMessage;
}

/** The builder that produces one immutable registry generation. */
export interface AgentMessageCodecRegistryBuilder {
  register(codec: AgentMessageCodec): this;

  build(): AgentMessageCodecRegistry;
}

/**
 * Build the canonical codec registry.
 *
 * ## The projection-version reconciliation, stated once
 *
 * The freeze fixes three things that have to be satisfied together:
 *
 * ```text
 * AgentMessageCodecRegistry.encode(message) → AgentMessageDraft
 * AgentMessageDraft carries modelProjectionVersion?
 * every new audience.model = true message must record its modelProjectionVersion
 * ```
 *
 * so `encode()` must know the current projector version *at encode time*. The freeze also
 * fixes the `AgentMessageCodecRegistry` interface itself, which has no field to carry one,
 * and the target layout keeps `type → projectorRegistry` wiring out of the persistence
 * layer.
 *
 * The resolution is that the version authority is **injected**, not looked up:
 *
 * ```text
 * createAgentMessageCodecRegistry({ projectionVersionOf })
 * ```
 *
 * The codec registry therefore owns the *rule* — a model-visible message records the
 * current projector version, and cannot be encoded without one — while the version
 * *value* stays with the layer that owns projectors. In production the composition root
 * passes `projectorRegistry.currentVersion`, which is the projector registry's own answer;
 * in an isolated test it passes an explicit literal. Neither case changes a frozen
 * interface, and the rule holds in both.
 *
 * Three ways of "solving" this are refused, and each is refused for the same reason —
 * they would put the version somewhere that can disagree with the projector registry:
 *
 * ```text
 * a hardcoded 1, or a literal scattered per codec      a second authority over the version
 * letting storage guess or default it                  the writer would not be recording it
 * calling the real projector just to ask for a version a model projection is not a lookup
 * ```
 *
 * ## When no resolver is injected
 *
 * A registry built without one encodes messages whose `audience.model` is `false` — they
 * consume no model context and have no model view to version — and refuses a
 * model-visible message with `PROJECTION_VERSION_UNAVAILABLE`. It does not fall back to
 * `1`.
 */
export function createAgentMessageCodecRegistry(options: {
  readonly codecs: readonly AgentMessageCodec[];
  /**
   * The current model-projection version authority.
   *
   * Absent means "this registry cannot version a model view", and encoding a
   * model-visible message then fails closed rather than writing an unversioned one.
   */
  readonly projectionVersionOf?: AgentMessageProjectionVersionResolver | undefined;
}): AgentMessageCodecRegistry {
  const byType = new Map<string, Map<AgentMessageSchemaVersion, AgentMessageCodec>>();
  for (const codec of options.codecs) {
    assertValidVersion(codec);
    let versions = byType.get(codec.type);
    if (versions === undefined) {
      versions = new Map<AgentMessageSchemaVersion, AgentMessageCodec>();
      byType.set(codec.type, versions);
    }
    if (versions.has(codec.currentVersion)) {
      throw new AgentMessageCodecRegistryError("DUPLICATE_CODEC", codec.type);
    }
    versions.set(codec.currentVersion, codec);
  }

  const projectionVersionOf = options.projectionVersionOf;

  return {
    has(type: string, version: AgentMessageSchemaVersion): boolean {
      return byType.get(type)?.has(version) ?? false;
    },

    get(type: string, version: AgentMessageSchemaVersion): AgentMessageCodec | undefined {
      return byType.get(type)?.get(version);
    },

    encode(message: AgentMessage): AgentMessageDraft {
      const codec = byType.get(message.type)?.get(currentVersionOf(byType, message.type));
      if (codec === undefined) {
        throw new AgentMessageCodecRegistryError("UNKNOWN_MESSAGE_TYPE", message.type);
      }
      const data = codec.encode(message);
      assertJsonSafePayload(data, message.type);

      if (!message.audience.model) {
        // No model view exists, so there is no projector version to record. Writing one
        // anyway would claim a projection that never happens.
        return Object.freeze({
          message,
          data,
          schemaVersion: codec.currentVersion,
        });
      }

      const projectionVersion = projectionVersionOf?.(message.type);
      if (projectionVersion === undefined) {
        throw new AgentMessageCodecRegistryError("PROJECTION_VERSION_UNAVAILABLE", message.type);
      }
      return Object.freeze({
        message,
        data,
        schemaVersion: codec.currentVersion,
        modelProjectionVersion: projectionVersion,
      });
    },

    decode(record: AgentMessageRecord): AgentMessage {
      const codec = byType.get(record.messageType)?.get(record.schemaVersion);
      if (codec === undefined) {
        // Two distinct refusals, because a caller may want to preserve the record for
        // opposite reasons: an unknown *type* means this build has no idea what it is,
        // while an unknown *version* means it knows exactly what it is and cannot read it.
        throw new AgentMessageCodecError(
          byType.has(record.messageType) ? "UNSUPPORTED_SCHEMA_VERSION" : "CODEC_UNAVAILABLE",
          record.messageType,
          record.schemaVersion,
        );
      }
      if (record.messageType !== codec.type) {
        throw new AgentMessageCodecError("IDENTITY_MISMATCH", codec.type, record.schemaVersion);
      }
      return codec.decode(record);
    },
  };
}

/** The version `encode` writes: the newest one registered for the type. */
function currentVersionOf(
  byType: ReadonlyMap<string, ReadonlyMap<AgentMessageSchemaVersion, AgentMessageCodec>>,
  type: string,
): AgentMessageSchemaVersion {
  const versions = byType.get(type);
  if (versions === undefined) {
    throw new AgentMessageCodecRegistryError("UNKNOWN_MESSAGE_TYPE", type);
  }
  let newest: AgentMessageSchemaVersion | undefined;
  for (const version of versions.keys()) {
    if (newest === undefined || version > newest) newest = version;
  }
  if (newest === undefined) {
    throw new AgentMessageCodecRegistryError("UNKNOWN_MESSAGE_TYPE", type);
  }
  return newest;
}

function assertValidVersion(codec: AgentMessageCodec): void {
  if (!Number.isSafeInteger(codec.currentVersion) || codec.currentVersion < 1) {
    throw new AgentMessageCodecRegistryError("INVALID_VERSION", codec.type);
  }
}

/**
 * A convenience resolver over an explicit `type → version` table.
 *
 * It exists so a test, or a host that composes codecs before projectors, can state the
 * version authority explicitly instead of hardcoding a literal at the call site. It is
 * still an *injection*: nothing about it is a default.
 */
export function projectionVersionTable(
  versions: Readonly<Record<string, AgentMessageProjectionVersion>>,
): AgentMessageProjectionVersionResolver {
  return (type: string): AgentMessageProjectionVersion | undefined => versions[type];
}
