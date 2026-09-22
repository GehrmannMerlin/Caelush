import { assertAIConversationMessage } from "@caelush/ai";
import type { AIConversationMessage } from "@caelush/ai";

import type { AgentMessage } from "../types/agent-message.js";
import type { AgentMessageProjectionVersion, StoredAgentMessage } from "../persistence/record.js";
import { EMPTY_AGENT_MESSAGE_AI_PROJECTION, createAgentMessageAIProjection } from "./projector.js";
import type { AgentMessageAIProjection, AgentMessageProjector } from "./projector.js";
import { AgentMessageProjectionError } from "./errors.js";
import { STANDARD_AGENT_MESSAGE_PROJECTORS } from "./standard-projectors.js";

/**
 * The versioned projector registry — the model-visibility boundary.
 *
 * ```text
 * has(type, version)     is there a projector for exactly this pair?
 * get(type, version)     the projector, or undefined
 * project(stored)        one stored message → what the model is shown
 * ```
 *
 * ## Three decisions, and each one fails closed
 *
 * ```text
 * audience.model = false                    → { messages: [], fingerprint: empty digest }
 *                                              no projector is needed and none is consulted
 * audience.model = true, version absent     → PROJECTION_VERSION_UNAVAILABLE
 * audience.model = true, no such projector  → UNKNOWN_MODEL_VISIBLE_MESSAGE
 * ```
 *
 * The middle rule is the one worth stating twice. `StoredAgentMessage.modelProjectionVersion`
 * is the *authority* for which projector reads a historical message, and "the newest
 * projector" is not a substitute for it. A message projected under v1 must keep being
 * projected under v1 even after the repository ships v2, or the model would be shown a
 * conversation that never happened and the durable fingerprint would describe nothing.
 *
 * ## A projector may not return a system message
 *
 * The frozen `AgentMessageProjector.project()` already returns `AIConversationMessage[]`,
 * which excludes `AISystemMessage`, so this is a compile-time fact. The registry checks it
 * again at run time anyway, because a projector is an injected boundary: a custom message
 * type's projector may reach the registry through a widened type, and a system prompt
 * arriving in the middle of a durable conversation is severe enough that "the type system
 * said so" is not the only defence worth having.
 *
 * ## Projection is not conversation validation
 *
 * The registry answers "what does this one message look like to the model?". Whether the
 * resulting *sequence* of messages is a legal conversation — every Tool call answered,
 * every answer attributed — is the Conversation Validator's question, and it is asked
 * once over a whole snapshot rather than once per message.
 */
export interface AgentMessageProjectorRegistry {
  has(type: string, version: AgentMessageProjectionVersion): boolean;

  get(type: string, version: AgentMessageProjectionVersion): AgentMessageProjector | undefined;

  project(stored: StoredAgentMessage): AgentMessageAIProjection;
}

/**
 * The version authority the codec registry asks for.
 *
 * `currentVersion(type)` is "which projector would read a *new* message of this type?".
 * It is the registry's own answer, computed from what is registered, so no layer has to
 * hardcode a projection version and no codec has to know what a projector is.
 *
 * It is optional on the interface rather than required, because the frozen
 * `AgentMessageProjectorRegistry` contract does not name it: a registry that implements
 * only the frozen three methods is a complete registry. A registry missing it simply
 * cannot answer the codec registry's version question, and the codec registry then fails
 * closed — which is the correct outcome, not a degraded one.
 */
export interface AgentMessageProjectionVersionAuthority {
  currentVersion(type: string): AgentMessageProjectionVersion | undefined;
}

/** A registry that also answers the current-version question. */
export type AgentMessageProjectorRegistryWithVersions = AgentMessageProjectorRegistry &
  AgentMessageProjectionVersionAuthority;

/**
 * Build one immutable projector-registry generation.
 *
 * The same build discipline every other registry in the architecture follows: `build()` is
 * terminal, a duplicate `type` + `version` is a configuration error, and a version that is
 * not a positive safe integer is refused at registration.
 */
