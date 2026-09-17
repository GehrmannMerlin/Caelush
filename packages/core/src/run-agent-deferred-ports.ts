import {
  RunExecutionInvariantError,
  type CompletionGate,
  type ToolTurnCoordinator,
} from "@caelush/agent";

/**
 * The misrouted Run execution driver ports.
 *
 * ```text
 * ADVANCE_AGENT        real, Phase 3C — createRunAgentLoop over the frozen kernel
 * EXECUTE_TOOL_BATCH   real, Phase 3D — the run-scoped adapter in run-tool-turn-coordinator.ts
 * EVALUATE_COMPLETION  real, Phase 3E — the run-scoped coding gate in run-completion-gate.ts
 * ```
 *
 * All three effects are real, and each is driven by an effect-specific composition that binds its own
 * port for real and **misroute guards** for the other two. A guard exists because the frozen
 * `RunExecutionDriver` requires all three collaborators: an Agent driver has to be given *a* Tool
 * coordinator and *a* completion gate even though the Agent path never hands it those directives.
 *
 * A guard fails closed rather than approximating work. A placeholder that silently did nothing would
 * be far worse than a throw: it would let a Run Layer believe work had happened. There is no deferred
 * production port left anywhere, and the guards are proven to be called zero times in the production
 * end-to-end tests.
 */

/**
 * The refusal an *Agent* driver answers a Tool directive with.
 *
 * The Agent path never receives an `EXECUTE_TOOL_BATCH` directive: the Run Layer's own Tool turn
 * drives those, through the real run-scoped adapter. This port exists only because the frozen
 * driver contract requires one, and it fails closed rather than becoming a second execution path.
 */
export const MISROUTED_TOOL_TURN_COORDINATOR: ToolTurnCoordinator = {
  async execute(): Promise<never> {
    throw new RunExecutionInvariantError(
      "A Tool directive reached the Agent driver; the Run Layer owns Tool execution.",
    );
  },
};

/**
 * The refusal the *Agent* and *Tool* drivers answer a completion directive with.
 *
 * A real `CompletionGate` exists and is what the Run Layer drives, so a completion directive arriving
 * at an Agent or Tool driver means the wrong effect path was taken — and evaluating completion from
 * there would be a second completion authority, and potentially a `run.completed` no verification
 * produced.
 */
export const MISROUTED_COMPLETION_GATE: CompletionGate = {
  id: "misrouted-completion-gate",
  async evaluate(): Promise<never> {
    throw new RunExecutionInvariantError(
      "A completion directive reached a non-completion driver; the Run Layer owns completion evaluation.",
    );
  },
};
