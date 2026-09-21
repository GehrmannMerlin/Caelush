import type { AgentState, TimestampMs } from "@caelush/protocol";

import { MAX_CHANGED_FILES, SAFE_SHELL_COMMAND_LABEL, type ToolEffect } from "./effects.js";

/**
 * Fold Coding Tool effects into `AgentState`.
 *
 * ```text
 * ToolEffect[]  →  AgentState.changedFiles
 *              →  AgentState.activeProcesses
 * ```
 *
 * ## `changedFiles` is a bounded latest-change projection
 *
 * A changed path is removed from its old position and appended, so the newest change is last and a file
 * changed twice appears once. A move removes both the old and the new path before appending, so a move
 * cannot leave a phantom entry behind. The list is capped at `MAX_CHANGED_FILES` (500) from the tail,
 * which is why it is a *projection* and not a complete ledger.
 *
 * ## `activeProcesses` is updated only by process effects
 *
 * `PROCESS_STARTED` adds or replaces a session and `PROCESS_STOPPED` removes it. Nothing else touches
 * the list, and — importantly — an uncertain execution never fabricates a stop: the absence of a
 * `PROCESS_STOPPED` effect is exactly how a process whose fate is unknown stays visible to a reader.
 *
 * ## The safe label
 *
 * A process summary stores `SAFE_SHELL_COMMAND_LABEL` and never the command. `AgentState` is durable
 * state that a UI renders and an event payload may echo, while the raw command and any stdin are
 * private invocation arguments. Keeping the label fixed is what stops a shell command from reaching a
 * user-visible surface through the state projection.
 *
 * ## Where atomicity comes from
 *
 * This function is pure: it returns a new state and writes nothing. The caller hands the result to the
 * same single Tool execution commit that carries the terminal invocation, the observation, the events
 * and the budget settlement, so a state projection can never land separately from the fact it describes.
 */
export function applyToolEffectsToAgentState(
  state: AgentState,
  effects: readonly ToolEffect[],
  now: TimestampMs,
): AgentState {
  let changedFiles = [...state.changedFiles];
  let activeProcesses = [...state.activeProcesses];
  for (const effect of effects) {
    if (effect.type === "FILE_CHANGE") {
      const removed = new Set([effect.summary.path, effect.fromPath, effect.toPath]);
      changedFiles = changedFiles.filter((file) => !removed.has(file.path));
      changedFiles.push(effect.summary);
    } else if (effect.type === "PROCESS_STARTED") {
      activeProcesses = activeProcesses.filter((entry) => entry.id !== effect.sessionId);
      activeProcesses.push({
        id: effect.sessionId,
        command: SAFE_SHELL_COMMAND_LABEL,
        status: "RUNNING",
      });
    } else if (effect.type === "PROCESS_STOPPED") {
      activeProcesses = activeProcesses.filter((entry) => entry.id !== effect.sessionId);
    }
  }
  return {
    ...state,
    changedFiles: changedFiles.slice(-MAX_CHANGED_FILES),
    activeProcesses,
    updatedAt: now,
  };
}
