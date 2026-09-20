import {
  CODING_TOOL_EFFECTS_EXTENSION_KIND,
  ToolExecutionInfrastructureError,
  type ToolSettlementExtension,
  type ToolSettlementExtensionProjector,
} from "@caelush/agent";
import type { JsonObject } from "@caelush/protocol";

import type { ResolvedTool } from "./registry.js";
import type { ToolEffect } from "./tool-effects.js";

/**
 * What the bridge is given about the invocation being settled.
 *
 * The canonical `PreparedToolCall` carries the request, the resolved Tool and the effective
 * arguments, but not the durable identity or the environment locator: those belong to the executor,
 * not to a result projection. The legacy `ToolEffectProjector` needs them, so the layer that owns
 * the durable row supplies them explicitly.
 */
export interface SettlementInvocationContext {
  readonly invocation: import("@caelush/protocol").ToolInvocation;
  /**
   * The Session the Run belongs to.
   *
   * An invocation carries its Run and Step but not its Session. It is optional because a host without
   * it simply produces no effect events; the effects themselves are unaffected.
   */
  readonly sessionId?: import("@caelush/protocol").SessionId | undefined;
  readonly environment: import("@caelush/agent").ToolExecutionEnvironment;
  /**
   * The next durable event identity, for an extension that contributes events.
   *
   * It is the same factory the settlement itself uses, so an effect event and the terminal event it
   * accompanies are drawn from one sequence. Absent means this host contributes no events.
   */
  readonly nextEventId?: (() => import("@caelush/protocol").EventId) | undefined;
  readonly presentation?: import("./presentation.js").ToolPresentationPort | undefined;
}

/**
 * The Coding effect compatibility bridge.
 *
 * ```text
 * canonical ToolResultPipeline
 *   └── generic opaque ToolSettlementExtension   kind = "caelush.coding.effects.v1"
 *         └── this bridge
 *               └── existing ToolEffect[]
 *                     └── existing atomic SQLite settlement
 * ```
 *
 * Two Architecture V2 principles have to hold at once:
 *
 * ```text
 * @caelush/agent must not depend on the Coding overlay
 * the existing Coding Tool Effects must keep settling atomically with the invocation
 * ```
 *
 * A generic pass-through satisfies both. The Agent result layer carries an opaque `{ kind, payload }`
 * and never inspects it; this bridge — which lives in the legacy composition, the layer that already
 * owns `ToolEffect[]` — converts between the two representations. Coding effect ownership still moves
 * to the Coding counterpart of the Agent layer in Phase 4E; this round builds the bridge, not the
 * move.
 *
 * The resolved Tool is found by name from the call the canonical pipeline hands the projector, so one
 * projector instance serves a whole registry and no per-invocation mutable binding is needed.
 *
 * ## Atomicity is untouched
 *
 * The bridge is pure and synchronous. It produces a value the existing shell hands to the same single
 * `commit` call as the terminal invocation, the observation, the events and the state effects.
 * Nothing here can split that transaction in two.
 */
export function createLegacyToolSettlementExtensionProjector(input: {
  readonly registry: {
    resolve(name: import("@caelush/protocol").ToolName): ResolvedTool | undefined;
  };
  readonly invocation: SettlementInvocationContext;
  readonly effectsPayload: (effects: readonly ToolEffect[]) => JsonObject;
  /**
   * Project the effects into the durable host-domain events they imply.
   *
   * A Tool effect is a fact about what happened, and the existing `toolEffectsToEvents` turns it into
   * the event a host already consumes — `file.read`, `file.modified`, `process.started`. The canonical
   * settlement carries those drafts opaquely and appends them in the same transaction, so the Agent
   * layer still never learns what a `FILE_CHANGE` is.
   */
  readonly effectEvents?:
    | ((
        effects: readonly ToolEffect[],
        context: {
          readonly sessionId: import("@caelush/protocol").SessionId;
          readonly nextEventId: () => import("@caelush/protocol").EventId;
        },
      ) => readonly import("@caelush/agent").DurableToolEventDraft[])
    | undefined;
}): ToolSettlementExtensionProjector {
  return ({ call, result, now }) => {
    const legacy = input.registry.resolve(call.resolved.tool.name);
    const effectProjector = legacy?.effectProjector as
      | ((projection: {
          readonly request: unknown;
          readonly result: {
            readonly content: string;
            readonly details: JsonObject;
            readonly isError: boolean;
          };
          readonly now: number;
        }) => readonly ToolEffect[])
      | undefined;
    if (effectProjector === undefined) return undefined;

    let effects: readonly ToolEffect[];
    try {
      effects = effectProjector({
        request: {
          runId: input.invocation.invocation.runId,
          stepId: input.invocation.invocation.stepId,
          invocationId: input.invocation.invocation.id,
          externalCallId: call.request.externalCallId,
          args: call.args as unknown as JsonObject,
          environment: input.invocation.environment,
        },
        result: {
          content: result.content,
          details: result.details as unknown as JsonObject,
          isError: result.isError,
        },
        now,
      });
    } catch (error) {
      // An effect that cannot be projected must not be silently dropped: the durable state would then
      // disagree with what actually happened on the workspace.
      throw new ToolExecutionInfrastructureError(
        "RESULT_PIPELINE",
        "Tool effect projection failed.",
        { cause: error },
      );
    }

    let events: readonly import("@caelush/agent").DurableToolEventDraft[] = [];
    const sessionId = input.invocation.sessionId;
    const nextEventId = input.invocation.nextEventId;
    if (input.effectEvents !== undefined && sessionId !== undefined && nextEventId !== undefined) {
      try {
        events = input.effectEvents(effects, { sessionId, nextEventId });
      } catch (error) {
        // An event that cannot be projected is the same failure as an effect that cannot: the host's
        // durable record would be incomplete in a way nothing downstream can detect.
        throw new ToolExecutionInfrastructureError(
          "RESULT_PIPELINE",
          "Tool effect event projection failed.",
          { cause: error },
        );
      }
    }

    return Object.freeze({
      kind: CODING_TOOL_EFFECTS_EXTENSION_KIND,
      payload: input.effectsPayload(effects),
      ...(events.length === 0 ? {} : { events: Object.freeze([...events]) }),
    }) satisfies ToolSettlementExtension;
  };
}

/**
 * Decode the opaque settlement extension back into the existing Coding Tool effects.
 *
 * ```text
 * canonical pipeline   produced an opaque { kind, payload } it does not interpret
 * this bridge          decodes it into the ToolEffect[] the atomic commit understands
 * ```
 *
 * The decode is total and defensive:
 *
 * ```text
 * absent extension            no effects
 * unknown kind                a Coding-overlay contract violation the caller refuses to settle
 * payload that is not an array   the same
 * ```
 *
 * Phase 4C moved the *call site* of this decode from the legacy shell to the storage compatibility
 * boundary. The algorithm did not change, and it did not gain a second implementation: this remains the
 * one place a Coding effect is read out of an extension.
 */
export function decodeLegacyToolEffects(
  extension: ToolSettlementExtension | undefined,
): readonly ToolEffect[] | undefined {
  if (extension === undefined) return [];
  if (extension.kind !== CODING_TOOL_EFFECTS_EXTENSION_KIND) return undefined;
  // The canonical payload speaks the AI package's JSON model; the Coding effect vocabulary speaks the
  // legacy one. Same JSON, two declarations, so the boundary is where they meet.
  const payload = extension.payload as unknown as JsonObject;
  const effects = payload.effects;
  if (!Array.isArray(effects)) return undefined;
  return effects as unknown as readonly ToolEffect[];
}
