import {
  ToolExecutionInfrastructureError,
  type DurableToolEventDraft,
  type PreparedToolCall,
  type ToolSettlementExtension,
  type ToolSettlementExtensionProjector,
} from "@caelush/agent";
import type { EventId, SessionId, TimestampMs, ToolInvocation } from "@caelush/protocol";

import { CODING_TOOL_EFFECTS_PAYLOAD_KIND, codingToolEffectsPayload, type ToolEffect } from "../effects/effects.js";
import { toolEffectsToEvents } from "../effects/event-projector.js";
import type { CodingToolCatalog } from "../coding-tool-catalog.js";

/**
 * What the settlement projector is given about the invocation being settled.
 *
 * The canonical `PreparedToolCall` carries the request, the resolved Tool and the effective arguments,
 * but not the durable identity or the environment locator: those belong to the executor, not to a result
 * projection. The Coding effect projector needs them, so the layer that owns the durable row supplies
 * them explicitly.
 */
export interface CodingSettlementContext {
  readonly invocation: ToolInvocation;
  /**
   * The Session the Run belongs to.
   *
   * An invocation carries its Run and Step but not its Session. It is optional because a host without it
   * simply produces no effect events; the effects themselves are unaffected.
   */
  readonly sessionId?: SessionId | undefined;
  readonly environment: import("@caelush/agent").ToolExecutionEnvironment;
  /**
   * The next durable event identity, for an extension that contributes events.
   *
   * It is the same factory the settlement itself uses, so an effect event and the terminal event it
   * accompanies are drawn from one sequence. Absent means this host contributes no events.
   */
  readonly nextEventId?: (() => EventId) | undefined;
  readonly presentation?: import("@caelush/agent").ToolPresentationPort | undefined;
}

/**
 * The Coding settlement extension projector.
 *
 * ```text
 * canonical ToolResultPipeline
 *   └── this projector                       after sanitization and revalidation, never before
 *         ├── the Tool's own effectProjector  CodingToolCatalog
 *         ├── the opaque { kind, payload }    caelush.coding.effects.v1
 *         └── the host-domain event drafts    file.read, file.modified, process.started, ...
 * ```
 *
 * ## Why the Coding layer owns it
 *
 * Two Architecture V2 principles have to hold at once:
 *
 * ```text
 * @caelush/agent must not depend on the Coding overlay
 * the Coding Tool Effects must keep settling atomically with the invocation
 * ```
 *
 * A generic pass-through satisfies both: the Agent layer carries an opaque `{ kind, payload }` and never
 * inspects it, and this projector — the only layer that knows what a `FILE_CHANGE` is — produces it.
 * Phase 4F moved it here from the legacy `@caelush/tools` package; before that it read the projector back
 * out of a compatibility registry view, and now it reads the same function out of the catalog the Coding
 * product layer itself built.
 *
 * The resolved Tool is found by name from the call the canonical pipeline hands the projector, so one
 * projector instance serves a whole catalog and no per-invocation mutable binding is needed.
 *
 * ## Atomicity is untouched
 *
 * The projector is pure and synchronous. It produces a value the durable coordinator hands to the same
 * single `commit` call as the terminal invocation, the observation, the events and the state projection.
 * Nothing here can split that transaction in two.
 *
 * ## A throwing projector fails closed
 *
 * An effect that cannot be projected must not be silently dropped: the durable state would then disagree
 * with what actually happened on the workspace. Both an effect failure and an event failure become a
 * `RESULT_PIPELINE` infrastructure failure, which leaves the invocation `RUNNING` rather than settling it
 * without effects — the same disposition the pre-4F bridge had.
 */
export function createCodingToolSettlementExtensionProjector(input: {
  readonly catalog: Pick<CodingToolCatalog, "get">;
  readonly invocation: CodingSettlementContext;
}): ToolSettlementExtensionProjector {
  return ({ call, result, now }) => {
    const effectProjector = input.catalog.get(call.resolved.tool.name)?.effectProjector;
    if (effectProjector === undefined) return undefined;

    let effects: readonly ToolEffect[];
    try {
      effects = effectProjector({
        request: {
          runId: input.invocation.invocation.runId,
          stepId: input.invocation.invocation.stepId,
          invocationId: input.invocation.invocation.id,
          externalCallId: call.request.externalCallId,
          args: call.args,
          environment: input.invocation.environment,
        } as never,
        result: {
          content: result.content,
          details: result.details,
          isError: result.isError,
        },
        now,
      }) as readonly ToolEffect[];
    } catch (error) {
      throw new ToolExecutionInfrastructureError(
        "RESULT_PIPELINE",
        "Tool effect projection failed.",
        { cause: error },
      );
    }

    const events = projectEffectEvents(effects, now, input.invocation);
    return Object.freeze({
      kind: CODING_TOOL_EFFECTS_PAYLOAD_KIND,
      payload: codingToolEffectsPayload(effects),
      ...(events.length === 0 ? {} : { events: Object.freeze([...events]) }),
    }) satisfies ToolSettlementExtension;
  };
}

/**
 * The durable host-domain events the effects imply, when this host can produce them.
 *
 * A Tool effect is a fact about what happened, and `toolEffectsToEvents` turns it into the event a host
 * already consumes — `file.read`, `file.modified`, `process.started`. The canonical settlement carries
 * those drafts opaquely and appends them in the same transaction, so the Agent layer still never learns
 * what a `FILE_CHANGE` is.
 *
 * A host that supplied no `sessionId` or no event id factory contributes no events. That is not a
 * degradation: it is a host that consumes effects without an event stream, and inventing an identity for
 * it would create a second ordering authority.
 */
function projectEffectEvents(
  effects: readonly ToolEffect[],
  now: TimestampMs,
  context: CodingSettlementContext,
): readonly DurableToolEventDraft[] {
  const sessionId = context.sessionId;
  const nextEventId = context.nextEventId;
  if (sessionId === undefined || nextEventId === undefined) return [];
  try {
    return toolEffectsToEvents(effects, {
      runId: context.invocation.runId,
      sessionId,
      stepId: context.invocation.stepId,
      timestamp: now,
      nextEventId,
      invocation: context.invocation,
      ...(context.presentation === undefined ? {} : { presentation: context.presentation }),
    }) as unknown as readonly DurableToolEventDraft[];
  } catch (error) {
    // An event that cannot be projected is the same failure as an effect that cannot: the host's durable
    // record would be incomplete in a way nothing downstream can detect.
    throw new ToolExecutionInfrastructureError(
      "RESULT_PIPELINE",
      "Tool effect event projection failed.",
      { cause: error },
    );
  }
}

export type { PreparedToolCall };
