import {
  CODING_TOOL_EFFECTS_EXTENSION_KIND,
  type ToolSettlementExtension,
} from "@caelush/agent";
import type { AgentState, JsonObject, TimestampMs } from "@caelush/protocol";

import type { ToolEffect } from "../effects/effects.js";

/**
 * The Coding Tool settlement extension decoder.
 *
 * ```text
 * canonical ToolResultPipeline
 *   └── opaque ToolSettlementExtension        kind = "caelush.coding.effects.v1"
 *         └── this decoder
 *               └── Coding ToolEffect[]
 *                     └── the invocation's own SQLite transaction
 * ```
 *
 * ## Why the Coding layer owns the decode and not the Agent layer
 *
 * Two Architecture V2 principles have to hold at once:
 *
 * ```text
 * @caelush/agent must not depend on the Coding overlay
 * the Coding Tool Effects must keep settling atomically with the invocation
 * ```
 *
 * A generic pass-through satisfies both. The canonical result pipeline carries an opaque
 * `{ kind, payload }` and never inspects it; the Coding layer — the only layer that knows what a
 * `FILE_READ` or a `SHELL_STARTED` is — converts it back into the effects the atomic commit understands.
 *
 * Phase 4C moved the decode *call site* into the storage compatibility boundary and Phase 4F moved the
 * decode *implementation* here, from the legacy `@caelush/tools` package. The algorithm did not change,
 * and it never gained a second implementation: this remains the one place a Coding effect is read out of
 * an extension.
 *
 * ## Atomicity is untouched
 *
 * The decoder is pure and synchronous and it owns no transaction. It returns the effects, and the caller
 * hands them to the same single `commit` call as the terminal invocation, the observation, the events
 * and the state projection. Nothing here can split that transaction in two.
 */
export function createCodingToolSettlementExtensionDecoder(input: {
  readonly effects: {
    readonly changesState: (effects: readonly unknown[]) => boolean;
    readonly apply: (
      state: AgentState,
      effects: readonly unknown[],
      now: TimestampMs,
    ) => AgentState;
  };
}): {
  decode(extension: ToolSettlementExtension): {
    readonly changeState: boolean;
    readonly apply: (state: AgentState, now: TimestampMs) => AgentState;
  };
} {
  return {
    decode(extension: ToolSettlementExtension) {
      const effects = decodeCodingToolEffects(extension);
      if (effects === undefined) {
        throw new CodingSettlementExtensionError();
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
 * Decode the opaque settlement extension back into the Coding Tool effects.
 *
 * ```text
 * canonical pipeline   produced an opaque { kind, payload } it does not interpret
 * this decoder         decodes it into the ToolEffect[] the atomic commit understands
 * ```
 *
 * The decode is total and defensive:
 *
 * ```text
 * absent extension               no effects
 * unknown kind                   a Coding-overlay contract violation the caller refuses to settle
 * payload that is not an array   the same
 * ```
 *
 * A `DEFERRED`-style "we do not know" answer is deliberately absent: an extension this host produced but
 * cannot read means the durable state would disagree with what actually happened on the workspace, so the
 * caller fails closed instead of settling without effects.
 */
export function decodeCodingToolEffects(
  extension: ToolSettlementExtension | undefined,
): readonly ToolEffect[] | undefined {
  if (extension === undefined) return [];
  if (extension.kind !== CODING_TOOL_EFFECTS_EXTENSION_KIND) return undefined;
  // The canonical payload speaks the AI package's JSON model; the Coding effect vocabulary speaks this
  // package's one. Same JSON, two declarations, so the boundary is where they meet.
  const payload = extension.payload as unknown as JsonObject;
  const effects = payload.effects;
  if (!Array.isArray(effects)) return undefined;
  return effects as unknown as readonly ToolEffect[];
}

/** A settlement extension this host's Coding overlay did not declare. */
export class CodingSettlementExtensionError extends Error {
  constructor() {
    super("Tool settlement carried an unknown settlement extension.");
    this.name = "CodingSettlementExtensionError";
  }
}
