import type { AgentMessageCodec } from "./codec.js";
import type {
  AgentMessageCodecRegistry,
  AgentMessageCodecRegistryBuilder,
  AgentMessageProjectionVersionResolver,
} from "./registry.js";
import { AgentMessageCodecRegistryError, createAgentMessageCodecRegistry } from "./registry.js";
import {
  AGENT_ASSISTANT_MESSAGE_CODEC_V1,
  AGENT_TOOL_RESULT_MESSAGE_CODEC_V1,
  AGENT_USER_MESSAGE_CODEC_V1,
} from "./standard-codecs.js";

/**
 * The builder that produces one immutable codec-registry generation.
 *
 * ```text
 * register(codec)   collects a codec, refusing an invalid version immediately
 * build()           produces the registry and closes this builder
 * ```
 *
 * ## A built registry cannot be changed
 *
 * ```text
 * build() twice           the second call throws; one builder makes one generation
 * register() after build  throws, rather than mutating a registry in use
 * ```
 *
 * The rule is the same one the Model, Tool and (below) Projector registries already
 * follow. A registry that could grow after it was handed to a caller would make "the
 * codecs this build understands" depend on *when* the question was asked, which is
 * exactly the property a durable decoder must not have.
 *
 * ## Duplicate and invalid registrations are refused at registration, not at build
 *
 * A duplicate `type` + `version` is a configuration error, and reporting it when the
 * second codec is registered names the offending codec rather than the whole build. A
 * version that is not a positive safe integer cannot select anything, so it is refused
 * before it can be stored in the map at all.
 */
export class DefaultAgentMessageCodecRegistryBuilder implements AgentMessageCodecRegistryBuilder {
  readonly #codecs: AgentMessageCodec[] = [];
  readonly #seen = new Set<string>();
  readonly #projectionVersionOf: AgentMessageProjectionVersionResolver | undefined;
  #built = false;

  constructor(projectionVersionOf?: AgentMessageProjectionVersionResolver | undefined) {
    this.#projectionVersionOf = projectionVersionOf;
  }

  register(codec: AgentMessageCodec): this {
    if (this.#built) {
      throw new AgentMessageCodecRegistryError("DUPLICATE_CODEC", codec.type);
    }
    if (!Number.isSafeInteger(codec.currentVersion) || codec.currentVersion < 1) {
      throw new AgentMessageCodecRegistryError("INVALID_VERSION", codec.type);
    }
    const key = `${codec.type}\u0000${String(codec.currentVersion)}`;
    if (this.#seen.has(key)) {
      throw new AgentMessageCodecRegistryError("DUPLICATE_CODEC", codec.type);
    }
    this.#seen.add(key);
    this.#codecs.push(codec);
    return this;
  }

  build(): AgentMessageCodecRegistry {
    if (this.#built) {
      throw new AgentMessageCodecRegistryError("DUPLICATE_CODEC", "build");
    }
    this.#built = true;
    return createAgentMessageCodecRegistry({
      codecs: [...this.#codecs],
      projectionVersionOf: this.#projectionVersionOf,
    });
  }
}

/**
 * Create a fresh builder.
 *
 * `projectionVersionOf` is the same explicit version authority
 * {@link createAgentMessageCodecRegistry} takes, passed through so a caller composes the
 * whole codec layer in one place.
 */
export function createAgentMessageCodecRegistryBuilder(
  projectionVersionOf?: AgentMessageProjectionVersionResolver | undefined,
): AgentMessageCodecRegistryBuilder {
  return new DefaultAgentMessageCodecRegistryBuilder(projectionVersionOf);
}

/**
 * Build the registry over the three standard codecs.
 *
 * The one call a host that wants the canonical message vocabulary needs. A host that
 * registers a custom message type builds its own registry instead, or registers onto this
 * one — neither is a fork of the standard vocabulary.
 */
export function createStandardAgentMessageCodecRegistry(
  projectionVersionOf?: AgentMessageProjectionVersionResolver | undefined,
): AgentMessageCodecRegistry {
  return createAgentMessageCodecRegistryBuilder(projectionVersionOf)
    .register(AGENT_USER_MESSAGE_CODEC_V1)
    .register(AGENT_ASSISTANT_MESSAGE_CODEC_V1)
    .register(AGENT_TOOL_RESULT_MESSAGE_CODEC_V1)
    .build();
}
