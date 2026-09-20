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
  readonly runId: import("@caelush/protocol").RunId;
  readonly sourceStepId: import("@caelush/protocol").StepId;
  readonly invocationId: import("@caelush/protocol").ToolInvocationId;
  readonly environment: import("@caelush/agent").ToolExecutionEnvironment;
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
          runId: input.invocation.runId,
          stepId: input.invocation.sourceStepId,
          invocationId: input.invocation.invocationId,
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

    return Object.freeze({
      kind: CODING_TOOL_EFFECTS_EXTENSION_KIND,
      payload: input.effectsPayload(effects),
    }) satisfies ToolSettlementExtension;
  };
}
