import type { JsonObject } from "@caelush/ai";
import type { FileChangeSummary, ProcessStatus, ToolInvocationId } from "@caelush/protocol";

/**
 * The Coding Tool effect vocabulary.
 *
 * ```text
 * FILE_READ         a file was read
 * FILE_CHANGE       a file was created, modified, deleted or moved
 * SHELL_STARTED     a shell command began
 * SHELL_COMPLETED   a shell command finished
 * PROCESS_STARTED   a process session became active
 * PROCESS_STOPPED   a process session ended
 * ```
 *
 * ## Facts, not state
 *
 * An effect is a statement about what happened. The vocabulary is deliberately flat and JSON-safe so it
 * can be carried opaquely: `@caelush/agent` moves these values through the canonical result pipeline
 * inside an opaque `{ kind, payload }` settlement extension and never inspects them. Only this Coding
 * overlay knows that `FILE_CHANGE` updates `AgentState.changedFiles`, and only this overlay knows which
 * durable event a `FILE_READ` produces.
 *
 * Splitting the vocabulary from its consumers is the point of this module: `effects.ts` states the facts,
 * `effect-projectors.ts` derives them from a Tool result, `state-projector.ts` folds them into
 * `AgentState`, and `event-projector.ts` turns them into durable events. One file used to do all four.
 */

export const SAFE_SHELL_COMMAND_LABEL = "shell command";
export const MAX_CHANGED_FILES = 500;

export type ToolEffect =
  | { readonly type: "FILE_READ"; readonly path: string }
  | {
      readonly type: "FILE_CHANGE";
      readonly summary: FileChangeSummary;
      readonly fromPath?: string;
      readonly toPath?: string;
    }
  | { readonly type: "SHELL_STARTED"; readonly invocationId: ToolInvocationId }
  | {
      readonly type: "SHELL_COMPLETED";
      readonly invocationId: ToolInvocationId;
      readonly exitCode?: number;
      readonly signal?: string;
    }
  | { readonly type: "PROCESS_STARTED"; readonly sessionId: string }
  | {
      readonly type: "PROCESS_STOPPED";
      readonly sessionId: string;
      readonly status?: ProcessStatus;
    };

/**
 * Whether a set of effects changes durable AgentState.
 *
 * Read-only effects — `FILE_READ`, `SHELL_STARTED`, `SHELL_COMPLETED` — deliberately do not. That is
 * what lets a settlement skip the state projection entirely for a pure read, rather than writing an
 * unchanged state row.
 */
export function effectsChangeAgentState(effects: readonly ToolEffect[]): boolean {
  return effects.some(
    (effect) =>
      effect.type === "FILE_CHANGE" ||
      effect.type === "PROCESS_STARTED" ||
      effect.type === "PROCESS_STOPPED",
  );
}

/**
 * The canonical Coding effect payload kind.
 *
 * It is the discriminator the opaque settlement extension carries. `@caelush/agent` passes it through
 * and never branches on it; this overlay and its storage decoder are the only readers.
 */
export const CODING_TOOL_EFFECTS_PAYLOAD_KIND = "caelush.coding.effects.v1";

/** The extension payload shape: a JSON-safe `{ effects }` envelope. */
export function codingToolEffectsPayload(effects: readonly ToolEffect[]): JsonObject {
  return { effects: effects as unknown as JsonObject["effects"] };
}
