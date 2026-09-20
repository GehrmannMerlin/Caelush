import type { AgentState, JsonObject, TimestampMs } from "@caelush/protocol";
import { CODING_TOOL_EFFECTS_EXTENSION_KIND, type ToolSettlementExtension } from "@caelush/agent";

/**
 * The Tool settlement extension compatibility decoder.
 *
 * ```text
 * canonical ToolResultPipeline
 *   └── generic opaque ToolSettlementExtension   kind = "caelush.coding.effects.v1"
 *         └── this decoder
 *               └── existing Coding ToolEffect[]
 *                     └── existing AgentState projection
 *                           └── the invocation's own SQLite transaction
 * ```
 *
 * ## Why the decode moved
 *
 * Before Phase 4C the legacy shell read the extension back out and handed the resulting `ToolEffect[]`
 * to `commit`. That made the *executor* the layer that understood a Coding effect vocabulary, and it
 * made the effects an argument rather than an extension.
 *
 * The decode belongs where the effects are actually consumed: the storage transaction that projects
 * them onto the host's `AgentState`. The Agent layer carries the extension and never reads its `kind`;
 * this boundary reads it, once, right before the projection.
 *
 * ## Why it is injected rather than imported
 *
 * `@caelush/storage` may depend on `@caelush/agent` and `@caelush/protocol` only. The Coding effect
 * vocabulary lives in the legacy Tool System, so the store takes this decoder as a constructor
 * dependency and the composition root supplies it. The dependency is explicit, narrow and named: the
 * storage package never imports a Coding effect type, and there is no second effects model.
 *
 * ## Unknown kinds fail closed
 *
 * A decoder that meets an extension kind it did not declare throws. The alternative — ignoring it —
 * would record a Tool as `COMPLETED` while the effects it had are silently lost, which is a durable
 * state that disagrees with the workspace and that nothing downstream can detect.
 */
export interface ToolSettlementExtensionDecoder {
  /**
   * Decode the extension into whatever this host projects onto its own state.
   *
   * `undefined` means "no host projection", which is the honest answer for an invocation that produced
   * no effects and for a host that has no effect vocabulary at all. An extension the decoder does not
   * recognize is a throw, never `undefined`.
   */
  decode(extension: ToolSettlementExtension): HostToolEffects | undefined;
}

/**
 * The host's Coding Tool effects projection.
 *
 * ```text
 * changesState(effects)                    does this change the durable AgentState projection?
 * apply(state, effects, now)               project it
 * ```
 *
 * Two operations, and deliberately no effect *type*: `@caelush/storage` may not depend on the legacy
 * Tool System, so it never learns what a `FILE_CHANGE` is. The production composition supplies these
 * two functions from the existing `effectsChangeAgentState` / `applyToolEffectsToAgentState`, so the
 * projection is the one the pre-4C shell performed — only the caller moved.
 */
export interface HostToolEffectsPort {
  changesState(effects: readonly unknown[]): boolean;
  apply(state: AgentState, effects: readonly unknown[], now: TimestampMs): AgentState;
}

/**
 * The host effects projection, derived from the production Tool-effect functions.
 *
 * It exists so a composition writes one line rather than four, and so the compatibility boundary has a
 * named shape instead of an ad-hoc pair of closures.
 */
export function toHostToolEffectsPort(input: HostToolEffectsPort): HostToolEffectsPort {
  return input;
}

/**
 * The host's own effect value.
 *
 * It is deliberately opaque here: the storage package carries it, hands it back to the same decoder and
 * asks whether it changes state. It never inspects it, so it cannot grow into a second effect model.
 */
export type HostToolEffects = {
  readonly changeState: boolean;
  readonly apply: (state: AgentState, now: TimestampMs) => AgentState;
};

/** The extension kind the production Coding Tool effects are carried under. */
export const CODING_EFFECTS_EXTENSION_KIND = CODING_TOOL_EFFECTS_EXTENSION_KIND;

/**
 * Build a decoder from the legacy Tool System's effect projection.
 *
 * The supplied callbacks are the *existing* implementations —
 * `effectsChangeAgentState` and `applyToolEffectsToAgentState` — so the projection is byte-for-byte the
 * one the pre-4C shell performed; only the caller changed.
 */
export function createHostToolEffectsDecoder(input: {
  /**
   * Read the host's effect values out of a recognized extension.
   *
   * `undefined` means "this extension is not mine", which fails the transaction closed. The callback is
   * also where a malformed payload is detected; it may throw, or it may return `undefined`.
   */
  readonly readEffects: (extension: ToolSettlementExtension) => readonly unknown[] | undefined;
  readonly effects: HostToolEffectsPort;
  readonly unknownKindMessage?: string;
}): ToolSettlementExtensionDecoder {
  return {
    decode(extension: ToolSettlementExtension): HostToolEffects | undefined {
      const effects = input.readEffects(extension);
      if (effects === undefined) {
        throw new ToolSettlementExtensionError(input.unknownKindMessage);
      }
      const frozen = Object.freeze([...effects]);
      return {
        changeState: input.effects.changesState(frozen),
        apply: (state: AgentState, now: TimestampMs): AgentState =>
          input.effects.apply(state, frozen, now),
      };
    },
  };
}

/**
 * Build the production decoder from the Coding Tool effects overlay.
 *
 * ```text
 * extension.kind !== "caelush.coding.effects.v1"   → refuse; the transaction rolls back
 * payload.effects is not an array                  → refuse; the transaction rolls back
 * otherwise                                        → the existing ToolEffect[] projection
 * ```
 *
 * A host passes its own effect values and its own projection, because the only thing a decoder can
 * safely assume about effects is that the host knows what they mean.
 */
export function createCodingToolEffectsDecoder(input: {
  readonly readEffects: (extension: ToolSettlementExtension) => readonly unknown[] | undefined;
  readonly effects: HostToolEffectsPort;
}): ToolSettlementExtensionDecoder {
  return createHostToolEffectsDecoder({
    readEffects: input.readEffects,
    effects: input.effects,
    unknownKindMessage: "Tool settlement carried an unknown settlement extension.",
  });
}

/**
 * A settlement extension could not be decoded.
 *
 * It is a `SETTLEMENT`-phase infrastructure failure: the transaction rolls back, the invocation keeps
 * the state it had, and nothing claims a Tool completed while its effects are unaccounted for.
 */
export class ToolSettlementExtensionError extends Error {
  constructor(message = "Tool settlement carried an unknown settlement extension.") {
    super(message);
    this.name = "ToolSettlementExtensionError";
  }
}

/** Narrow a decoded payload to a JSON object without asserting anything about its contents. */
export function asJsonObject(value: unknown): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}
