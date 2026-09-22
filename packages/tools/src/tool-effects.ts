import {
  projectExecEffects,
  projectPatchEffects,
  projectReadFileEffect,
  projectStdinEffects,
  toolEffectsToEvents as canonicalToolEffectsToEvents,
  type ToolEffect,
  type ToolEffectEventContext,
} from "@caelush/coding-agent";
import type { DurableToolEventDraft } from "./dispatcher-types.js";

/**
 * The legacy Coding effect surface — a compatibility re-export of the canonical implementation.
 *
 * ```text
 * @caelush/tools/src/tool-effects.ts          this file: the legacy names over the target functions
 *        └── re-exports ──▶  @caelush/coding-agent/tools/effects/*
 *                              effects.ts           the vocabulary and its payload kind
 *                              effect-projectors.ts the four per-Tool projectors
 *                              state-projector.ts   AgentState folding
 *                              event-projector.ts   durable event projection
 * ```
 *
 * Phase 4E split what used to be one 270-line module into four canonical modules in the Coding product
 * layer, because all four describe **Coding** facts: which durable event a `FILE_READ` produces, that
 * `FILE_CHANGE` is what moves `AgentState.changedFiles`, and that a raw shell command never enters a
 * public projection. Nothing about that changed when the owner did, so this file holds the legacy names
 * and no algorithm.
 *
 * ## Identity, not a copy
 *
 * Every name below denotes the same function object the Coding builtins publish on their
 * `CodingToolDefinition`. The registry therefore stores the canonical projector as
 * `ResolvedTool.effectProjector`, and the settlement path that reads it calls the Coding
 * implementation — there is no second algorithm for a `@caelush/tools` consumer to reach.
 *
 * ## The two event-draft declarations, and why one cast is necessary
 *
 * The canonical `CodingToolEffectEventDraft` types its discriminant as `string`, because the Coding
 * package states the nine event names as values rather than as one closed union it does not own. The
 * legacy `DurableToolEventDraft` is the Agent layer's discriminated union of the same events. The
 * canonical projector returns exactly those nine discriminants — its switch is exhaustive over the
 * effect vocabulary — so the value is a `DurableToolEventDraft` at runtime and the only difference is
 * that TypeScript cannot prove a `string` is one of fourteen literals.
 *
 * The assertion is made once here, at the boundary between the two declarations, and it is a type-level
 * statement about a value whose production is a closed switch. It cannot change which event is emitted.
 */
export type {
  ToolEffect,
  ToolEffectEventContext,
  ToolEffectProjector,
  ToolEffectProjectorInput,
} from "@caelush/coding-agent";

export {
  applyToolEffectsToAgentState,
  CODING_TOOL_EFFECTS_PAYLOAD_KIND,
  codingToolEffectsPayload,
  effectsChangeAgentState,
  MAX_CHANGED_FILES,
  SAFE_SHELL_COMMAND_LABEL,
} from "@caelush/coding-agent";
export { projectExecEffects, projectPatchEffects, projectReadFileEffect, projectStdinEffects };

/**
 * Project effects into durable host-domain event drafts.
 *
 * The canonical function; the declared return type is the Agent layer's discriminated draft union that
 * every existing caller already consumes.
 */
export function toolEffectsToEvents(
  effects: readonly ToolEffect[],
  context: ToolEffectEventContext,
): readonly DurableToolEventDraft[] {
  return canonicalToolEffectsToEvents(
    effects,
    context,
  ) as unknown as readonly DurableToolEventDraft[];
}