export function createAgentMessageProjectorRegistry(options: {
  readonly projectors: readonly AgentMessageProjector[];
}): AgentMessageProjectorRegistryWithVersions {
  const byType = new Map<string, Map<AgentMessageProjectionVersion, AgentMessageProjector>>();
  for (const projector of options.projectors) {
    if (!Number.isSafeInteger(projector.version) || projector.version < 1) {
      throw new RangeError(
        `Agent message projector ${JSON.stringify(projector.type)} declares an invalid version.`,
      );
    }
    let versions = byType.get(projector.type);
    if (versions === undefined) {
      versions = new Map<AgentMessageProjectionVersion, AgentMessageProjector>();
      byType.set(projector.type, versions);
    }
    if (versions.has(projector.version)) {
      throw new RangeError(
        `An agent message projector is already registered for type ${JSON.stringify(projector.type)} at version ${String(projector.version)}.`,
      );
    }
    versions.set(projector.version, projector);
  }

  function currentVersion(type: string): AgentMessageProjectionVersion | undefined {
    const versions = byType.get(type);
    if (versions === undefined) return undefined;
    let newest: AgentMessageProjectionVersion | undefined;
    for (const version of versions.keys()) {
      if (newest === undefined || version > newest) newest = version;
    }
    return newest;
  }

  return {
    has(type: string, version: AgentMessageProjectionVersion): boolean {
      return byType.get(type)?.has(version) ?? false;
    },

    get(type: string, version: AgentMessageProjectionVersion): AgentMessageProjector | undefined {
      return byType.get(type)?.get(version);
    },

    currentVersion,

    project(stored: StoredAgentMessage): AgentMessageAIProjection {
      const message: AgentMessage = stored.message;

      if (!message.audience.model) {
        // Not model-visible: no projector, no version, no cost. Answering with the empty
        // projection rather than throwing is the contract — a debug-only or transcript-only
        // message is a legitimate message that the model simply does not see.
        return EMPTY_AGENT_MESSAGE_AI_PROJECTION;
      }

      const version = stored.modelProjectionVersion;
      if (version === undefined) {
        throw new AgentMessageProjectionError("PROJECTION_VERSION_UNAVAILABLE", message.type);
      }
      const projector = byType.get(message.type)?.get(version);
      if (projector === undefined) {
        throw new AgentMessageProjectionError(
          "UNKNOWN_MODEL_VISIBLE_MESSAGE",
          message.type,
          version,
        );
      }

      const projection = projector.project(message);
      assertProjectedConversation(projection, message.type, version);
      return projection;
    },
  };
}

/**
 * Prove that a projection is something a model can actually be sent.
 *
 * ```text
 * every message is a user, assistant or tool message   never a system instruction
 * every tool message names a call and an answer        no anonymous Tool result
 * an assistant message is never empty                  a provider rejects an empty turn
 * ```
 *
 * These are structural checks on a projection whose type already promises them. They exist
 * because a projector is injected: a custom message type may register one from outside this
 * package, and the cost of checking is trivial next to the cost of sending a malformed
 * conversation to a provider.
 */
function assertProjectedConversation(
  projection: AgentMessageAIProjection,
  type: string,
  version: AgentMessageProjectionVersion,
): void {
  if (projection.messages.length === 0) {
    // A model-visible message that projects to nothing is a contradiction: it was marked as
    // something the model should see, and the projection says the model sees nothing.
    throw new AgentMessageProjectionError("INVALID_PROJECTED_CONVERSATION", type, version);
  }
  for (const message of projection.messages) {
    try {
      assertAIConversationMessage(message);
    } catch {
      // A system instruction, or a structurally invalid message. Either way it is not a
      // conversation, and the refusal must not quote the message back.
      throw new AgentMessageProjectionError("INVALID_PROJECTED_CONVERSATION", type, version);
    }
  }
}

/**
 * Compare a stored message's recorded projection fingerprint against a fresh one.
 *
 * This is the one place `PROJECTION_FINGERPRINT_MISMATCH` is raised, and it exists so
 * Phase 5B can prove that re-projecting a message under its *stored* version reproduces
 * exactly what the model was shown. A mismatch means a projector was edited without a
 * version bump — the failure that turns a durable history into a plausible fiction — so it
 * is an error rather than a warning.
 */
export function assertProjectionFingerprint(
  stored: StoredAgentMessage,
  expectedFingerprint: string,
  registry: AgentMessageProjectorRegistry,
): AgentMessageAIProjection {
  const projection = registry.project(stored);
  if (projection.fingerprint !== expectedFingerprint) {
    throw new AgentMessageProjectionError(
      "PROJECTION_FINGERPRINT_MISMATCH",
      stored.message.type,
      stored.modelProjectionVersion,
    );
  }
  return projection;
}

/** Project a whole conversation, concatenating each message's projection in order. */
export function projectStoredMessages(
  stored: readonly StoredAgentMessage[],
  registry: AgentMessageProjectorRegistry,
): AgentMessageAIProjection {
  const messages: AIConversationMessage[] = [];
  for (const entry of stored) {
    messages.push(...registry.project(entry).messages);
  }
  return createAgentMessageAIProjection(messages);
}

/**
 * Build the registry over the three standard projectors.
 *
 * A host that registers a custom message type composes its own projector list; it does not
 * fork the standard three.
 */
export function createStandardAgentMessageProjectorRegistry(): AgentMessageProjectorRegistryWithVersions {
  return createAgentMessageProjectorRegistry({
    projectors: [...STANDARD_AGENT_MESSAGE_PROJECTORS],
  });
}
